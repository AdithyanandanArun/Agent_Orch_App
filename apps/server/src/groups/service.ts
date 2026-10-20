import { createHash } from 'node:crypto';
import type {
  AddGroupAgent, AgentConfiguration, ConversationGroup, CreateGroup, GroupAssignment, GroupDelivery, GroupMember, GroupMessage, GroupMode,
  GroupRunContext, GroupSnapshot, ProviderInfo, Session, Task, TeamArtifactSchema, TeamAssignSchema, TeamMessageSchema, TeamStatusSchema, UpdateGroupSchema,
} from '@relay/contracts';
import type { z } from 'zod';
import { unfinishedDeps } from '../dag.ts';
import type { HandoffService } from '../handoffs.ts';
import { resolveRunConfig } from '../session-config.ts';
import type { Store } from '../store.ts';
import type { TaskService } from '../tasks.ts';
import { HttpError, conflict, errorMessage, notFound, nowIso, redactSecrets, truncate, unprocessable } from '../util.ts';
import type { WorkspaceService } from '../workspace.ts';
import {
  GroupRepo, OPEN_DELIVERY, UNSETTLED_DELIVERY, artifactId, assignmentId, deliveryId, groupId as newGroupId, memberId as newMemberId, requestId as newRequestId,
  type ArtifactRow, type AssignmentRow, type DeliveryRow, type MemberRow,
} from './repo.ts';
import {
  LIMITS, MODE_LABEL, assignmentText, buildInstructions, clean, messageDeliveryText, requestDeliveryText, resultText, type ResultLine, type RosterEntry,
} from './prompt.ts';
import { RESERVED_HANDLES, extractMentions, normalizeScopes, safeArtifactPath, scopesOverlap } from './routing.ts';

/** Matches the server's Logger; a plain (message) => void function is also accepted. */
export type GroupLog = (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
export interface GroupRuntime {
  isActive(sessionId: string): boolean;
  isRunLive?(sessionId: string, runId: string): boolean;
  start(sessionId: string, content: string, options?: { taskId?: string; groupDeliveryId?: string; userMessage?: { content: string; kind?: string } }): string;
  interrupt(sessionId: string): boolean;
}
export interface GroupServiceOptions {
  store: Store; workspace: WorkspaceService; tasks: TaskService; handoffs: HandoffService; runtime: GroupRuntime; log: GroupLog;
  providers?: () => ProviderInfo[];
}

type Outcome = 'completed' | 'failed' | 'interrupted';
type Assign = z.infer<typeof TeamAssignSchema>;
type TeamMessage = z.infer<typeof TeamMessageSchema>;
type TeamArtifact = z.infer<typeof TeamArtifactSchema>;
type TeamStatus = z.infer<typeof TeamStatusSchema>;
type Update = z.infer<typeof UpdateGroupSchema>;
interface Live { delivery: DeliveryRow; group: ConversationGroup; member: MemberRow; session: Session; request: ReturnType<GroupRepo['getRequest']> & object }

const MAX_MEMBERS = 8;
const MAX_MESSAGES_PER_RUN = 12;
const MAX_ASSIGNMENTS_PER_RUN = 10;
const SNAPSHOT_MESSAGES = 500;
const SNAPSHOT_DELIVERIES = 300;
const SNAPSHOT_REQUESTS = 100;
const FULL_SHA = /^[0-9a-f]{40,64}$/i;
const DEFAULT_LIMITS = { maxParallel: 2, maxTurns: 16, maxHops: 6 };
const forbidden = (message: string) => new HttpError(403, message);

export class GroupService {
  private readonly store: Store;
  private readonly repo: GroupRepo;
  private readonly workspace: WorkspaceService;
  private readonly tasks: TaskService;
  private readonly handoffs: HandoffService;
  private readonly runtime: GroupRuntime;
  private readonly log: GroupLog;
  private readonly providers?: () => ProviderInfo[];
  private closed = false;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<string>();
  private scheduled = false;
  private readonly unsubscribe: () => void;
  /** Deliveries whose runtime.start call is in flight, keyed by session. Closed by the same synchronous turn. */
  private readonly reserved = new Map<string, string>();

  constructor(options: GroupServiceOptions) {
    this.store = options.store;
    this.repo = new GroupRepo(options.store.db);
    this.workspace = options.workspace;
    this.tasks = options.tasks;
    this.handoffs = options.handoffs;
    this.runtime = options.runtime;
    this.log = options.log;
    this.providers = options.providers;
    this.unsubscribe = this.store.subscribe((event) => {
      if (event?.type.startsWith('task.')) {
        for (const group of this.repo.listGroups()) if (group.projectId === event.projectId) this.schedule(group.id);
      }
    });
  }

  // ---------------------------------------------------------------- snapshots

  snapshots(): GroupSnapshot[] { return this.repo.listGroups().map((group) => this.snapshot(group)); }

  get(id: string): GroupSnapshot { return this.snapshot(this.requireGroup(id)); }

  forSession(sessionId: string): GroupSnapshot | undefined {
    const member = this.repo.activeMemberOfSession(sessionId);
    const group = member ? this.repo.getGroup(member.groupId) : undefined;
    return group ? this.snapshot(group) : undefined;
  }

  private snapshot(group: ConversationGroup): GroupSnapshot {
    const members: GroupMember[] = this.repo.members(group.id).map((m) => ({ id: m.id, groupId: m.groupId, sessionId: m.sessionId, handle: m.handle, role: m.role, held: m.held, joinedAt: m.joinedAt, removedAt: m.removedAt }));
    const rows = [...new Map([...this.repo.recentDeliveries(group.id, SNAPSHOT_DELIVERIES), ...this.repo.deliveries(group.id).filter((d) => OPEN_DELIVERY.includes(d.status) || d.retryable)].map((d) => [d.id, d])).values()];
    const deliveries: GroupDelivery[] = rows.map((d) => ({
      id: d.id, groupId: d.groupId, requestId: d.requestId, messageId: d.messageId, memberId: d.memberId, status: d.status, runId: d.runId, hop: d.hop,
      error: d.error, createdAt: d.createdAt, updatedAt: d.updatedAt,
    }));
    const requests = [...new Map([...this.repo.requests(group.id, SNAPSHOT_REQUESTS), ...rows.map((d) => this.repo.getRequest(d.requestId)).filter((r): r is NonNullable<typeof r> => Boolean(r))].map((r) => [r.id, r])).values()];
    const messages = [...new Map([...this.repo.recentMessages(group.id, SNAPSHOT_MESSAGES), ...[...rows.map((d) => d.messageId), ...requests.map((r) => r.messageId)].map((id) => this.repo.getMessage(id)).filter((m): m is GroupMessage => Boolean(m))].map((m) => [m.id, m])).values()].sort((a, b) => a.seq - b.seq);
    const assignments: GroupAssignment[] = this.repo.assignments(group.id).map((a) => ({
      id: a.id, groupId: a.groupId, requestId: a.requestId, fromMemberId: a.fromMemberId, toMemberId: a.toMemberId, taskId: a.taskId, deliveryId: a.deliveryId, scope: a.scope, createdAt: a.createdAt,
    }));
    return { group, members, messages, requests, deliveries, assignments };
  }

  // ---------------------------------------------------------------- lifecycle

  /** Serialises structural changes (create/add) so two requests can never claim one session or handle. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  async create(input: CreateGroup): Promise<GroupSnapshot> {
    return this.exclusive(async () => {
      this.assertOpen();
      const original = this.requireJoinable(input.sessionId);
      const settings = this.store.getSettings();
      const defaults = { ...DEFAULT_LIMITS, ...settings.groupDefaults };
      if (input.mode !== 'orchestrated' && (input.orchestrator || input.currentConfiguration)) {
        throw unprocessable('A separate orchestrator and a current-agent configuration change apply only to Orchestrated groups');
      }
      const coordinatorConfig = input.mode === 'orchestrated' ? input.orchestrator ?? settings.groupDefaults?.orchestrator : undefined;
      if (input.mode === 'orchestrated' && !coordinatorConfig) throw unprocessable('Choose an orchestrator, or save a default orchestrator in Settings → Agents & orchestration');
      this.checkConfiguration(input.agent.configuration);
      if (coordinatorConfig) this.checkConfiguration(coordinatorConfig);

      // Reviewed configuration for the existing agent is validated now and applied last, never changing its provider.
      let configPatch: Record<string, string> = {};
      if (input.currentConfiguration) {
        const wanted = input.currentConfiguration;
        const info = this.providers?.().find((row) => row.id === original.provider);
        this.checkModel(info, wanted.model, original.provider);
        const resolved = resolveRunConfig(info, { provider: original.provider, ...wanted }, { effort: true, policy: true, serviceTier: true });
        configPatch = Object.fromEntries(Object.entries({ model: wanted.model, effort: resolved.effort, policy: resolved.policy, serviceTier: resolved.serviceTier })
          .filter(([key, value]) => original[key as keyof Session] !== value));
      }

      const newHandle = this.validateHandle(input.agent.handle);
      const originalHandle = `${original.provider}1`;
      if (newHandle === originalHandle) throw conflict(`Handle @${newHandle} is reserved for the current agent in this group. Choose another handle.`);
      const taken = new Set([originalHandle, newHandle]);
      let coordinatorHandle: string | null = null;
      if (coordinatorConfig) {
        for (let n = 1; !coordinatorHandle; n++) if (!taken.has(`${coordinatorConfig.provider}${n}`)) coordinatorHandle = `${coordinatorConfig.provider}${n}`;
      }

      const created: Session[] = [];
      try {
        const worker = await this.provision(original.projectId, newHandle, input.agent.configuration, input.agent.isolated);
        created.push(worker);
        const coordinator = coordinatorConfig && coordinatorHandle ? await this.provision(original.projectId, coordinatorHandle, coordinatorConfig, input.agent.isolated) : undefined;
        if (coordinator) created.push(coordinator);

        // Everything may have changed during worktree creation; check again right before persisting.
        this.assertOpen();
        const fresh = this.requireJoinable(original.id);
        if (fresh.projectId !== worker.projectId) throw unprocessable('Agents must belong to the same project');
        const id = newGroupId();
        const members = { original: newMemberId(), worker: newMemberId(), coordinator: coordinator ? newMemberId() : undefined };
        const peer = input.mode === 'cowork';
        this.store.tx(() => {
          this.repo.insertGroup({ id, projectId: original.projectId, title: original.name, anchorSessionId: original.id, mode: input.mode, ...defaults });
          const originalRole = input.mode === 'current-leads' ? 'orchestrator' : peer ? 'peer' : 'worker';
          this.repo.insertMember({ id: members.original, groupId: id, sessionId: original.id, handle: originalHandle, role: originalRole });
          this.repo.insertMember({ id: members.worker, groupId: id, sessionId: worker.id, handle: newHandle, role: peer ? 'peer' : 'worker' });
          if (coordinator && coordinatorHandle && members.coordinator) this.repo.insertMember({ id: members.coordinator, groupId: id, sessionId: coordinator.id, handle: coordinatorHandle, role: 'orchestrator' });
          const orchestrator = input.mode === 'current-leads' ? members.original : members.coordinator;
          if (orchestrator) this.repo.updateGroup(id, { orchestratorMemberId: orchestrator });
          if (Object.keys(configPatch).length) this.workspace.updateSession(original.id, configPatch);
          this.event(this.repo.getGroup(id)!, 'group.created', `Group created: ${original.name} (${MODE_LABEL[input.mode]})`, { mode: input.mode, members: [originalHandle, newHandle, ...(coordinatorHandle ? [coordinatorHandle] : [])] }, original.id);
        });
        return this.get(id);
      } catch (error) {
        await this.rollbackSessions(created);
        throw error;
      }
    });
  }

  async addAgent(groupId: string, input: AddGroupAgent): Promise<GroupSnapshot> {
    return this.exclusive(async () => {
      this.assertOpen();
      const group = this.requireGroup(groupId);
      this.checkConfiguration(input.configuration);
      const handle = this.validateHandle(input.handle);
      this.assertHandleFree(group.id, handle);
      this.assertCanChangeRoster(group);
      if (this.repo.members(group.id, false).length >= MAX_MEMBERS) throw conflict(`A group supports at most ${MAX_MEMBERS} agents`);
      const created: Session[] = [];
      try {
        const session = await this.provision(group.projectId, handle, input.configuration, input.isolated);
        created.push(session);
        this.assertOpen();
        const fresh = this.requireGroup(groupId);
        this.assertHandleFree(fresh.id, handle);
        this.assertCanChangeRoster(fresh);
        if (session.projectId !== fresh.projectId) throw unprocessable('Agents must belong to the group project');
        const role = fresh.mode === 'cowork' ? 'peer' : 'worker';
        this.store.tx(() => {
          this.repo.insertMember({ id: newMemberId(), groupId, sessionId: session.id, handle, role });
          this.repo.touchGroup(groupId);
          this.event(fresh, 'group.member.added', `Agent added: @${handle}`, { handle, role }, session.id);
        });
        return this.get(groupId);
      } catch (error) {
        await this.rollbackSessions(created);
        throw error;
      }
    });
  }

  update(groupId: string, patch: Update): GroupSnapshot {
    this.assertOpen();
    const group = this.requireGroup(groupId);
    const members = this.repo.members(group.id, false);
    const structural = patch.mode !== undefined || patch.orchestratorMemberId !== undefined;
    const limits = (['maxParallel', 'maxTurns', 'maxHops'] as const).filter((key) => patch[key] !== undefined && patch[key] !== group[key]);
    const running = this.repo.deliveries(group.id, ['running']);
    if (running.length) throw conflict('Wait for running agents to finish, or stop the group, before changing it');
    const unsettled = this.repo.deliveries(group.id, ['queued', 'failed', 'interrupted']).filter((d) => d.status === 'queued' || d.retryable);

    let mode: GroupMode = patch.mode ?? group.mode;
    let orchestrator: string | null = group.orchestratorMemberId;
    let changedRoles = false;
    if (structural) {
      for (const member of members) if (this.memberBusy(member)) throw conflict(`@${member.handle} is busy. Wait for it to finish before changing the group.`);
      const requested = patch.orchestratorMemberId ? members.find((m) => m.id === patch.orchestratorMemberId) : undefined;
      if (patch.orchestratorMemberId && !requested) throw unprocessable('The orchestrator must be an active member of this group');
      const anchor = members.find((m) => m.sessionId === group.anchorSessionId);
      if (mode === 'cowork') {
        if (patch.orchestratorMemberId) throw unprocessable('Cowork has no orchestrator');
        orchestrator = null;
      } else if (mode === 'current-leads') {
        if (!anchor) throw conflict('The original agent is no longer in this group');
        if (requested && requested.id !== anchor.id) throw unprocessable('In Current agent leads the original agent is the orchestrator');
        orchestrator = anchor.id;
      } else {
        // Orchestrated never creates a provider session implicitly: an existing selection or the previous coordinator is required.
        orchestrator = requested?.id ?? group.orchestratorMemberId;
        if (orchestrator === anchor?.id) throw unprocessable('Orchestrated uses a separate coordinator. Choose another member, or use Current agent leads.');
        if (!orchestrator || !members.some((m) => m.id === orchestrator)) throw unprocessable('Choose an existing member as the orchestrator');
      }
      changedRoles = mode !== group.mode || orchestrator !== group.orchestratorMemberId;
      if (changedRoles && unsettled.length) throw conflict('Queued or retryable work exists. Stop each affected agent to cancel its pending work before changing how agents coordinate.');
    }
    if (limits.length && !group.paused && unsettled.length) throw conflict('Stop the group before changing limits while work is queued');

    this.store.tx(() => {
      if (changedRoles) {
        // Held deliveries belong to the old structure; they are cancelled visibly rather than silently retargeted.
        for (const d of unsettled) this.repo.setDelivery(d.id, { status: 'cancelled', error: 'Cancelled by a group mode change', retryable: false });
        for (const id of new Set(unsettled.map((d) => d.requestId))) this.refreshRequest(id);
        for (const member of members) {
          const role: GroupMember['role'] = mode === 'cowork' ? 'peer' : member.id === orchestrator ? 'orchestrator' : 'worker';
          if (role !== member.role) this.repo.updateMember(member.id, { role });
        }
        this.repo.updateGroup(group.id, { mode, orchestratorMemberId: orchestrator });
        this.event(group, 'group.mode.changed', `Group mode: ${MODE_LABEL[group.mode]} → ${MODE_LABEL[mode]}`, { from: group.mode, to: mode, orchestratorMemberId: orchestrator, cancelled: unsettled.length });
      }
      if (limits.length) {
        this.repo.updateGroup(group.id, { maxParallel: patch.maxParallel, maxTurns: patch.maxTurns, maxHops: patch.maxHops });
        this.event(group, 'group.limits.changed', 'Group coordination limits updated', Object.fromEntries(limits.map((key) => [key, patch[key]])));
      }
    });
    mode = this.requireGroup(group.id).mode;
    if (limits.includes('maxParallel')) this.schedule(group.id);
    return this.get(group.id);
  }

  removeMember(groupId: string, memberIdArg: string): GroupSnapshot {
    this.assertOpen();
    const group = this.requireGroup(groupId);
    const member = this.requireMember(group, memberIdArg);
    const active = this.repo.members(group.id, false);
    if (member.sessionId === group.anchorSessionId) throw conflict('The original conversation is the group entry. Remove other agents instead.');
    if (group.orchestratorMemberId === member.id) throw conflict('Choose another orchestrator before removing this agent');
    if (active.length <= 2) throw conflict('A group needs at least two agents');
    if (this.memberBusy(member) || this.repo.memberDeliveries(member.id, ['running']).length) throw conflict(`@${member.handle} is busy. Wait for it to finish or stop it first.`);
    if ([...this.repo.requestsWithStatus(group.id, 'active'), ...this.repo.requestsWithStatus(group.id, 'paused')].some((r) => r.plannerMemberId === member.id && this.repo.requestDeliveries(r.id, OPEN_DELIVERY).length > 0)) throw conflict('This agent holds a live request planning lease');
    const owed = this.repo.activeAssignments(group.id).filter((a) => a.toMemberId === member.id && !(member.held && ['failed', 'interrupted'].includes(this.repo.getDelivery(a.deliveryId)?.status ?? '')));
    if (owed.length) throw conflict(`@${member.handle} still owns ${owed.length} unfinished assignment(s). Wait for them to settle first.`);
    this.store.tx(() => {
      const open = this.repo.memberDeliveries(member.id, ['queued', 'failed', 'interrupted']);
      for (const d of open) this.repo.setDelivery(d.id, { status: 'cancelled', error: 'Member removed from the group', retryable: false });
      for (const id of new Set(open.map((d) => d.requestId))) this.refreshRequest(id);
      this.repo.updateMember(member.id, { removedAt: nowIso(), held: false });
      this.repo.touchGroup(group.id);
      this.event(group, 'group.member.removed', `Agent removed: @${member.handle}`, { memberId: member.id, handle: member.handle, cancelled: open.length }, member.sessionId);
    });
    this.schedule(group.id);
    return this.get(group.id);
  }

  // ---------------------------------------------------------------- user messages

  send(groupId: string, input: { content: string; recipients?: string[]; clientMessageId?: string }): GroupSnapshot {
    this.assertOpen();
    const group = this.requireGroup(groupId);
    if (input.clientMessageId && this.repo.messageByClientId(group.id, input.clientMessageId)) return this.snapshot(group);
    const members = this.repo.members(group.id, false);
    const content = clean(input.content, 100_000);
    const route = this.route(group, members, input.recipients, content);
    for (const member of route.recipients) if (!this.store.getSession(member.sessionId)) throw conflict(`@${member.handle} is archived. Remove it from the group first.`);
    this.store.tx(() => {
      const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: route.recipients.map((m) => m.id), kind: 'user', content, clientMessageId: input.clientMessageId ?? null });
      const requestId = newRequestId();
      this.repo.insertRequest({ id: requestId, groupId: group.id, messageId: message.id, plannerMemberId: route.planner.id });
      this.repo.updateMember(route.planner.id, {});
      for (const member of route.runners) this.repo.insertDelivery({ id: deliveryId(), groupId: group.id, requestId, messageId: message.id, memberId: member.id, kind: 'request', hop: 0 });
      this.repo.touchGroup(group.id);
      this.event(group, 'group.message.sent', group.paused ? 'Group message queued (group is paused)' : 'Group message sent', {
        messageId: message.id, requestId, recipients: route.recipients.map((m) => m.handle), runners: route.runners.map((m) => m.handle), paused: group.paused,
      });
    });
    this.schedule(group.id);
    return this.get(group.id);
  }

  /** Explicit human task run preserves the existing task and follows the durable group queue. */
  runTask(taskId: string): GroupSnapshot {
    this.assertOpen();
    const task = this.tasks.assertRunnable(taskId);
    const member = this.repo.activeMemberOfSession(task.sessionId!);
    if (!member) throw conflict('This task is not assigned to an agent in a group');
    const group = this.requireGroup(member.groupId);
    if (task.projectId !== group.projectId) throw unprocessable('Task belongs to a different project');
    if (this.repo.deliveries(group.id, OPEN_DELIVERY).some((d) => d.taskId === task.id)) return this.get(group.id);
    const content = clean(this.tasks.buildPrompt(task), 100_000);
    this.store.tx(() => {
      const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [member.id], kind: 'user', content });
      const requestId = newRequestId();
      this.repo.insertRequest({ id: requestId, groupId: group.id, messageId: message.id, plannerMemberId: member.id });
      this.repo.insertDelivery({ id: deliveryId(), groupId: group.id, requestId, messageId: message.id, memberId: member.id, kind: 'request', hop: 0, taskId: task.id });
      this.repo.touchGroup(group.id);
      this.event(group, 'group.task.queued', `Task queued for @${member.handle}: ${task.title}`, { taskId: task.id, requestId }, member.sessionId);
    });
    this.schedule(group.id);
    return this.get(group.id);
  }

  private route(group: ConversationGroup, members: MemberRow[], explicit: string[] | undefined, content: string): { recipients: MemberRow[]; runners: MemberRow[]; planner: MemberRow } {
    if (!members.length) throw conflict('This group has no active agents');
    const byId = new Map(members.map((m) => [m.id, m]));
    const retired = new Set(this.repo.members(group.id).filter((m) => m.removedAt).flatMap((m) => [m.id, m.handle]));
    const resolveOne = (reference: string, label: string): MemberRow => {
      const direct = byId.get(reference) ?? members.find((m) => m.handle === reference.toLowerCase());
      if (direct) return direct;
      if (retired.has(reference) || retired.has(reference.toLowerCase())) throw unprocessable(`${label} was removed from this group`);
      const providerMatches = members.filter((m) => this.store.getSession(m.sessionId)?.provider === reference.toLowerCase());
      if (['codex', 'claude'].includes(reference.toLowerCase())) {
        if (providerMatches.length === 1) return providerMatches[0]!;
        throw unprocessable(providerMatches.length ? `${label} matches several agents; use a specific handle such as @${providerMatches[0]!.handle}` : `No active agent matches ${label}`);
      }
      throw unprocessable(`Unknown recipient ${label}. Active agents: ${members.map((m) => `@${m.handle}`).join(', ')}`);
    };
    let recipients: MemberRow[];
    let directed = true;
    if (explicit?.length) recipients = explicit.map((id) => resolveOne(id, id));
    else {
      const mentions = extractMentions(content);
      if (mentions.length) recipients = mentions.map((handle) => resolveOne(handle, `@${handle}`));
      else {
        directed = false;
        if (group.mode === 'cowork') recipients = members;
        else {
          const lead = members.find((m) => m.id === group.orchestratorMemberId);
          if (!lead) throw conflict('This group has no active orchestrator');
          recipients = [lead];
        }
      }
    }
    recipients = [...new Map(recipients.map((m) => [m.id, m])).values()];
    if (directed) return { recipients, runners: recipients, planner: group.mode === 'cowork' ? recipients[0]! : members.find((m) => m.id === group.orchestratorMemberId) ?? recipients[0]! };
    if (group.mode === 'cowork') {
      // Every peer receives the request, but only the original agent plans; the others wait for a scoped assignment.
      const planner = members.find((m) => m.sessionId === group.anchorSessionId) ?? members[0]!;
      return { recipients, runners: [planner], planner };
    }
    return { recipients, runners: recipients, planner: recipients[0]! };
  }

  // ---------------------------------------------------------------- stop / resume / recovery

  /** Pauses automatic scheduling; existing provider runs can finish, but cannot mutate team state while paused. */
  pause(groupId: string): GroupSnapshot {
    this.assertOpen();
    const group = this.requireGroup(groupId);
    this.store.tx(() => {
      this.repo.updateGroup(group.id, { paused: true, pauseReason: 'Paused by the user. Resume to continue queued work.' });
      for (const request of this.repo.requestsWithStatus(group.id, 'active')) this.refreshRequest(request.id, true);
      this.event(group, 'group.paused', 'Group scheduling paused');
    });
    return this.get(group.id);
  }

  /** Persists the queue hold before interrupting every active native member. */
  stop(groupId: string): GroupSnapshot {
    this.pause(groupId);
    const group = this.requireGroup(groupId);
    this.repo.updateGroup(group.id, { paused: true, pauseReason: 'Stopped by the user. Resume to continue queued work.' });
    const running = this.repo.deliveries(group.id, ['running']);
    this.event(group, 'group.stopped', 'Group stopped', { interrupting: running.map((d) => d.memberId) });
    for (const delivery of running) this.interruptMember(delivery.memberId);
    return this.get(group.id);
  }

  /** Explicit resume: clears holds and requeues retryable interrupted or failed deliveries with a fresh run. */
  resume(groupId: string): GroupSnapshot {
    this.assertOpen();
    const group = this.requireGroup(groupId);
    this.store.tx(() => {
      this.repo.updateGroup(group.id, { paused: false, pauseReason: null });
      this.repo.clearHolds(group.id);
      const members = new Set(this.repo.members(group.id, false).map((m) => m.id));
      let requeued = 0;
      for (const d of this.repo.deliveries(group.id, ['failed', 'interrupted'])) {
        if (!d.retryable) continue;
        if (!members.has(d.memberId)) { this.repo.setDelivery(d.id, { status: 'cancelled', error: 'Member removed from the group', retryable: false }); continue; }
        if (this.repo.transitionDelivery(d.id, d.status, 'queued', { runId: null, error: null, retryable: false })) requeued++;
      }
      for (const request of this.repo.requests(group.id, 1000)) if (request.status !== 'completed') this.refreshRequest(request.id);
      this.event(group, 'group.resumed', 'Group resumed', { requeued });
    });
    this.schedule(group.id);
    return this.get(group.id);
  }

  stopMember(groupId: string, memberIdArg: string): GroupSnapshot {
    this.assertOpen();
    const group = this.requireGroup(groupId);
    const member = this.requireMember(group, memberIdArg);
    this.store.tx(() => {
      // Stop cancels pending deliveries for this member and retains a durable hold until explicit resume.
      this.repo.updateMember(member.id, { held: true });
      const pending = this.repo.memberDeliveries(member.id, ['queued', 'failed', 'interrupted']);
      for (const d of pending) this.repo.setDelivery(d.id, { status: 'cancelled', retryable: false, error: 'Cancelled when this agent was stopped' });
      for (const requestId of new Set(pending.map((d) => d.requestId))) this.refreshRequest(requestId);
      this.event(group, 'group.member.stopped', `Agent stopped: @${member.handle}`, { memberId: member.id }, member.sessionId);
    });
    this.interruptMember(member.id);
    return this.get(group.id);
  }

  resumeMember(groupId: string, memberIdArg: string): GroupSnapshot {
    this.assertOpen();
    const group = this.requireGroup(groupId);
    const member = this.requireMember(group, memberIdArg);
    if (this.memberBusy(member)) throw conflict('Wait for this agent to finish cleanup before resuming');
    this.store.tx(() => {
      this.repo.updateMember(member.id, { held: false });
      for (const d of this.repo.memberDeliveries(member.id, ['failed', 'interrupted'])) {
        if (!d.retryable) continue;
        this.repo.setDelivery(d.id, { status: 'queued', runId: null, error: null, retryable: false });
        this.refreshRequest(d.requestId);
      }
      this.event(group, 'group.member.resumed', `Agent resumed: @${member.handle}`, { memberId: member.id }, member.sessionId);
    });
    this.schedule(group.id);
    return this.get(group.id);
  }

  private interruptMember(memberIdArg: string): void {
    const member = this.repo.getMember(memberIdArg);
    if (!member || !this.repo.memberDeliveries(member.id, ['running']).length) return;
    try { this.runtime.interrupt(member.sessionId); }
    catch (error) { this.log('warn', `Could not interrupt ${member.sessionId}`, error); }
  }

  /** Startup recovery. Marks unfinished work interrupted and pauses; never starts a model run. */
  recover(): void {
    for (const group of this.repo.listGroups()) {
      try {
        this.store.tx(() => {
          let touched = 0;
          for (const d of this.repo.deliveries(group.id, ['running'])) {
            this.repo.transitionDelivery(d.id, 'running', 'interrupted', { error: 'Interrupted because Relay restarted', retryable: true });
            const assignment = d.assignmentId ? this.repo.getAssignment(d.assignmentId) : undefined;
            if (assignment || d.taskId) this.tasks.finishRun(assignment?.taskId ?? d.taskId!, 'interrupted');
            touched++;
          }
          const waiting = this.repo.deliveries(group.id).filter((d) => d.status === 'queued' || ((d.status === 'failed' || d.status === 'interrupted') && d.retryable));
          if (waiting.length && !group.paused) {
            this.repo.updateGroup(group.id, { paused: true, pauseReason: 'Relay restarted with unfinished work. Resume to continue; nothing was restarted automatically.' });
          }
          if (waiting.length || touched) {
            for (const request of this.repo.requestsWithStatus(group.id, 'active')) this.refreshRequest(request.id, true);
            this.event(group, 'group.recovered', 'Group work paused after restart', { interrupted: touched, waiting: waiting.length });
          }
        });
      } catch (error) {
        this.log('error', `Group recovery failed for ${group.id}`, error);
      }
    }
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.pending.clear();
    this.reserved.clear();
  }

  // ---------------------------------------------------------------- runtime hooks

  contextForRun(sessionId: string, runId: string): GroupRunContext | undefined {
    if (this.closed) return undefined;
    const delivery = this.repo.deliveryByRun(runId) ?? this.reservedDelivery(sessionId, runId);
    if (!delivery || delivery.status !== 'running') return undefined;
    const member = this.repo.getMember(delivery.memberId);
    const group = this.repo.getGroup(delivery.groupId);
    const request = this.repo.getRequest(delivery.requestId);
    if (!member || member.removedAt || member.sessionId !== sessionId || !group || !request || group.paused || member.held) return undefined;
    const assignment = delivery.assignmentId ? this.repo.getAssignment(delivery.assignmentId) : undefined;
    const roster = this.roster(group, member);
    const lease = group.mode === 'cowork' ? this.repo.getMember(request.plannerMemberId)?.handle ?? null : null;
    const instructions = buildInstructions({
      title: group.title, mode: group.mode, self: roster.find((r) => r.you)!, roster, canAssign: this.mayAssign(group, member, request.plannerMemberId), leaseHolder: lease,
      requestExcerpt: this.repo.getMessage(request.messageId)?.content ?? '', deliveryKind: delivery.kind, hop: delivery.hop, maxHops: group.maxHops,
      turnsUsed: request.turnsUsed, maxTurns: group.maxTurns, unread: this.repo.countAddressedAfter(group.id, member.id, member.lastReadSeq),
      assignment: assignment ? { id: assignment.id, taskId: assignment.taskId, scope: assignment.scope } : null,
    });
    return { groupId: group.id, memberId: member.id, requestId: request.id, deliveryId: delivery.id, hop: delivery.hop, instructions };
  }

  /** Throws unless this run is the live delivery of this member's current session. */
  assertRunContext(ctx: GroupRunContext, runId: string, sessionId: string): void {
    const live = this.live(ctx);
    if (live.delivery.runId !== runId || live.member.sessionId !== sessionId) throw conflict('This team connection belongs to a different run');
  }

  onRunFinished(sessionId: string, runId: string, outcome: Outcome): void {
    if (this.closed) return;
    let delivery = this.repo.deliveryByRun(runId);
    if (!delivery) {
      const reservedId = this.reserved.get(sessionId);
      const candidate = reservedId ? this.repo.getDelivery(reservedId) : undefined;
      if (candidate?.status === 'running' && !candidate.runId) {
        this.repo.setDelivery(candidate.id, { runId });
        delivery = this.repo.getDelivery(candidate.id);
      }
    }
    if (!delivery || delivery.status !== 'running') return;
    this.settle(delivery, outcome);
  }

  /** Called after provider cleanup: reconcile any missed callback, then let the queue advance. */
  onRuntimeIdle(sessionId: string): void {
    if (this.closed) return;
    const member = this.repo.activeMemberOfSession(sessionId);
    if (!member) return;
    for (const delivery of this.repo.memberDeliveries(member.id, ['running'])) {
      if (this.reserved.get(sessionId) === delivery.id) continue;
      const run = delivery.runId ? this.store.getRun(delivery.runId) : undefined;
      if (!run || run.status !== 'running') this.settle(delivery, run?.status === 'completed' ? 'completed' : run?.status === 'failed' ? 'failed' : 'interrupted');
    }
    this.schedule(member.groupId);
  }

  private reservedDelivery(sessionId: string, runId: string): DeliveryRow | undefined {
    const reservedId = this.reserved.get(sessionId);
    const delivery = reservedId ? this.repo.getDelivery(reservedId) : undefined;
    if (!delivery || delivery.status !== 'running' || delivery.runId) return undefined;
    this.repo.setDelivery(delivery.id, { runId });
    return this.repo.getDelivery(delivery.id);
  }

  private settle(delivery: DeliveryRow, outcome: Outcome): void {
    const group = this.repo.getGroup(delivery.groupId);
    const member = this.repo.getMember(delivery.memberId);
    if (!group || !member) return;
    const session = this.store.getSession(member.sessionId, true);
    const failure = outcome === 'failed' ? clean(session?.error ?? 'The run failed', 500) : outcome === 'interrupted' ? 'The run was interrupted' : null;
    try {
      this.store.tx(() => {
        if (!this.repo.transitionDelivery(delivery.id, 'running', outcome, { error: failure, retryable: outcome !== 'completed' })) return;
        const assignment = delivery.assignmentId ? this.repo.getAssignment(delivery.assignmentId) : undefined;
        if (assignment || delivery.taskId) {
          const taskId = assignment?.taskId ?? delivery.taskId!;
          this.tasks.finishRun(taskId, outcome);
          const task = this.store.getTask(taskId);
          // An artifact-unblocked task that was not completed returns to blocked, not ready, while prerequisites are unfinished.
          if (task && task.status === 'ready' && unfinishedDeps(task.dependsOn, (dep) => this.store.getTask(dep)?.status).length) this.store.updateTask(task.id, { status: 'blocked' });
        }
        if (outcome === 'failed') {
          if (!group.paused) this.repo.updateGroup(group.id, { paused: true, pauseReason: `@${member.handle} failed: ${failure}. Resume to retry.` });
          this.event(group, 'group.delivery.failed', `Delivery failed: @${member.handle}`, { deliveryId: delivery.id, error: failure }, member.sessionId);
        } else if (outcome === 'interrupted') {
          // An interruption outside a group stop still holds the member so it is not restarted behind the user's back.
          if (!group.paused && !member.held) {
            this.repo.updateMember(member.id, { held: true });
            this.event(group, 'group.member.held', `Agent interrupted: @${member.handle} is on hold`, { memberId: member.id }, member.sessionId);
          }
        } else {
          this.event(group, 'group.delivery.completed', `Delivery completed: @${member.handle}`, { deliveryId: delivery.id, kind: delivery.kind }, member.sessionId);
        }
        this.refreshRequest(delivery.requestId, outcome !== 'completed');
        if (outcome === 'completed') this.notifyCoordinator(delivery.requestId);
      });
    } catch (error) {
      this.log('error', `Could not record group delivery outcome for ${delivery.id}`, error);
    }
    this.schedule(group.id);
  }

  // ---------------------------------------------------------------- queue

  private schedule(groupId: string): void {
    if (this.closed) return;
    this.pending.add(groupId);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const ids = [...this.pending];
      this.pending.clear();
      if (this.closed) return;
      for (const id of ids) this.pump(id);
    });
  }

  private pump(groupId: string): void {
    try {
      const group = this.repo.getGroup(groupId);
      if (!group || group.paused) return;
      const queued = this.repo.deliveries(groupId, ['queued']);
      if (!queued.length) return;
      // An interrupted delivery can still own a provider cleanup lock. It continues to consume a parallel slot.
      const activeProviders = this.repo.members(groupId, false).filter((member) => this.runtime.isActive(member.sessionId)).length;
      let capacity = group.maxParallel - Math.max(activeProviders, this.repo.deliveries(groupId, ['running']).length);
      if (capacity <= 0) return;
      const members = new Map(this.repo.members(groupId, false).map((m) => [m.id, m]));
      const lastStart = this.repo.lastStarts(groupId);
      const byMember = new Map<string, DeliveryRow[]>();
      for (const d of queued) byMember.set(d.memberId, [...(byMember.get(d.memberId) ?? []), d]);
      // Members that have waited longest since their last start go first, so no member starves under maxParallel.
      const order = [...byMember.keys()].sort((a, b) => (lastStart.get(a) ?? '').localeCompare(lastStart.get(b) ?? ''));
      for (const id of order) {
        if (capacity <= 0 || this.closed) break;
        const member = members.get(id);
        const list = byMember.get(id)!;
        if (!member) {
          for (const d of list) this.cancel(d, 'Member removed from the group');
          continue;
        }
        if (member.held) continue;
        const session = this.store.getSession(member.sessionId);
        if (!session) {
          for (const d of list) this.cancel(d, 'The member session is no longer available');
          continue;
        }
        if (this.sessionBusy(session)) continue;
        for (const d of list) {
          const verdict = this.readiness(group, member, d);
          if (verdict === 'defer') continue;
          if (verdict === 'cancel') continue;
          if (this.startDelivery(group, member, session, d)) capacity--;
          break;
        }
        if (this.repo.getGroup(groupId)?.paused) return;
      }
    } catch (error) {
      this.log('error', `Group queue failed for ${groupId}`, error);
      try {
        const group = this.repo.getGroup(groupId);
        if (group && !group.paused) {
          this.repo.updateGroup(groupId, { paused: true, pauseReason: `The queue stopped on an internal error: ${clean(errorMessage(error), 300)}` });
          this.event(group, 'group.queue.error', 'Group queue stopped on an internal error', { error: clean(errorMessage(error), 300) });
        }
      } catch { /* the error is already logged */ }
    }
  }

  private readiness(group: ConversationGroup, member: MemberRow, d: DeliveryRow): 'ready' | 'defer' | 'cancel' {
    if (d.taskId && d.kind !== 'assignment') {
      const task = this.store.getTask(d.taskId);
      if (!task || task.sessionId !== member.sessionId || task.status === 'done') { this.cancel(d, 'The task was removed, reassigned or already accepted'); return 'cancel'; }
      try { this.tasks.assertRunnable(task.id); } catch { return 'defer'; }
      return 'ready';
    }
    if (d.kind !== 'assignment') return 'ready';
    const assignment = d.assignmentId ? this.repo.getAssignment(d.assignmentId) : undefined;
    const task = assignment ? this.store.getTask(assignment.taskId) : undefined;
    if (!assignment || !task) { this.cancel(d, 'The assignment task no longer exists'); return 'cancel'; }
    if (task.sessionId !== member.sessionId || task.projectId !== group.projectId || assignment.toMemberId !== member.id) { this.cancel(d, 'The assignment task was reassigned or no longer belongs to this agent'); return 'cancel'; }
    if (task.status === 'done') { this.cancel(d, 'The task was already accepted as done'); return 'cancel'; }
    if (task.status === 'running' || task.status === 'backlog') return 'defer';
    return this.dependencyState(assignment, task).waiting.length ? 'defer' : 'ready';
  }

  /**
   * Legacy dependencies need Done. A dependency waiting in Review is satisfied only by an exact explicit input-artifact opt-in
   * (producer task, path) backed by a verified artifact published by that task's owner to this assignee. Never fakes Done.
   */
  private dependencyState(assignment: AssignmentRow, task: Task): { waiting: string[] } {
    const inputs = this.repo.inputs(assignment.id);
    const waiting: string[] = [];
    for (const dependencyId of task.dependsOn) {
      const dependency = this.store.getTask(dependencyId);
      if (!dependency) { waiting.push(dependencyId); continue; }
      if (dependency.status === 'done') continue;
      const wanted = inputs.filter((input) => input.taskId === dependencyId);
      if (!wanted.length || dependency.status !== 'review') { waiting.push(dependencyId); continue; }
      const satisfied = wanted.every((input) => this.verifiedArtifact(assignment, dependency, input.path, input.artifactId));
      if (!satisfied) waiting.push(dependencyId);
    }
    return { waiting };
  }

  private verifiedArtifact(assignment: AssignmentRow, producerTask: Task, path: string, linked: string | null): ArtifactRow | undefined {
    const candidates = [...(linked ? [this.repo.getArtifact(linked)] : []), ...this.repo.matchingArtifacts(assignment.groupId, assignment.toMemberId, producerTask.id, path)];
    return candidates.find((artifact): artifact is ArtifactRow => Boolean(artifact)
      && artifact!.toMemberId === assignment.toMemberId && artifact!.taskId === producerTask.id && artifact!.path === path
      && producerTask.sessionId !== null && this.repo.getMember(artifact!.fromMemberId)?.sessionId === producerTask.sessionId);
  }

  private startDelivery(group: ConversationGroup, member: MemberRow, session: Session, d: DeliveryRow): boolean {
    const request = this.repo.getRequest(d.requestId);
    if (!request) { this.cancel(d, 'The request no longer exists'); return false; }
    if (d.hop > group.maxHops) {
      this.holdBudget(group, request.id, `A queued delivery needs hop ${d.hop}, above the current ${group.maxHops} hop limit. Raise the hop limit and resume, or cancel the affected agent's pending work.`);
      return false;
    }
    if (request.turnsUsed >= group.maxTurns) {
      this.exhaustBudget(group, request.id);
      return false;
    }
    const assignment = d.assignmentId ? this.repo.getAssignment(d.assignmentId) : undefined;
    const text = this.deliveryText(group, member, d, request.plannerMemberId);
    const reserved = this.store.tx(() => {
      if (!this.repo.transitionDelivery(d.id, 'queued', 'running', { runId: null, startedAt: nowIso(), attemptsDelta: 1 })) return false;
      this.repo.updateRequest(request.id, { status: 'active', turnsDelta: 1 });
      return true;
    });
    if (!reserved) return false;
    this.reserved.set(session.id, d.id);
    let runId: string;
    try {
      runId = this.runtime.start(session.id, text, { groupDeliveryId: d.id, taskId: assignment?.taskId ?? d.taskId ?? undefined, userMessage: { content: text, kind: 'group-delivery' } });
    } catch (error) {
      this.reserved.delete(session.id);
      const message = clean(errorMessage(error), 500);
      this.store.tx(() => {
        const freshSession = this.store.getSession(session.id);
        if (error instanceof HttpError && error.status === 409 && (this.runtime.isActive(session.id) || freshSession?.status === 'running' || freshSession?.status === 'waiting')) {
          // The session became busy between the check and the start; wait for it instead of failing the delivery.
          this.repo.transitionDelivery(d.id, 'running', 'queued', { runId: null, attemptsDelta: -1 });
          this.repo.updateRequest(request.id, { turnsDelta: -1 });
          return;
        }
        this.repo.transitionDelivery(d.id, 'running', 'failed', { error: message, retryable: true, attemptsDelta: 0 });
        this.repo.updateRequest(request.id, { status: 'paused', turnsDelta: -1 });
        this.repo.updateGroup(group.id, { paused: true, pauseReason: `Could not start @${member.handle}: ${message}. Resume to retry.` });
        this.event(group, 'group.delivery.failed', `Could not start @${member.handle}`, { deliveryId: d.id, error: message }, session.id);
      });
      this.log('warn', `Group delivery ${d.id} could not start`, error);
      return false;
    }
    this.repo.setDelivery(d.id, { runId });
    this.reserved.delete(session.id);
    this.event(group, 'group.delivery.started', `Delivery started: @${member.handle}`, { deliveryId: d.id, runId, kind: d.kind, hop: d.hop }, session.id);
    return true;
  }

  private exhaustBudget(group: ConversationGroup, requestIdArg: string): void {
    this.holdBudget(group, requestIdArg, `A request used all ${group.maxTurns} allowed model turns. Pending work is retained. Raise the turn limit and resume, or cancel the affected agent's pending work and send a new request.`);
  }

  private holdBudget(group: ConversationGroup, requestIdArg: string, reason: string): void {
    this.store.tx(() => {
      this.repo.updateRequest(requestIdArg, { status: 'paused' });
      this.repo.updateGroup(group.id, { paused: true, pauseReason: reason });
      this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [], kind: 'status', content: reason, requestId: requestIdArg });
      this.event(group, 'group.budget.exhausted', 'Coordination budget reached; queued work is retained', { requestId: requestIdArg, maxTurns: group.maxTurns, maxHops: group.maxHops });
    });
  }

  private cancel(d: DeliveryRow, reason: string): void {
    this.store.tx(() => {
      if (!this.repo.transitionDelivery(d.id, d.status, 'cancelled', { error: reason, retryable: false })) return;
      this.refreshRequest(d.requestId);
      const group = this.repo.getGroup(d.groupId);
      if (group) this.event(group, 'group.delivery.cancelled', `Delivery cancelled: ${reason}`, { deliveryId: d.id, memberId: d.memberId });
    });
  }

  /** The text a delivery sends to its member; also stored as the native `group-delivery` user message. */
  private deliveryText(group: ConversationGroup, member: MemberRow, d: DeliveryRow, plannerId: string): string {
    const message = this.repo.getMessage(d.messageId);
    const content = message?.content ?? '';
    let text: string;
    if (d.kind === 'request') {
      const requestDeliveries = this.repo.requestDeliveries(d.requestId).filter((row) => row.kind === 'request');
      const broadcast = (message?.recipientMemberIds.length ?? 0) > 1 && requestDeliveries.length === 1;
      text = requestDeliveryText({ content, handle: member.handle, planner: broadcast && plannerId === member.id, mode: group.mode, directed: !broadcast });
      if (member.role === 'orchestrator' && group.mode === 'orchestrated') text += this.bootstrap(group, member, d);
    } else if (d.kind === 'message') {
      text = messageDeliveryText({ from: this.repo.getMember(message?.senderMemberId ?? '')?.handle ?? 'a teammate', content });
    } else text = content;
    if (d.attempts > 0) text = `Retry: your previous attempt at this delivery did not complete. Continue from your current workspace state rather than starting over.\n\n${text}`;
    return truncate(text, d.kind === 'request' ? 106_000 : LIMITS.message + 2000);
  }

  /** Bounded first-turn context for a freshly created orchestrator: references, never replayed transcripts. */
  private bootstrap(group: ConversationGroup, member: MemberRow, d: DeliveryRow): string {
    if (this.repo.memberDeliveries(member.id, ['completed', 'failed', 'interrupted', 'running']).some((row) => row.id !== d.id)) return '';
    const others = this.repo.members(group.id, false).filter((m) => m.id !== member.id);
    const lines = ['', 'Context for your first turn as orchestrator (a bounded reference, not a transcript):'];
    for (const other of others) {
      const session = this.store.getSession(other.sessionId);
      if (session) lines.push(`- @${other.handle} works in "${clean(session.name, 80)}" (${session.provider}/${session.model}); its native conversation remains in session ${session.id}.`);
    }
    const open = this.store.listTasks(group.projectId).filter((task) => task.status !== 'done').slice(-8);
    if (open.length) lines.push('Open project tasks:', ...open.map((task) => `- ${task.id} [${task.status}] ${clean(task.title, 100)}`));
    return lines.join('\n');
  }

  private roster(group: ConversationGroup, self: MemberRow): RosterEntry[] {
    const queued = new Map<string, number>();
    for (const d of this.repo.deliveries(group.id, ['queued'])) queued.set(d.memberId, (queued.get(d.memberId) ?? 0) + 1);
    return this.repo.members(group.id, false).map((m) => {
      const session = this.store.getSession(m.sessionId);
      const running = this.repo.memberDeliveries(m.id, ['running']).length > 0;
      const state = m.held ? 'stopped' : running ? 'running' : queued.get(m.id) ? `idle, ${queued.get(m.id)} queued` : session && this.sessionBusy(session) ? 'busy' : 'idle';
      return { handle: m.handle, role: m.role, provider: session?.provider ?? 'unknown', model: session?.model ?? 'unknown', state, you: m.id === self.id };
    });
  }

  // ---------------------------------------------------------------- coordinator result batches

  /** Once per finished delegation batch, hand the delegating coordinator one compact result delivery. */
  private notifyCoordinator(requestIdArg: string): void {
    const request = this.repo.getRequest(requestIdArg);
    const group = request ? this.repo.getGroup(request.groupId) : undefined;
    if (!request || !group) return;
    const assignments = this.repo.requestAssignments(request.id);
    const fresh = assignments.filter((a) => !a.notified);
    if (!fresh.length) return;
    const deliveries = new Map(assignments.map((a) => [a.id, this.repo.getDelivery(a.deliveryId)]));
    // The batch is complete only when nothing is queued, running or awaiting an explicit retry.
    if ([...deliveries.values()].some((d) => !d || UNSETTLED_DELIVERY.includes(d.status))) return;
    for (const delegator of new Set(fresh.map((a) => a.fromMemberId))) {
      const batch = fresh.filter((a) => a.fromMemberId === delegator);
      const target = this.repo.getMember(delegator);
      const hop = Math.max(...batch.map((a) => deliveries.get(a.id)!.hop)) + 1;
      this.repo.markNotified(batch.map((a) => a.id));
      if (!target || target.removedAt) continue;
      const committed = request.turnsUsed + this.repo.requestDeliveries(request.id, ['queued']).length;
      const blockedByBudget = hop > group.maxHops || committed >= group.maxTurns;
      const lines: ResultLine[] = batch.map((a) => {
        const d = deliveries.get(a.id)!;
        const worker = this.repo.getMember(a.toMemberId);
        const workerSession = worker ? this.store.getSession(worker.sessionId, true) : undefined;
        return {
          handle: worker?.handle ?? 'unknown', title: this.store.getTask(a.taskId)?.title ?? a.taskId, outcome: d.status,
          summary: d.status === 'completed' && workerSession ? this.finalResult(workerSession.id, d.runId) : d.error ?? '',
        };
      });
      const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: null, recipients: [delegator], kind: 'status', content: resultText(lines), requestId: request.id });
      this.repo.insertDelivery({ id: deliveryId(), groupId: group.id, requestId: request.id, messageId: message.id, memberId: delegator, kind: 'result', hop });
      this.repo.updateRequest(request.id, { status: 'active' });
      this.event(group, 'group.result.queued', 'Worker results queued for the coordinator', { requestId: request.id, workers: batch.length });
      if (blockedByBudget) this.holdBudget(group, request.id, 'Worker results are ready, but reviewing them needs another model turn or message hop. The result delivery is retained; raise the applicable group limit and resume, or address the coordinator in a new request.');
    }
  }

  /** Bounded excerpt of the member's final native assistant message for this run. */
  private finalResult(sessionId: string, runId: string | null): string {
    if (!runId) return '';
    const messages = this.store.listMessages(sessionId, { limit: 80 });
    for (let i = messages.length - 1; i >= 0; i--) {
      const row = messages[i]!;
      if (row.role === 'assistant' && row.runId === runId && row.content.trim()) return clean(row.content.trim(), LIMITS.summary);
    }
    return '';
  }

  /** Request status follows its deliveries. `hold` marks unfinished work as waiting for an explicit resume. */
  private refreshRequest(id: string, hold = false): void {
    const request = this.repo.getRequest(id);
    if (!request) return;
    const open = this.repo.requestDeliveries(id, OPEN_DELIVERY);
    const retry = this.repo.requestDeliveries(id, ['failed', 'interrupted']).some((d) => d.retryable);
    const group = this.repo.getGroup(request.groupId);
    const status = open.length || retry ? (hold || group?.paused || retry ? 'paused' : 'active') : 'completed';
    if (status !== request.status) this.repo.updateRequest(id, { status });
  }

  // ---------------------------------------------------------------- team tools

  members(ctx: GroupRunContext): unknown {
    const { group, member, request, delivery } = this.live(ctx);
    return {
      you: member.handle, role: member.role, mode: group.mode, canAssign: this.mayAssign(group, member, request.plannerMemberId),
      request: { id: request.id, turnsUsed: request.turnsUsed, maxTurns: group.maxTurns, hop: delivery.hop, maxHops: group.maxHops },
      members: this.roster(group, member),
    };
  }

  inbox(ctx: GroupRunContext): unknown {
    const { group, member, request } = this.live(ctx);
    const names = new Map(this.repo.members(group.id).map((m) => [m.id, m.handle]));
    const unread = this.repo.messagesAddressedAfter(group.id, member.id, member.lastReadSeq, LIMITS.inboxCount + 1);
    const page = unread.length ? unread.slice(0, LIMITS.inboxCount) : this.repo.messagesFor(group.id, member.id, LIMITS.inboxCount);
    const messages = page.map((m) => ({
      id: m.id, seq: m.seq, kind: m.kind, from: m.senderMemberId ? names.get(m.senderMemberId) ?? 'unknown' : m.kind === 'user' ? 'human' : 'relay',
      requestId: m.requestId, replyToId: m.replyToId, content: clean(m.content, LIMITS.inboxMessage),
    }));
    const readThrough = unread.length ? page.at(-1)!.seq : member.lastReadSeq;
    if (readThrough > member.lastReadSeq) this.repo.updateMember(member.id, { lastReadSeq: readThrough });
    const assignments = this.repo.activeAssignments(group.id).filter((a) => a.toMemberId === member.id).map((a) => ({
      id: a.id, taskId: a.taskId, title: this.store.getTask(a.taskId)?.title ?? '', status: this.store.getTask(a.taskId)?.status ?? 'unknown', scope: a.scope,
    }));
    return { you: member.handle, request: { id: request.id, text: clean(this.repo.getMessage(request.messageId)?.content ?? '', LIMITS.request) }, messages, assignments, hasMore: unread.length > LIMITS.inboxCount, unreadTeamMessagesRemaining: this.repo.countAddressedAfter(group.id, member.id, readThrough), notice: 'Only your current delivery authorizes execution. Messages for other request IDs are context; call team_inbox again when hasMore is true.' };
  }

  assign(ctx: GroupRunContext, input: Assign): unknown {
    const { group, member, request, delivery, session } = this.live(ctx);
    if (!this.mayAssign(group, member, request.plannerMemberId)) {
      throw forbidden(group.mode === 'cowork' ? 'Only the peer holding this request\'s planning lease can assign work' : 'Only the group orchestrator can assign work');
    }
    const recipient = this.activeByHandle(group, input.recipient);
    if (recipient.id === member.id) throw unprocessable('You cannot assign work to yourself');
    const recipientSession = this.store.getSession(recipient.sessionId);
    if (!recipientSession) throw conflict(`@${recipient.handle} is archived`);
    if (this.repo.countRunMessages(group.id, member.id, delivery.runId!, 'assignment') >= MAX_ASSIGNMENTS_PER_RUN) throw conflict('Too many assignments in one turn');
    const hop = delivery.hop + 1;
    if (hop > group.maxHops) throw conflict(`The message hop limit (${group.maxHops}) has been reached for this request`);
    if (request.turnsUsed + this.repo.requestDeliveries(request.id, ['queued']).length >= group.maxTurns) throw conflict(`The request turn budget (${group.maxTurns}) has been reached`);

    const scope = normalizeScopes(input.scope);
    const dependsOn = [...new Set(input.dependsOn ?? [])].sort();
    const wanted = new Map<string, { taskId: string; path: string }>();
    for (const artifact of input.inputArtifacts ?? []) {
      if (!dependsOn.includes(artifact.taskId)) throw unprocessable(`Input artifact task ${artifact.taskId} must also be listed in dependsOn`);
      const path = safeArtifactPath(artifact.path);
      wanted.set(`${artifact.taskId}\0${path}`, { taskId: artifact.taskId, path });
    }
    const inputs = [...wanted.values()].sort((a, b) => `${a.taskId}${a.path}`.localeCompare(`${b.taskId}${b.path}`));
    const title = clean(input.title.trim(), 200);
    const fingerprint = createHash('sha256').update(JSON.stringify([request.id, recipient.id, title.toLowerCase().replace(/\s+/g, ' '), input.objective.trim(), input.acceptanceCriteria.trim(), scope, dependsOn, inputs])).digest('hex');

    const active = this.repo.activeAssignments(group.id);
    const same = active.find((a) => a.fingerprint === fingerprint);
    if (same) return { assignmentId: same.id, taskId: same.taskId, deliveryId: same.deliveryId, recipient: recipient.handle, status: 'queued-or-active', deduplicated: true };
    for (const other of active) {
      const otherMember = this.repo.getMember(other.toMemberId);
      const otherSession = otherMember ? this.store.getSession(otherMember.sessionId) : undefined;
      if (!otherSession || otherSession.worktreePath !== recipientSession.worktreePath) continue;
      const clash = scopesOverlap(scope, other.scope);
      if (clash) throw conflict(`Scope "${clash}" overlaps active assignment ${other.id} for @${otherMember?.handle ?? 'unknown'} in the same workspace. Narrow the scope or wait for it to finish.`);
    }

    const created = this.store.tx(() => {
      this.live(ctx);
      const task = this.tasks.create({
        projectId: group.projectId, title, description: clean(`${input.objective.trim()}\n\nEdit scope:\n${scope.map((s) => `- ${s}`).join('\n')}`, 20_000),
        acceptanceCriteria: clean(input.acceptanceCriteria ?? '', 10_000), sessionId: recipient.sessionId, dependsOn,
      });
      const id = assignmentId();
      const deliveryIdValue = deliveryId();
      const dependencies = dependsOn.map((taskId) => ({ taskId, title: this.store.getTask(taskId)?.title ?? taskId, status: this.store.getTask(taskId)?.status ?? 'unknown' }));
      const message = this.repo.insertMessage({
        groupId: group.id, senderMemberId: member.id, recipients: [recipient.id], kind: 'assignment', requestId: request.id, sourceRunId: delivery.runId,
        content: assignmentText({
          id, taskId: task.id, from: member.handle, to: recipient.handle, title, objective: input.objective, acceptance: input.acceptanceCriteria ?? '', scope,
          request: this.repo.getMessage(request.messageId)?.content ?? '', dependsOn: dependencies, inputs: inputs.map((i) => ({ ...i, reference: null })),
        }),
      });
      this.repo.insertDelivery({ id: deliveryIdValue, groupId: group.id, requestId: request.id, messageId: message.id, memberId: recipient.id, kind: 'assignment', hop, assignmentId: id });
      this.repo.insertAssignment({ id, groupId: group.id, requestId: request.id, fromMemberId: member.id, toMemberId: recipient.id, taskId: task.id, deliveryId: deliveryIdValue, scope, fingerprint });
      const assignment = this.repo.getAssignment(id)!;
      for (const wantedInput of inputs) {
        const producer = this.store.getTask(wantedInput.taskId);
        const existing = producer ? this.verifiedArtifact(assignment, producer, wantedInput.path, null) : undefined;
        this.repo.insertInput(id, wantedInput.taskId, wantedInput.path, existing?.id ?? null);
      }
      this.repo.updateRequest(request.id, { status: 'active' });
      this.repo.touchGroup(group.id);
      this.event(group, 'group.assignment.created', `Assignment: @${member.handle} → @${recipient.handle}: ${title}`, { assignmentId: id, taskId: task.id, deliveryId: deliveryIdValue, scope }, session.id);
      return { id, taskId: task.id, deliveryId: deliveryIdValue, assignment };
    });
    const waitingOn = this.dependencyState(created.assignment, this.store.getTask(created.taskId)!).waiting;
    this.schedule(group.id);
    return { assignmentId: created.id, taskId: created.taskId, deliveryId: created.deliveryId, recipient: recipient.handle, status: 'queued', waitingOn, deduplicated: false };
  }

  message(ctx: GroupRunContext, input: TeamMessage): unknown {
    const { group, member, request, delivery } = this.live(ctx);
    const recipient = this.activeByHandle(group, input.recipient);
    if (recipient.id === member.id) throw unprocessable('You cannot message yourself');
    if (!this.store.getSession(recipient.sessionId)) throw conflict(`@${recipient.handle} is archived`);
    if (input.replyToId) {
      const original = this.repo.getMessage(input.replyToId);
      if (!original || original.groupId !== group.id) throw unprocessable('replyToId does not identify a message in this group');
    }
    const content = clean(input.content, LIMITS.message);
    const replyToId = input.replyToId ?? null;
    const repeated = this.repo.findAgentMessage(group.id, member.id, recipient.id, replyToId, content, request.id);
    if (repeated) return { messageId: repeated.id, recipient: recipient.handle, deduplicated: true, wakesRecipient: false };
    if (this.repo.countRunMessages(group.id, member.id, delivery.runId!, 'agent') >= MAX_MESSAGES_PER_RUN) throw conflict('Too many messages in one turn');
    const wake = input.expectsReply ?? false;
    const hop = delivery.hop + 1;
    if (wake) {
      if (hop > group.maxHops) throw conflict(`The message hop limit (${group.maxHops}) has been reached; send an informational message instead`);
      if (request.turnsUsed + this.repo.requestDeliveries(request.id, ['queued']).length >= group.maxTurns) throw conflict(`The request turn budget (${group.maxTurns}) has been reached`);
    }
    const result = this.store.tx(() => {
      this.live(ctx);
      const message = this.repo.insertMessage({ groupId: group.id, senderMemberId: member.id, recipients: [recipient.id], kind: 'agent', content, requestId: request.id, replyToId, sourceRunId: delivery.runId });
      // A recipient can answer an inbox question during its existing turn; retire the redundant queued question turn.
      if (input.replyToId) {
        const answered = this.repo.getMessage(input.replyToId);
        if (answered?.senderMemberId === recipient.id && answered.recipientMemberIds.includes(member.id) && !this.repo.hasLaterPeerMessage(group.id, recipient.id, member.id, answered.requestId ?? request.id, answered.seq)) {
          for (const pending of this.repo.memberDeliveries(member.id, ['queued']).filter((d) => d.kind === 'message' && d.messageId === answered.id)) {
            this.repo.setDelivery(pending.id, { status: 'cancelled', retryable: false, error: 'Answered during an existing active turn' });
            this.refreshRequest(pending.requestId);
          }
        }
      }
      let queued: string | null = null;
      if (wake) {
        // One pending reply request per sender and recipient; later notes join the inbox instead of fanning out turns.
        const waiting = this.repo.memberDeliveries(recipient.id, ['queued']).find((d) => d.kind === 'message' && d.requestId === request.id && this.repo.getMessage(d.messageId)?.senderMemberId === member.id);
        if (waiting) queued = waiting.id;
        else {
          queued = deliveryId();
          this.repo.insertDelivery({ id: queued, groupId: group.id, requestId: request.id, messageId: message.id, memberId: recipient.id, kind: 'message', hop });
          this.repo.updateRequest(request.id, { status: 'active' });
        }
      }
      this.repo.touchGroup(group.id);
      this.event(group, 'group.message.agent', `@${member.handle} → @${recipient.handle}${wake ? ' (reply requested)' : ''}`, { messageId: message.id, deliveryId: queued, requestId: request.id });
      return { messageId: message.id, queued };
    });
    if (wake) this.schedule(group.id);
    return { messageId: result.messageId, recipient: recipient.handle, deduplicated: false, wakesRecipient: wake, deliveryId: result.queued };
  }

  status(ctx: GroupRunContext, input: TeamStatus): unknown {
    const { group, member, session, delivery } = this.live(ctx);
    const assignment = this.repo.assignmentByTask(group.id, input.taskId);
    const ownsActiveAssignment = assignment?.toMemberId === member.id && assignment.deliveryId === delivery.id;
    if (!ownsActiveAssignment && delivery.taskId !== input.taskId) throw forbidden('You can only report status for the task assigned to this active delivery');
    const task = this.store.getTask(input.taskId);
    if (!task) throw notFound('Task not found');
    if (task.status === 'done') throw conflict('This task was already accepted as done');
    const note = clean(input.note ?? '', 4000);
    if (input.status === 'running') {
      if (assignment ? this.dependencyState(assignment, task).waiting.length > 0 : unfinishedDeps(task.dependsOn, (dep) => this.store.getTask(dep)?.status).length > 0) throw conflict('This task still waits on prerequisites');
    }
    if (task.status === input.status && !note) return { taskId: task.id, status: task.status, unchanged: true };
    const result = this.store.tx(() => {
      this.live(ctx);
      const next = task.status === input.status ? task : this.store.updateTask(task.id, { status: input.status });
      this.repo.insertMessage({
        groupId: group.id, senderMemberId: member.id, recipients: assignment ? [assignment.fromMemberId] : [], kind: 'status', requestId: delivery.requestId,
        content: clean(`${input.status}: ${this.store.getTask(task.id)?.title ?? task.id}${note ? ` — ${note}` : ''}`, 2000), sourceRunId: this.repo.getDelivery(ctx.deliveryId)?.runId ?? null,
      });
      if (next.status !== task.status) {
        this.store.recordEvent({ projectId: next.projectId, sessionId: next.sessionId, type: `task.${input.status}`, summary: `Task ${input.status} (reported by @${member.handle}): ${next.title}`, payload: { taskId: next.id, from: task.status, to: next.status, groupId: group.id } });
      }
      this.repo.touchGroup(group.id);
      this.event(group, 'group.status', `@${member.handle}: ${input.status}`, { taskId: task.id, status: input.status }, session.id);
      return next;
    });
    // A producer reaching Review can unblock consumers that opted into its published artifacts.
    this.schedule(group.id);
    return { taskId: result.id, status: result.status };
  }

  async artifact(ctx: GroupRunContext, input: TeamArtifact): Promise<unknown> {
    const first = this.live(ctx);
    const { group, member, session } = first;
    const recipient = this.activeByHandle(group, input.recipient);
    if (recipient.id === member.id) throw unprocessable('You cannot send an artifact to yourself');
    const recipientSession = this.store.getSession(recipient.sessionId);
    if (!recipientSession) throw conflict(`@${recipient.handle} is archived`);
    const path = safeArtifactPath(input.path);
    let taskId: string | undefined;
    if (input.taskId) {
      const task = this.store.getTask(input.taskId);
      if (!task || task.projectId !== group.projectId) throw notFound('Task not found in this project');
      const assignment = this.repo.assignmentByTask(group.id, task.id);
      if (task.sessionId !== member.sessionId || (assignment && assignment.toMemberId !== member.id)) throw forbidden('You can only publish artifacts for a task you own');
      taskId = task.id;
    }
    if (FULL_SHA.test(input.revision)) {
      const known = this.repo.findArtifact(group.id, member.id, recipient.id, path, input.revision.toLowerCase(), taskId ?? null);
      if (known) return this.artifactResult(known, true);
    }
    // The handoff re-checks authority inside its own transaction, immediately before it writes to the recipient session.
    const authorize = () => {
      this.live(ctx);
      const currentRecipient = this.requireMember(group, recipient.id);
      if (currentRecipient.sessionId !== recipient.sessionId || !this.store.getSession(currentRecipient.sessionId)) throw conflict('The artifact recipient is no longer available');
      if (taskId) {
        const task = this.store.getTask(taskId);
        if (!task || task.projectId !== group.projectId || task.sessionId !== member.sessionId) throw forbidden('This artifact task is no longer owned by the sender');
      }
    };
    authorize();
    const event = await this.handoffs.create({ fromSessionId: member.sessionId, toSessionId: recipient.sessionId, taskId, path, revision: input.revision, note: clean(input.note ?? '', 4000) }, authorize);
    const handoffMessageId = typeof event.payload.messageId === 'string' ? event.payload.messageId : null;
    const neutralize = (reason: string) => {
      // The verified handoff already exists in the recipient session; keep it from being injected into a run for a stopped sender.
      if (handoffMessageId) this.store.markConsumed([handoffMessageId]);
      this.log('warn', `Artifact handoff ${event.id} was not recorded in the group: ${reason}`);
    };
    let live: Live;
    try { live = this.live(ctx); }
    catch (error) { neutralize(errorMessage(error)); throw error; }

    const commit = String(event.payload.revision ?? '');
    const blob = String(event.payload.blob ?? '');
    const reference = String(event.payload.reference ?? '');
    const duplicate = this.repo.findArtifact(group.id, member.id, recipient.id, path, commit, taskId ?? null);
    if (duplicate) { neutralize('duplicate artifact'); return this.artifactResult(duplicate, true); }
    const stored = this.store.tx(() => {
      this.live(ctx);
      const message = this.repo.insertMessage({
        groupId: group.id, senderMemberId: member.id, recipients: [recipient.id], kind: 'artifact', requestId: live.request.id, sourceRunId: live.delivery.runId,
        content: clean(`Artifact ${path} @ ${commit.slice(0, 12)} (blob ${blob.slice(0, 12)})${taskId ? ` for task ${taskId}` : ''}\n${reference}${input.note?.trim() ? `\n${input.note.trim()}` : ''}`, 3000),
      });
      const id = artifactId();
      this.repo.insertArtifact({
        id, groupId: group.id, requestId: live.request.id, fromMemberId: member.id, toMemberId: recipient.id, taskId: taskId ?? null, path, commitId: commit, blob, reference,
        handoffEventId: event.id, handoffMessageId, messageId: message.id,
      });
      if (taskId) for (const open of this.repo.openInputs(group.id, recipient.id, taskId, path)) this.repo.setInputArtifact(open.assignmentId, open.taskId, open.path, id);
      this.repo.touchGroup(group.id);
      this.event(group, 'group.artifact.published', `Artifact: @${member.handle} → @${recipient.handle}: ${path}`, { artifactId: id, path, commit, taskId: taskId ?? null }, session.id);
      return this.repo.getArtifact(id)!;
    });
    // Wake only queued assignments that were waiting on this exact artifact; nothing is merged and no model turn is forced.
    this.schedule(group.id);
    return this.artifactResult(stored, false);
  }

  private artifactResult(row: ArtifactRow, deduplicated: boolean): unknown {
    return { artifactId: row.id, path: row.path, revision: row.commitId, blob: row.blob.slice(0, 12), reference: row.reference, taskId: row.taskId, deduplicated };
  }

  // ---------------------------------------------------------------- helpers

  /** Verifies, against durable state on every call, that this context is a running delivery of an active member. */
  private live(ctx: GroupRunContext): Live {
    if (this.closed) throw conflict('Relay is shutting down');
    const delivery = this.repo.getDelivery(ctx.deliveryId);
    if (!delivery || delivery.status !== 'running' || !delivery.runId || delivery.groupId !== ctx.groupId || delivery.memberId !== ctx.memberId
      || delivery.requestId !== ctx.requestId || delivery.hop !== ctx.hop) throw conflict('This team connection is no longer tied to an active delivery');
    const group = this.repo.getGroup(delivery.groupId);
    const member = this.repo.getMember(delivery.memberId);
    const request = this.repo.getRequest(delivery.requestId);
    if (!group || !member || !request) throw conflict('The group state for this delivery is gone');
    if (group.paused) throw conflict('The group is stopped');
    if (member.removedAt || member.held) throw conflict('This agent is stopped or no longer in the group');
    const session = this.store.getSession(member.sessionId);
    if (!session) throw conflict('This agent session is archived');
    if (!this.runtime.isActive(session.id) || this.runtime.isRunLive && !this.runtime.isRunLive(session.id, delivery.runId)) throw conflict('This agent run has finished');
    return { delivery, group, member, session, request };
  }

  private mayAssign(group: ConversationGroup, member: MemberRow, plannerId: string): boolean {
    return group.mode === 'cowork' ? plannerId === member.id : group.orchestratorMemberId === member.id;
  }

  private activeByHandle(group: ConversationGroup, handle: string): MemberRow {
    const found = this.repo.members(group.id).find((m) => m.handle === handle.toLowerCase());
    if (!found) throw unprocessable(`Unknown recipient @${handle}. Call team_members to see valid handles.`);
    if (found.removedAt) throw unprocessable(`@${handle} was removed from this group`);
    return found;
  }

  private event(group: ConversationGroup, type: string, summary: string, payload: Record<string, unknown> = {}, sessionId?: string) {
    return this.store.recordEvent({ projectId: group.projectId, sessionId: sessionId ?? null, type, summary: clean(summary, 1000), payload: JSON.parse(redactSecrets(JSON.stringify({ groupId: group.id, ...payload }))) as Record<string, unknown> });
  }

  private assertOpen(): void { if (this.closed) throw conflict('Relay is shutting down'); }

  private requireGroup(id: string): ConversationGroup {
    const group = this.repo.getGroup(id);
    if (!group) throw notFound('Group not found');
    return group;
  }

  private requireMember(group: ConversationGroup, id: string): MemberRow {
    const member = this.repo.getMember(id);
    if (!member || member.groupId !== group.id) throw notFound('Member not found in this group');
    if (member.removedAt) throw conflict('This member was removed from the group');
    return member;
  }

  private sessionBusy(session: Session): boolean {
    return this.runtime.isActive(session.id) || session.status === 'running' || session.status === 'waiting';
  }

  private memberBusy(member: MemberRow): boolean {
    const session = this.store.getSession(member.sessionId);
    return Boolean(session && this.sessionBusy(session));
  }

  /** An existing session may join one group, must be idle with provider cleanup complete, and must not be archived. */
  private requireJoinable(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw notFound('Session not found');
    if (this.repo.activeMemberOfSession(sessionId)) throw conflict('This session is already in a group');
    if (this.sessionBusy(session)) throw conflict('Wait for this session to finish, or interrupt it, before starting a group');
    return session;
  }

  private assertCanChangeRoster(group: ConversationGroup): void {
    const lead = group.orchestratorMemberId ? this.repo.getMember(group.orchestratorMemberId) : undefined;
    if (lead && this.memberBusy(lead)) throw conflict(`@${lead.handle} is busy. Wait for the orchestrator to finish before changing the roster.`);
  }

  private validateHandle(handle: string): string {
    const value = handle.trim().toLowerCase();
    if (RESERVED_HANDLES.has(value)) throw unprocessable(`@${value} is reserved. Choose a handle such as ${value}2.`);
    return value;
  }

  private assertHandleFree(groupIdArg: string, handle: string): void {
    if (this.repo.handleTaken(groupIdArg, handle)) throw conflict(`@${handle} is already used in this group, including by an agent that was removed. Choose another handle.`);
  }

  private checkModel(info: ProviderInfo | undefined, model: string, provider: string): void {
    if (info?.models.length && !info.models.some((row) => row.id === model || row.aliases?.includes(model))) {
      throw unprocessable(`${provider} does not currently advertise model "${model}". Refresh providers or choose an available model.`);
    }
  }

  /** The provider must be advertised as available and the model settings must be valid for it. */
  private checkConfiguration(config: AgentConfiguration): void {
    if (!this.providers) return;
    const list = this.providers();
    if (!list.length) throw conflict('Provider availability has not been detected yet. Refresh providers and try again.');
    const info = list.find((row) => row.id === config.provider);
    if (!info || !info.available) throw conflict(`${config.provider} is not available${info?.reason ? `: ${info.reason}` : ''}`);
    this.checkModel(info, config.model, config.provider);
    resolveRunConfig(info, config, { effort: true, policy: true, serviceTier: true });
  }

  private async provision(projectId: string, name: string, config: AgentConfiguration, isolated: boolean): Promise<Session> {
    return this.workspace.createSession({
      projectId, name, provider: config.provider, model: config.model, effort: config.effort, policy: config.policy, serviceTier: config.serviceTier, isolated,
    });
  }

  /** Newly created sessions are archived so a failed conversion leaves no half group; worktrees stay on disk. */
  private async rollbackSessions(sessions: Session[]): Promise<void> {
    for (const session of sessions.reverse()) {
      try { this.workspace.archiveSession(session.id); }
      catch (error) { this.log('warn', `Could not archive ${session.id} after a failed group change`, error); }
    }
  }
}


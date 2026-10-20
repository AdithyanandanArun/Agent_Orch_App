import { ProviderTaskPlanSchema } from '@mingle/contracts';
import type { ProjectIntelligenceService } from './project-intelligence/service.ts';
import { existsSync, statSync } from 'node:fs';
import type { ProviderTaskPlan, AdapterEvent, Approval, Message, ProviderSkill, RunChanges, Session, ToolActivity, ToolCall } from '@mingle/contracts';
import type { Hub } from './hub.ts';
import type { Store } from './store.ts';
import type { TaskService } from './tasks.ts';
import type { Logger, ProviderRuntime } from './types.ts';
import { conflict, errorMessage, notFound, redactSecrets, truncate, newId, nowIso } from './util.ts';
import { captureRunTree, compareRunTrees, unavailableRunChanges, type RunTreeSnapshot } from './run-changes.ts';
import type { GroupService } from './groups/service.ts';
import type { TeamMcpBridge } from './team-mcp.ts';
import type { BrowserMcpBridge } from './browser-mcp.ts';
import type { AttachmentService } from './attachments/service.ts';
import type { NativeInvocation, RunAttachment } from '@mingle/contracts';

export interface RuntimeOptions {
  /** Milliseconds to wait after an abort before declaring an unresponsive adapter interrupted. */
  abortGraceMs?: number;
  /** Interval for persisting streamed assistant text. */
  flushIntervalMs?: number;
}

interface ToolBuffer { call: ToolCall; output: string; dirty: boolean; tick: number | null }
interface ActiveRun {
  id: string;
  startedAt: string;
  tick: number;
  tools: Map<string, ToolBuffer>;
  activityTimer: NodeJS.Timeout | null;
  sessionId: string;
  controller: AbortController;
  closed: boolean;
  cleanupPending: boolean;
  acceptingTools: boolean;
  approvals: Map<string, (allowed: boolean) => void>;
  stream: { messageId: string; text: string; dirty: boolean } | null;
  flushTimer: NodeJS.Timeout | null;
  consumedHandoffs: string[];
  firstEvent: boolean;
  baseInput: number;
  baseOutput: number;
  baseCost: number | null;
  taskId: string | null;
  skills: ProviderSkill[];
  invocation?: NativeInvocation;
  context?: string;
  attachmentOwnerKind?: 'message' | 'group_message';
  attachmentOwnerId?: string;
  changeBaseline: RunTreeSnapshot | null;
  promise: Promise<void>;
}

export interface StartOptions { groupDeliveryId?: string; taskId?: string; userMessage?: { content: string; kind?: string }; skills?: ProviderSkill[]; attachmentIds?: string[]; attachmentOwnerKind?: 'message' | 'group_message'; attachmentOwnerId?: string; invocation?: NativeInvocation }

const MAX_TOOL_CHARS = 20_000;
const MAX_APPROVAL_INPUT_CHARS = 20_000;

export class SessionRuntime {
  private readonly active = new Map<string, ActiveRun>();
  private groups?: GroupService;
  private teamMcp?: TeamMcpBridge;
  private attachmentService?: AttachmentService;
  private readonly abortGraceMs: number;
  private readonly flushIntervalMs: number;

  constructor(
    private readonly store: Store, private readonly hub: Hub, private readonly providers: ProviderRuntime, private readonly tasks: TaskService,
    private readonly log: Logger, options: RuntimeOptions = {}, private readonly validateSession?: (session: Session) => void, private readonly browserMcp?: BrowserMcpBridge, private readonly intelligence?: ProjectIntelligenceService,
  ) {
    // Covers the supported adapters' interrupt grace and escalating process shutdown.
    this.abortGraceMs = options.abortGraceMs ?? 30_000;
    this.flushIntervalMs = options.flushIntervalMs ?? 300;
  }

  setGroupServices(groups: GroupService, teamMcp: TeamMcpBridge): void {
    this.groups = groups;
    this.teamMcp = teamMcp;
  }
  setAttachments(service: AttachmentService): void { this.attachmentService = service; }

  activeCount(): number {
    return this.active.size;
  }
  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }
  /** A cleanup lock can outlive provider execution; it must not keep tool authority alive. */
  isRunLive(sessionId: string, runId: string): boolean {
    const run = this.active.get(sessionId);
    return Boolean(run && run.id === runId && run.acceptingTools && !run.closed && !run.controller.signal.aborted);
  }

  /**
   * Starts an asynchronous provider run. All validation and bookkeeping is synchronous and the session is registered as
   * active before any await, so two concurrent requests can never both start a provider Promise for one session.
   */
  start(sessionId: string, content: string, options: StartOptions = {}): string {
    const session = this.store.getSession(sessionId);
    if (!session) throw notFound('Session not found');
    if (this.groups?.forSession(sessionId) && !options.groupDeliveryId) throw conflict('Start grouped work through its recorded group delivery.');
    if (this.active.has(sessionId) || session.status === 'running' || session.status === 'waiting') throw conflict('Session already has an active run or provider cleanup is still in progress');
    if (!existsSync(session.worktreePath) || !statSync(session.worktreePath).isDirectory()) throw conflict('The session worktree no longer exists on disk');
    this.validateSession?.(session);

    const handoffs = this.store.unconsumedHandoffs(sessionId);
    const runId = newId('run');
    const invocation = options.invocation;
    const prompt = invocation ? content : this.composePrompt(handoffs, content);
    const run: ActiveRun = {
      id: runId, startedAt: nowIso(), tick: performance.now(), tools: new Map(), activityTimer: null,
      sessionId, controller: new AbortController(), closed: false, cleanupPending: false, acceptingTools: false, approvals: new Map(), stream: null, flushTimer: null, consumedHandoffs: handoffs.map((h) => h.id), firstEvent: false,
      baseInput: session.inputTokens, baseOutput: session.outputTokens, baseCost: session.costUsd, taskId: options.taskId ?? null, skills: options.skills ?? [], invocation, context: invocation && handoffs.length ? this.composePrompt(handoffs, '') : undefined, attachmentOwnerKind: options.attachmentOwnerKind ?? 'message', attachmentOwnerId: options.attachmentOwnerId, changeBaseline: null, promise: Promise.resolve(),
    };
    this.store.tx(() => {
      const userMessage = this.store.insertMessage({ sessionId, role: 'user', content: options.userMessage?.content ?? content, kind: options.userMessage?.kind ?? null, runId: run.id });
      run.attachmentOwnerId ??= userMessage.id;
      if (options.attachmentIds?.length) {
        if (!this.attachmentService) throw conflict('Attachments are unavailable in this Relay session.');
        this.attachmentService.claim({ kind: 'session', id: sessionId }, options.attachmentIds, 'message', userMessage.id);
      }
      this.store.insertRun({ id: run.id, sessionId, userMessageId: userMessage.id, provider: session.provider, model: session.model, startedAt: run.startedAt });
      this.store.updateSession(sessionId, { status: 'running', error: null });
      if (options.taskId) {
        const task = this.store.getTask(options.taskId);
        if (task) this.tasks.markRunning(task);
      }
      this.intelligence?.trackRequest(session, run.id, options.userMessage?.content ?? content, options.taskId);
      this.store.recordEvent({ projectId: session.projectId, sessionId, type: 'session.run.started', summary: `Run started: ${session.name}`, payload: { runId: run.id, provider: session.provider, model: session.model, taskId: options.taskId ?? null, handoffsIncluded: handoffs.length } });
    });
    this.active.set(sessionId, run);
    run.promise = this.execute(run, session, prompt);
    return run.id;
  }

  private composePrompt(handoffs: Message[], content: string): string {
    if (!handoffs.length) return content;
    const blocks = handoffs.map((h) => h.content.trim());
    return ['[Relay context — artifacts handed off to this session since your last turn]', ...blocks, '[End of handed-off context]', '', content].join('\n\n');
  }

  private async execute(run: ActiveRun, startSession: Session, prompt: string): Promise<void> {
    let outcome: 'completed' | 'failed' | 'interrupted' = 'completed';
    let failure: string | null = null;
    const capabilityTokens: string[] = [];
    const scrubCapabilities = (value: string): string => capabilityTokens.reduce((text, token) => text.split(token).join('[redacted]'), value);
    try {
      run.changeBaseline = await captureRunTree(startSession.worktreePath);
      if (run.controller.signal.aborted) {
        this.finish(run, 'interrupted', null, unavailableRunChanges('The run was interrupted before work started.'));
        return;
      }
      const adapter = this.providers.createAdapter(startSession.provider);
      const session = this.store.getSession(run.sessionId) ?? startSession;
      const settings = this.store.getSettings();
      // A queue pause can arrive while the initial Git snapshot is being captured. Do not start inference after that pause.
      if (this.groups?.forSession(session.id)?.group.paused) {
        run.controller.abort();
        this.finish(run, 'interrupted', null, unavailableRunChanges('Group scheduling was paused before the provider started.'));
        return;
      }
      run.acceptingTools = true;
      const browserMcp = settings.browserAgentEnabled !== false ? this.browserMcp?.create(run.id, session, run.controller.signal, (request) => this.requestApproval(run, request)) : undefined;
      if (browserMcp) capabilityTokens.push(browserMcp.token);
      const groupContext = this.groups?.contextForRun(session.id, run.id);
      if (this.groups?.forSession(session.id) && !groupContext) throw conflict('Group runs must start through a recorded group delivery. Refresh and send through the group conversation.');
      const teamMcp = groupContext ? this.teamMcp?.create(run.id, session, run.controller.signal, groupContext) : undefined;
      if (teamMcp) capabilityTokens.push(teamMcp.token);
      const explicit = run.invocation;
      const effectivePrompt = explicit ? prompt : groupContext ? `${groupContext.instructions}\n\n${prompt}` : prompt;
      if (explicit && groupContext) run.context = [run.context, groupContext.instructions].filter(Boolean).join('\n\n');
      const stagedAttachments = this.attachmentService && run.attachmentOwnerId
        ? await this.attachmentService.stage(run.id, run.attachmentOwnerKind ?? 'message', run.attachmentOwnerId)
        : [];
      if (run.controller.signal.aborted) throw conflict('The run was interrupted before the provider started.');
      const adapterRun = Promise.resolve().then(() => adapter.run({
        session, prompt: effectivePrompt, ...(explicit ? { invocation: explicit, context: run.context } : {}), attachments: stagedAttachments, teamMcp, providerTaskState: this.nativeTaskState(session), skills: run.skills, browserMcp, signal: run.controller.signal, settings,
        onEvent: (event) => this.handleEvent(run, capabilityTokens.length ? JSON.parse(scrubCapabilities(JSON.stringify(event))) as AdapterEvent : event),
        requestApproval: (request) => this.requestApproval(run, JSON.parse(scrubCapabilities(JSON.stringify(request)))),
      }));
      const grace = new Promise<'grace'>((resolve) => {
        const onAbort = () => setTimeout(() => resolve('grace'), this.abortGraceMs).unref();
        if (run.controller.signal.aborted) onAbort();
        else run.controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      adapterRun.catch(() => undefined); // an orphaned adapter promise must never become an unhandled rejection
      const result = await Promise.race([adapterRun.then(() => 'done' as const), grace]);
      if (result === 'grace') {
        this.log('warn', `Adapter for session ${run.sessionId} ignored abort; keeping its session locked until cleanup finishes`);
        run.cleanupPending = true;
        // Finishing the visible turn must never grant a second writer access to the same worktree.
        void adapterRun.then(() => this.releaseAfterCleanup(run), () => this.releaseAfterCleanup(run));
      }
      outcome = run.controller.signal.aborted ? 'interrupted' : 'completed';
    } catch (error) {
      if (run.controller.signal.aborted) outcome = 'interrupted';
      else {
        outcome = 'failed';
        const detail = redactSecrets(errorMessage(error));
        failure = truncate(scrubCapabilities(detail), 4000);
      }
    }
    run.acceptingTools = false;
    if (!run.cleanupPending) await this.attachmentService?.release(run.id);
    this.browserMcp?.revoke(run.id);
    this.teamMcp?.revoke(run.id);
    let changes: RunChanges;
    try {
      changes = run.cleanupPending
        ? unavailableRunChanges('The provider was still stopping, so a final change snapshot could not be captured.')
        : run.changeBaseline?.status !== 'available'
          ? unavailableRunChanges('A starting workspace snapshot was unavailable. Changes for this run cannot be determined.')
          : await compareRunTrees(startSession.worktreePath, run.changeBaseline, await captureRunTree(startSession.worktreePath));
      if (!startSession.isolated && changes.summary.status === 'available') {
        changes.summary.notices.push('This session uses a shared project folder. Changes made by other writers during the run may be included.');
      }
    } catch {
      changes = unavailableRunChanges('Workspace changes could not be captured for this run.');
    }
    this.finish(run, outcome, failure, changes);
  }

  /** Rehydrate only genuine root Claude task IDs; this metadata is never replayed as prompt text. */
  private nativeTaskState(session: Session): ProviderTaskPlan['steps'] | undefined {
    if (session.provider !== 'claude') return undefined;
    const tasks = this.store.listTasks(session.projectId).filter(task => task.sessionId === session.id && task.source?.kind === 'provider' && task.source.providerId && task.source.key === `provider:${session.id}:claude-tasks:root:${task.source.providerId}` && !task.source.missing).slice(-100);
    const byId = new Map(tasks.map(task => [task.id, task.source!.providerId!]));
    return tasks.map(task => ({ id: task.source!.providerId!, title: task.title.slice(0, 200), description: task.description.slice(0, 4000), status: task.source!.reportedStatus ?? 'pending', dependsOn: task.dependsOn.map(id => byId.get(id)).filter((id): id is string => Boolean(id)) }));
  }

  private releaseAfterCleanup(run: ActiveRun): void {
    if (run.attachmentOwnerId) void this.attachmentService?.release(run.id);
    run.cleanupPending = false;
    if (run.closed && this.active.get(run.sessionId) === run) {
      this.active.delete(run.sessionId);
      try { this.groups?.onRuntimeIdle(run.sessionId); }
      catch (error) { this.log('error', `Failed to resume group queue after provider cleanup for ${run.sessionId}`, error); }
    }
  }

  private consumeHandoffsOnce(run: ActiveRun): void {
    if (run.firstEvent) return;
    run.firstEvent = true;
    if (run.consumedHandoffs.length) this.store.markConsumed(run.consumedHandoffs);
  }

  private handleEvent(run: ActiveRun, event: AdapterEvent): void {
    if (run.closed) return;
    try {
      switch (event.type) {
        case 'task.plan': {
          const { type: _type, ...raw } = event;
          const plan = ProviderTaskPlanSchema.safeParse(JSON.parse(redactSecrets(JSON.stringify(raw))));
          const session = this.store.getSession(run.sessionId);
          if (session && plan.success) this.intelligence?.applyPlan(session, run.id, plan.data);
          break;
        }
        case 'session':
          if (event.providerSessionId) this.store.updateSession(run.sessionId, { providerSessionId: event.providerSessionId });
          break;
        case 'text':
          if (!event.text) return;
          this.appendText(run, event.text);
          break;
        case 'tool.activity':
          this.recordTool(run, event.activity);
          break;
        case 'tool.output':
          this.appendToolOutput(run, event.id, event.delta);
          break;
        case 'tool': {
          this.closeStream(run, null);
          this.store.insertMessage({ sessionId: run.sessionId, runId: run.id, role: 'tool', kind: 'tool', content: truncate(redactSecrets(`${event.name}${event.content ? `\n${event.content}` : ''}`), MAX_TOOL_CHARS) });
          this.store.touch();
          break;
        }
        case 'usage': {
          // Usage events are treated as run-cumulative snapshots on top of the totals at run start.
          const input = Math.max(0, Math.floor(event.inputTokens || 0));
          const output = Math.max(0, Math.floor(event.outputTokens || 0));
          const cost = event.costUsd === null || event.costUsd === undefined ? run.baseCost : (run.baseCost ?? 0) + event.costUsd;
          this.store.updateSession(run.sessionId, { inputTokens: run.baseInput + input, outputTokens: run.baseOutput + output, costUsd: cost });
          this.store.touch();
          break;
        }
        case 'info':
          this.closeStream(run, null);
          this.store.insertMessage({ sessionId: run.sessionId, runId: run.id, role: 'system', kind: 'info', content: truncate(redactSecrets(event.content), MAX_TOOL_CHARS) });
          this.store.touch();
          break;
      }
    } catch (error) {
      this.log('error', `Failed to record adapter event for ${run.sessionId}`, error);
    }
  }

  private recordTool(run: ActiveRun, activity: ToolActivity): void {
    const providerId = activity.id.slice(0, 200);
    if (!providerId) return;
    let buffer = run.tools.get(providerId);
    const at = nowIso();
    if (!buffer) {
      this.closeStream(run, null);
      buffer = { output: '', dirty: false, tick: activity.status === 'running' ? performance.now() : null,
        call: { id: newId('tool'), runId: run.id, sessionId: run.sessionId, providerId, parentProviderId: null,
          name: activity.name, category: activity.category, status: activity.status, summary: '', command: null, input: '', output: '',
          cwd: null, exitCode: null, processId: null, startedAt: at, finishedAt: null, durationMs: null } };
      run.tools.set(providerId, buffer);
    }
    const call = buffer.call;
    const terminal = call.finishedAt !== null;
    call.name = truncate(redactSecrets(activity.name), 200);
    call.category = activity.category;
    if (!terminal || activity.status !== 'running') call.status = activity.status;
    if (activity.parentId !== undefined) call.parentProviderId = activity.parentId?.slice(0, 200) ?? null;
    if (activity.summary !== undefined) call.summary = truncate(redactSecrets(activity.summary), 1000);
    if (activity.command !== undefined) call.command = activity.command === null ? null : truncate(redactSecrets(activity.command), 4000);
    if (activity.input !== undefined) call.input = truncate(redactSecrets(activity.input), MAX_TOOL_CHARS);
    if (activity.cwd !== undefined) call.cwd = activity.cwd === null ? null : truncate(redactSecrets(activity.cwd), 4096);
    if (activity.processId !== undefined) call.processId = activity.processId === null ? null : truncate(String(activity.processId), 200);
    if (activity.exitCode !== undefined) call.exitCode = typeof activity.exitCode === 'number' && Number.isFinite(activity.exitCode) ? activity.exitCode : null;
    if (activity.output !== undefined) {
      buffer.call.outputTruncated = activity.output.length > MAX_TOOL_CHARS;
      buffer.output = activity.output.slice(-MAX_TOOL_CHARS);
    }
    if (call.status !== 'running' && !terminal) {
      call.finishedAt = at;
      call.durationMs = buffer.tick === null ? null : Math.max(0, Math.round(performance.now() - buffer.tick));
    }
    if (typeof activity.durationMs === 'number' && Number.isFinite(activity.durationMs) && activity.durationMs >= 0) call.durationMs = Math.round(activity.durationMs);
    this.persistTool(buffer);
    this.store.touch();
  }

  private persistTool(buffer: ToolBuffer): void {
    buffer.call.output = redactSecrets(buffer.output);
    this.store.putToolCall(buffer.call);
    buffer.dirty = false;
  }

  private appendToolOutput(run: ActiveRun, providerId: string, delta: string): void {
    if (!delta) return;
    const id = providerId.slice(0, 200);
    let buffer = run.tools.get(id);
    if (!buffer) {
      this.recordTool(run, { id, name: 'Tool', category: 'other', status: 'running', summary: 'Tool output' });
      buffer = run.tools.get(id);
    }
    if (!buffer || buffer.call.finishedAt) return;
    const next = buffer.output + delta;
    buffer.call.outputTruncated ||= next.length > MAX_TOOL_CHARS;
    buffer.output = next.slice(-MAX_TOOL_CHARS);
    buffer.dirty = true;
    if (!run.activityTimer) run.activityTimer = setTimeout(() => {
      run.activityTimer = null;
      for (const tool of run.tools.values()) if (tool.dirty) this.persistTool(tool);
      this.store.touch();
    }, this.flushIntervalMs);
  }

  private finishTools(run: ActiveRun): void {
    if (run.activityTimer) clearTimeout(run.activityTimer);
    run.activityTimer = null;
    const at = nowIso();
    for (const buffer of run.tools.values()) {
      if (buffer.call.status === 'running') {
        buffer.call.status = 'interrupted';
        buffer.call.finishedAt = at;
        buffer.call.durationMs = buffer.tick === null ? null : Math.max(0, Math.round(performance.now() - buffer.tick));
        buffer.output = (buffer.output + '\n[Relay: run ended before this tool reported completion.]').slice(-MAX_TOOL_CHARS);
      }
      this.persistTool(buffer);
    }
  }

  private appendText(run: ActiveRun, text: string): void {
    const offset = run.stream?.text.length ?? 0;
    if (!run.stream) {
      const message = this.store.insertMessage({ sessionId: run.sessionId, runId: run.id, role: 'assistant', content: text, kind: 'streaming' });
      run.stream = { messageId: message.id, text, dirty: false };
      this.store.touch();
    } else {
      run.stream.text += text;
      run.stream.dirty = true;
      if (!run.flushTimer) run.flushTimer = setTimeout(() => this.flush(run), this.flushIntervalMs);
    }
    this.hub.broadcast({ type: 'session.delta', sessionId: run.sessionId, messageId: run.stream.messageId, delta: text, offset });
  }

  private flush(run: ActiveRun): void {
    if (run.flushTimer) clearTimeout(run.flushTimer);
    run.flushTimer = null;
    if (run.stream?.dirty) {
      this.store.updateMessage(run.stream.messageId, { content: run.stream.text });
      run.stream.dirty = false;
    }
  }

  /** Persists the streamed text and sets its final kind (null = ordinary message, 'partial' = cut short). */
  private closeStream(run: ActiveRun, kind: 'partial' | null): void {
    if (!run.stream) return;
    this.flush(run);
    this.store.updateMessage(run.stream.messageId, { content: run.stream.text, kind });
    run.stream = null;
  }

  private requestApproval(run: ActiveRun, request: { tool: string; description: string; input: Record<string, unknown> }): Promise<boolean> {
    if (run.closed || run.controller.signal.aborted) return Promise.resolve(false);
    const approval = this.store.tx(() => {
      const created = this.store.insertApproval({ sessionId: run.sessionId, tool: truncate(String(request.tool), 200), description: truncate(redactSecrets(String(request.description ?? '')), 4000), input: sanitizeInput(request.input) });
      this.store.updateSession(run.sessionId, { status: 'waiting' });
      const session = this.store.getSession(run.sessionId)!;
      this.store.recordEvent({ projectId: session.projectId, sessionId: run.sessionId, type: 'approval.requested', summary: `Approval requested: ${created.tool}`, payload: { approvalId: created.id, tool: created.tool } });
      return created;
    });
    return new Promise<boolean>((resolve) => run.approvals.set(approval.id, resolve));
  }

  /** Resolves a pending approval from the host UI. Stale approvals (no live run) are expired and rejected. */
  decide(approvalId: string, decision: 'approved' | 'denied'): Approval {
    const approval = this.store.getApproval(approvalId);
    if (!approval) throw notFound('Approval not found');
    if (approval.status !== 'pending') throw conflict(`Approval was already ${approval.status}`);
    const run = this.active.get(approval.sessionId);
    const resolver = run?.approvals.get(approvalId);
    const session = this.store.getSession(approval.sessionId, true);
    if (!run || !resolver || run.closed) {
      this.store.tx(() => {
        this.store.resolveApproval(approvalId, 'denied', 'expired');
        this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: approval.sessionId, type: 'approval.expired', summary: `Approval expired: ${approval.tool}`, payload: { approvalId, reason: 'no active run' } });
      });
      throw conflict('Approval is stale: its run is no longer active');
    }
    const resolved = this.store.tx(() => {
      const result = this.store.resolveApproval(approvalId, decision, 'host');
      run.approvals.delete(approvalId);
      if (run.approvals.size === 0) this.store.updateSession(approval.sessionId, { status: 'running' });
      this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: approval.sessionId, type: 'approval.resolved', summary: `Approval ${decision}: ${approval.tool}`, payload: { approvalId, decision } });
      return result;
    });
    resolver(decision === 'approved');
    return resolved;
  }

  /** Denies and releases every pending approval of a run. */
  private denyApprovals(run: ActiveRun, reason: string): void {
    if (!run.approvals.size) return;
    const session = this.store.getSession(run.sessionId, true);
    const entries = [...run.approvals.entries()];
    run.approvals.clear();
    this.store.tx(() => {
      for (const [id] of entries) {
        this.store.resolveApproval(id, 'denied', reason);
        this.store.recordEvent({ projectId: session?.projectId ?? null, sessionId: run.sessionId, type: 'approval.denied', summary: `Approval denied (${reason})`, payload: { approvalId: id, reason } });
      }
    });
    for (const [, resolve] of entries) resolve(false);
  }

  /** Cancels the active run, if any. Idempotent. */
  interrupt(sessionId: string): boolean {
    const run = this.active.get(sessionId);
    if (!run || run.closed) return false;
    run.controller.abort();
    this.denyApprovals(run, 'interrupted');
    return true;
  }

  private finish(run: ActiveRun, outcome: 'completed' | 'failed' | 'interrupted', failure: string | null, changes: RunChanges, durationMs = Math.max(0, Math.round(performance.now() - run.tick)), finishedAt = nowIso()): void {
    run.closed = true;
    run.acceptingTools = false;
    this.denyApprovals(run, outcome === 'completed' ? 'run finished' : outcome);
    try {
      this.store.tx(() => {
        this.closeStream(run, outcome === 'completed' ? null : 'partial');
        this.finishTools(run);
        this.store.setRunChanges(run.id, changes);
        this.store.finishRun(run.id, outcome, durationMs, finishedAt);
        const session = this.store.getSession(run.sessionId, true);
        if (!session) return;
        if (outcome === 'failed') {
          this.store.insertMessage({ sessionId: run.sessionId, runId: run.id, role: 'system', kind: 'error', content: `Run failed: ${failure}` });
          this.store.updateSession(run.sessionId, { status: 'error', error: failure });
        } else if (outcome === 'interrupted') {
          this.store.insertMessage({ sessionId: run.sessionId, runId: run.id, role: 'system', kind: 'info', content: 'Run interrupted.' });
          this.store.updateSession(run.sessionId, { status: 'interrupted', error: null });
        } else {
          this.consumeHandoffsOnce(run);
          this.store.updateSession(run.sessionId, { status: 'idle', error: null });
        }
        if (outcome === 'completed' && !run.firstEvent) this.store.markConsumed(run.consumedHandoffs);
        if (run.taskId) this.tasks.finishRun(run.taskId, outcome);
        this.intelligence?.finishRun(session, run.id, outcome);
        this.store.recordEvent({
          projectId: session.projectId, sessionId: run.sessionId, type: `session.run.${outcome}`,
          summary: outcome === 'completed' ? `Run completed: ${session.name}` : outcome === 'failed' ? `Run failed: ${session.name}` : `Run interrupted: ${session.name}`,
          payload: { runId: run.id, durationMs, taskId: run.taskId, ...(failure ? { error: failure } : {}) },
        });
      });
    } catch (error) {
      this.log('error', `Failed to finalise run for ${run.sessionId}`, error);
    } finally {
      if (!run.cleanupPending) this.active.delete(run.sessionId);
      try { this.groups?.onRunFinished(run.sessionId, run.id, outcome); }
      catch (error) { this.log('error', `Failed to record group delivery outcome for ${run.sessionId}`, error); }
    }
  }

  /** Aborts every run and waits (bounded) for adapters to settle. */
  async shutdown(): Promise<void> {
    const runs = [...this.active.values()];
    for (const run of runs) this.interrupt(run.sessionId);
    await Promise.race([Promise.allSettled(runs.map((r) => r.promise)), new Promise((resolve) => setTimeout(resolve, this.abortGraceMs + 1000).unref())]);
  }
}

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = redactSecrets(JSON.stringify(input ?? {}));
    if (json.length <= MAX_APPROVAL_INPUT_CHARS) return JSON.parse(json) as Record<string, unknown>;
    return { truncated: true, preview: json.slice(0, MAX_APPROVAL_INPUT_CHARS) };
  } catch {
    return { unserializable: true };
  }
}

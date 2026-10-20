import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  ConversationGroup, GroupAssignment, GroupDelivery, GroupMember, GroupMessage, GroupMode, GroupRequest,
} from '@relay/contracts';
import { newId as baseId, nowIso } from '../util.ts';

type Row = Record<string, unknown>;

export type DeliveryKind = 'request' | 'assignment' | 'message' | 'result';
export type DeliveryStatus = GroupDelivery['status'];
export const OPEN_DELIVERY: DeliveryStatus[] = ['queued', 'running'];
/** States that still await a model turn (running, waiting or retryable after a stop/failure). */
export const UNSETTLED_DELIVERY: DeliveryStatus[] = ['queued', 'running', 'failed', 'interrupted'];

export interface MemberRow extends GroupMember { held: boolean; lastReadSeq: number }
export interface DeliveryRow extends GroupDelivery { kind: DeliveryKind; assignmentId: string | null; taskId: string | null; attempts: number; retryable: boolean; startedAt: string | null }
export interface AssignmentRow extends GroupAssignment { fingerprint: string; notified: boolean }
export interface ArtifactRow {
  id: string; groupId: string; requestId: string; fromMemberId: string; toMemberId: string; taskId: string | null; path: string;
  commitId: string; blob: string; reference: string; handoffEventId: number | null; handoffMessageId: string | null; messageId: string; createdAt: string;
}
export interface InputRow { assignmentId: string; taskId: string; path: string; artifactId: string | null }

const newGroupId = (prefix: string) => `${prefix}_${baseId('msg').slice(4)}`;
export const groupId = () => newGroupId('grp');
export const memberId = () => newGroupId('mem');
export const messageId = () => newGroupId('gms');
export const requestId = () => newGroupId('req');
export const deliveryId = () => newGroupId('dlv');
export const assignmentId = () => newGroupId('asg');
export const artifactId = () => newGroupId('art');

const bool = (value: unknown) => value === 1;
const mapGroup = (r: Row): ConversationGroup => ({
  id: r.id as string, projectId: r.project_id as string, title: r.title as string, anchorSessionId: r.anchor_session_id as string,
  mode: r.mode as GroupMode, orchestratorMemberId: (r.orchestrator_member_id as string | null) ?? null, paused: bool(r.paused),
  pauseReason: (r.pause_reason as string | null) ?? null, maxParallel: r.max_parallel as number, maxTurns: r.max_turns as number,
  maxHops: r.max_hops as number, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
});
const mapMember = (r: Row): MemberRow => ({
  id: r.id as string, groupId: r.group_id as string, sessionId: r.session_id as string, handle: r.handle as string,
  role: r.role as GroupMember['role'], joinedAt: r.joined_at as string, removedAt: (r.removed_at as string | null) ?? null,
  held: bool(r.held), lastReadSeq: r.last_read_seq as number,
});
const mapMessage = (r: Row): GroupMessage => ({
  id: r.id as string, seq: r.seq as number, groupId: r.group_id as string, senderMemberId: (r.sender_member_id as string | null) ?? null,
  recipientMemberIds: JSON.parse(r.recipient_member_ids as string) as string[], kind: r.kind as GroupMessage['kind'], content: r.content as string,
  requestId: (r.request_id as string | null) ?? null, replyToId: (r.reply_to_id as string | null) ?? null,
  sourceMessageId: (r.source_message_id as string | null) ?? null, sourceRunId: (r.source_run_id as string | null) ?? null, createdAt: r.created_at as string,
});
const mapRequest = (r: Row): GroupRequest => ({
  id: r.id as string, groupId: r.group_id as string, messageId: r.message_id as string, plannerMemberId: r.planner_member_id as string,
  status: r.status as GroupRequest['status'], turnsUsed: r.turns_used as number, createdAt: r.created_at as string,
});
const mapDelivery = (r: Row): DeliveryRow => ({
  id: r.id as string, groupId: r.group_id as string, requestId: r.request_id as string, messageId: r.message_id as string, memberId: r.member_id as string,
  status: r.status as DeliveryStatus, runId: (r.run_id as string | null) ?? null, hop: r.hop as number, error: (r.error as string | null) ?? null,
  createdAt: r.created_at as string, updatedAt: r.updated_at as string, kind: r.kind as DeliveryKind,
  assignmentId: (r.assignment_id as string | null) ?? null, taskId: (r.task_id as string | null) ?? null, attempts: r.attempts as number, retryable: bool(r.retryable), startedAt: (r.started_at as string | null) ?? null,
});
const mapAssignment = (r: Row): AssignmentRow => ({
  id: r.id as string, groupId: r.group_id as string, requestId: r.request_id as string, fromMemberId: r.from_member_id as string,
  toMemberId: r.to_member_id as string, taskId: r.task_id as string, deliveryId: r.delivery_id as string, scope: JSON.parse(r.scope as string) as string[],
  createdAt: r.created_at as string, fingerprint: r.fingerprint as string, notified: bool(r.notified),
});
const mapArtifact = (r: Row): ArtifactRow => ({
  id: r.id as string, groupId: r.group_id as string, requestId: r.request_id as string, fromMemberId: r.from_member_id as string,
  toMemberId: r.to_member_id as string, taskId: (r.task_id as string | null) ?? null, path: r.path as string, commitId: r.commit_id as string,
  blob: r.blob as string, reference: r.reference as string, handoffEventId: (r.handoff_event_id as number | null) ?? null,
  handoffMessageId: (r.handoff_message_id as string | null) ?? null, messageId: r.message_id as string, createdAt: r.created_at as string,
});

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Thin SQL layer over the group tables. Callers own transactions through Store.tx. */
export class GroupRepo {
  constructor(private readonly db: DatabaseSync) {}

  private all(sql: string, ...params: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  private run(sql: string, ...params: SQLInputValue[]): number { return Number(this.db.prepare(sql).run(...params).changes); }

  // groups
  insertGroup(g: { id: string; projectId: string; title: string; anchorSessionId: string; mode: GroupMode; maxParallel: number; maxTurns: number; maxHops: number }): void {
    const now = nowIso();
    this.run(`INSERT INTO conversation_groups(id, project_id, title, anchor_session_id, mode, max_parallel, max_turns, max_hops, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, g.id, g.projectId, g.title, g.anchorSessionId, g.mode, g.maxParallel, g.maxTurns, g.maxHops, now, now);
  }
  getGroup(id: string): ConversationGroup | undefined {
    const row = this.get('SELECT * FROM conversation_groups WHERE id = ?', id);
    return row ? mapGroup(row) : undefined;
  }
  listGroups(): ConversationGroup[] { return this.all('SELECT * FROM conversation_groups ORDER BY created_at ASC, rowid ASC').map(mapGroup); }
  updateGroup(id: string, patch: { mode?: GroupMode; orchestratorMemberId?: string | null; paused?: boolean; pauseReason?: string | null; maxParallel?: number; maxTurns?: number; maxHops?: number }): void {
    const sets = ['updated_at = ?'];
    const params: SQLInputValue[] = [nowIso()];
    const add = (column: string, value: SQLInputValue | undefined) => { if (value !== undefined) { sets.push(`${column} = ?`); params.push(value); } };
    add('mode', patch.mode);
    add('orchestrator_member_id', patch.orchestratorMemberId);
    add('paused', patch.paused === undefined ? undefined : patch.paused ? 1 : 0);
    add('pause_reason', patch.pauseReason);
    add('max_parallel', patch.maxParallel);
    add('max_turns', patch.maxTurns);
    add('max_hops', patch.maxHops);
    this.run(`UPDATE conversation_groups SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }
  touchGroup(id: string): void { this.run('UPDATE conversation_groups SET updated_at = ? WHERE id = ?', nowIso(), id); }

  // members
  insertMember(m: { id: string; groupId: string; sessionId: string; handle: string; role: GroupMember['role'] }): void {
    this.run('INSERT INTO group_members(id, group_id, session_id, handle, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)', m.id, m.groupId, m.sessionId, m.handle, m.role, nowIso());
  }
  getMember(id: string): MemberRow | undefined {
    const row = this.get('SELECT * FROM group_members WHERE id = ?', id);
    return row ? mapMember(row) : undefined;
  }
  members(groupId: string, includeRemoved = true): MemberRow[] {
    return this.all(`SELECT * FROM group_members WHERE group_id = ? ${includeRemoved ? '' : 'AND removed_at IS NULL'} ORDER BY joined_at ASC, rowid ASC`, groupId).map(mapMember);
  }
  activeMemberOfSession(sessionId: string): MemberRow | undefined {
    const row = this.get('SELECT * FROM group_members WHERE session_id = ? AND removed_at IS NULL', sessionId);
    return row ? mapMember(row) : undefined;
  }
  handleTaken(groupId: string, handle: string): boolean { return Boolean(this.get('SELECT 1 AS x FROM group_members WHERE group_id = ? AND handle = ?', groupId, handle)); }
  updateMember(id: string, patch: { role?: GroupMember['role']; held?: boolean; lastReadSeq?: number; removedAt?: string }): void {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.role !== undefined) { sets.push('role = ?'); params.push(patch.role); }
    if (patch.held !== undefined) { sets.push('held = ?'); params.push(patch.held ? 1 : 0); }
    if (patch.lastReadSeq !== undefined) { sets.push('last_read_seq = ?'); params.push(patch.lastReadSeq); }
    if (patch.removedAt !== undefined) { sets.push('removed_at = ?'); params.push(patch.removedAt); }
    if (sets.length) this.run(`UPDATE group_members SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }
  clearHolds(groupId: string): void { this.run('UPDATE group_members SET held = 0 WHERE group_id = ? AND held = 1', groupId); }

  // messages
  insertMessage(m: {
    groupId: string; senderMemberId: string | null; recipients: string[]; kind: GroupMessage['kind']; content: string; requestId?: string | null;
    replyToId?: string | null; sourceMessageId?: string | null; sourceRunId?: string | null; clientMessageId?: string | null;
  }): GroupMessage {
    const id = messageId();
    this.run(`INSERT INTO group_messages(id, group_id, sender_member_id, recipient_member_ids, kind, content, request_id, reply_to_id, source_message_id, source_run_id, client_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, m.groupId, m.senderMemberId, JSON.stringify(m.recipients), m.kind, m.content, m.requestId ?? null,
    m.replyToId ?? null, m.sourceMessageId ?? null, m.sourceRunId ?? null, m.clientMessageId ?? null, nowIso());
    return this.getMessage(id)!;
  }
  getMessage(id: string): GroupMessage | undefined {
    const row = this.get('SELECT * FROM group_messages WHERE id = ?', id);
    return row ? mapMessage(row) : undefined;
  }
  messageByClientId(groupId: string, clientMessageId: string): GroupMessage | undefined {
    const row = this.get('SELECT * FROM group_messages WHERE group_id = ? AND client_message_id = ?', groupId, clientMessageId);
    return row ? mapMessage(row) : undefined;
  }
  recentMessages(groupId: string, limit: number): GroupMessage[] {
    return this.all('SELECT * FROM group_messages WHERE group_id = ? ORDER BY seq DESC LIMIT ?', groupId, limit).reverse().map(mapMessage);
  }
  /** Messages a member sent or was addressed in, newest last. */
  messagesFor(groupId: string, member: string, limit: number): GroupMessage[] {
    return this.all(
      `SELECT * FROM group_messages WHERE group_id = ? AND (sender_member_id = ? OR EXISTS (SELECT 1 FROM json_each(recipient_member_ids) WHERE value = ?))
       ORDER BY seq DESC LIMIT ?`, groupId, member, member, limit,
    ).reverse().map(mapMessage);
  }
  countAddressedAfter(groupId: string, member: string, seq: number): number {
    return Number(this.get(
      `SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ? AND seq > ? AND sender_member_id IS NOT ? AND kind IN ('agent', 'artifact', 'status')
       AND EXISTS (SELECT 1 FROM json_each(recipient_member_ids) WHERE value = ?)`, groupId, seq, member, member,
    )?.n ?? 0);
  }
  maxSeq(groupId: string): number { return Number(this.get('SELECT MAX(seq) AS n FROM group_messages WHERE group_id = ?', groupId)?.n ?? 0); }
  countRunMessages(groupId: string, senderMemberId: string, runId: string, kind: GroupMessage['kind']): number {
    return Number(this.get('SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ? AND sender_member_id = ? AND source_run_id = ? AND kind = ?', groupId, senderMemberId, runId, kind)?.n ?? 0);
  }
  findAgentMessage(groupId: string, sender: string, recipient: string, replyToId: string | null, content: string, request: string): GroupMessage | undefined {
    const row = this.get(
      `SELECT * FROM group_messages WHERE group_id = ? AND kind = 'agent' AND sender_member_id = ? AND request_id = ? AND content = ? AND reply_to_id IS ?
       AND recipient_member_ids = ?`, groupId, sender, request, content, replyToId, JSON.stringify([recipient]),
    );
    return row ? mapMessage(row) : undefined;
  }

  // requests
  insertRequest(r: { id: string; groupId: string; messageId: string; plannerMemberId: string }): void {
    const now = nowIso();
    this.run('INSERT INTO group_requests(id, group_id, message_id, planner_member_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', r.id, r.groupId, r.messageId, r.plannerMemberId, 'active', now, now);
  }
  getRequest(id: string): GroupRequest | undefined {
    const row = this.get('SELECT * FROM group_requests WHERE id = ?', id);
    return row ? mapRequest(row) : undefined;
  }
  requests(groupId: string, limit: number): GroupRequest[] {
    return this.all('SELECT * FROM group_requests WHERE group_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', groupId, limit).reverse().map(mapRequest);
  }
  updateRequest(id: string, patch: { status?: GroupRequest['status']; turnsDelta?: number }): void {
    this.run('UPDATE group_requests SET status = COALESCE(?, status), turns_used = MAX(0, turns_used + ?), updated_at = ? WHERE id = ?', patch.status ?? null, patch.turnsDelta ?? 0, nowIso(), id);
  }
  requestsWithStatus(groupId: string, status: GroupRequest['status']): GroupRequest[] {
    return this.all('SELECT * FROM group_requests WHERE group_id = ? AND status = ?', groupId, status).map(mapRequest);
  }

  // deliveries
  insertDelivery(d: { id: string; groupId: string; requestId: string; messageId: string; memberId: string; kind: DeliveryKind; hop: number; assignmentId?: string | null; taskId?: string | null }): void {
    const now = nowIso();
    this.run(`INSERT INTO group_deliveries(id, group_id, request_id, message_id, member_id, kind, status, hop, assignment_id, task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`, d.id, d.groupId, d.requestId, d.messageId, d.memberId, d.kind, d.hop, d.assignmentId ?? null, d.taskId ?? null, now, now);
  }
  getDelivery(id: string): DeliveryRow | undefined {
    const row = this.get('SELECT * FROM group_deliveries WHERE id = ?', id);
    return row ? mapDelivery(row) : undefined;
  }
  deliveryByRun(runId: string): DeliveryRow | undefined {
    const row = this.get('SELECT * FROM group_deliveries WHERE run_id = ?', runId);
    return row ? mapDelivery(row) : undefined;
  }
  deliveries(groupId: string, statuses?: DeliveryStatus[]): DeliveryRow[] {
    if (!statuses) return this.all('SELECT * FROM group_deliveries WHERE group_id = ? ORDER BY rowid ASC', groupId).map(mapDelivery);
    return this.all(`SELECT * FROM group_deliveries WHERE group_id = ? AND status IN (${placeholders(statuses.length)}) ORDER BY rowid ASC`, groupId, ...statuses).map(mapDelivery);
  }
  recentDeliveries(groupId: string, limit: number): DeliveryRow[] {
    return this.all(`SELECT * FROM (SELECT rowid AS rid, * FROM group_deliveries WHERE group_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rid ASC`, groupId, limit).map(mapDelivery);
  }
  requestDeliveries(requestId: string, statuses?: DeliveryStatus[]): DeliveryRow[] {
    if (!statuses) return this.all('SELECT * FROM group_deliveries WHERE request_id = ? ORDER BY rowid ASC', requestId).map(mapDelivery);
    return this.all(`SELECT * FROM group_deliveries WHERE request_id = ? AND status IN (${placeholders(statuses.length)}) ORDER BY rowid ASC`, requestId, ...statuses).map(mapDelivery);
  }
  memberDeliveries(memberId: string, statuses: DeliveryStatus[]): DeliveryRow[] {
    return this.all(`SELECT * FROM group_deliveries WHERE member_id = ? AND status IN (${placeholders(statuses.length)}) ORDER BY rowid ASC`, memberId, ...statuses).map(mapDelivery);
  }
  /** Most recent start per member, used to schedule fairly. */
  lastStarts(groupId: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of this.all('SELECT member_id, MAX(started_at) AS at FROM group_deliveries WHERE group_id = ? AND started_at IS NOT NULL GROUP BY member_id', groupId)) map.set(row.member_id as string, row.at as string);
    return map;
  }
  setDelivery(id: string, patch: { status?: DeliveryStatus; runId?: string | null; error?: string | null; retryable?: boolean; startedAt?: string; attemptsDelta?: number }): void {
    const sets = ['updated_at = ?'];
    const params: SQLInputValue[] = [nowIso()];
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.runId !== undefined) { sets.push('run_id = ?'); params.push(patch.runId); }
    if (patch.error !== undefined) { sets.push('error = ?'); params.push(patch.error); }
    if (patch.retryable !== undefined) { sets.push('retryable = ?'); params.push(patch.retryable ? 1 : 0); }
    if (patch.startedAt !== undefined) { sets.push('started_at = ?'); params.push(patch.startedAt); }
    if (patch.attemptsDelta) { sets.push('attempts = attempts + ?'); params.push(patch.attemptsDelta); }
    this.run(`UPDATE group_deliveries SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }
  /** Compare-and-set a delivery status; returns whether this caller won the transition. */
  transitionDelivery(id: string, from: DeliveryStatus, to: DeliveryStatus, patch: { runId?: string | null; error?: string | null; retryable?: boolean; startedAt?: string; attemptsDelta?: number } = {}): boolean {
    const sets = ['status = ?', 'updated_at = ?'];
    const params: SQLInputValue[] = [to, nowIso()];
    if (patch.runId !== undefined) { sets.push('run_id = ?'); params.push(patch.runId); }
    if (patch.error !== undefined) { sets.push('error = ?'); params.push(patch.error); }
    if (patch.retryable !== undefined) { sets.push('retryable = ?'); params.push(patch.retryable ? 1 : 0); }
    if (patch.startedAt !== undefined) { sets.push('started_at = ?'); params.push(patch.startedAt); }
    if (patch.attemptsDelta) { sets.push('attempts = attempts + ?'); params.push(patch.attemptsDelta); }
    return this.run(`UPDATE group_deliveries SET ${sets.join(', ')} WHERE id = ? AND status = ?`, ...params, id, from) === 1;
  }

  // assignments
  insertAssignment(a: { id: string; groupId: string; requestId: string; fromMemberId: string; toMemberId: string; taskId: string; deliveryId: string; scope: string[]; fingerprint: string }): void {
    this.run(`INSERT INTO group_assignments(id, group_id, request_id, from_member_id, to_member_id, task_id, delivery_id, scope, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, a.id, a.groupId, a.requestId, a.fromMemberId, a.toMemberId, a.taskId, a.deliveryId, JSON.stringify(a.scope), a.fingerprint, nowIso());
  }
  getAssignment(id: string): AssignmentRow | undefined {
    const row = this.get('SELECT * FROM group_assignments WHERE id = ?', id);
    return row ? mapAssignment(row) : undefined;
  }
  assignmentByTask(groupId: string, taskId: string): AssignmentRow | undefined {
    const row = this.get('SELECT * FROM group_assignments WHERE group_id = ? AND task_id = ? ORDER BY rowid DESC', groupId, taskId);
    return row ? mapAssignment(row) : undefined;
  }
  assignments(groupId: string): AssignmentRow[] {
    return this.all('SELECT * FROM group_assignments WHERE group_id = ? ORDER BY rowid ASC', groupId).map(mapAssignment);
  }
  requestAssignments(requestId: string): AssignmentRow[] {
    return this.all('SELECT * FROM group_assignments WHERE request_id = ? ORDER BY rowid ASC', requestId).map(mapAssignment);
  }
  /** Assignments whose delivery has not reached a settled outcome. */
  activeAssignments(groupId: string): AssignmentRow[] {
    return this.all(
      `SELECT a.* FROM group_assignments a JOIN group_deliveries d ON d.id = a.delivery_id
       WHERE a.group_id = ? AND d.status IN ('queued', 'running', 'failed', 'interrupted') ORDER BY a.rowid ASC`, groupId,
    ).map(mapAssignment);
  }
  markNotified(ids: string[]): void { for (const id of ids) this.run('UPDATE group_assignments SET notified = 1 WHERE id = ?', id); }

  // assignment inputs and artifacts
  insertInput(assignmentId: string, taskId: string, path: string, artifact: string | null): void {
    this.run('INSERT INTO group_assignment_inputs(assignment_id, task_id, path, artifact_id) VALUES (?, ?, ?, ?)', assignmentId, taskId, path, artifact);
  }
  inputs(assignmentId: string): InputRow[] {
    return this.all('SELECT * FROM group_assignment_inputs WHERE assignment_id = ? ORDER BY task_id, path', assignmentId)
      .map((r) => ({ assignmentId: r.assignment_id as string, taskId: r.task_id as string, path: r.path as string, artifactId: (r.artifact_id as string | null) ?? null }));
  }
  setInputArtifact(assignmentId: string, taskId: string, path: string, artifact: string): void {
    this.run('UPDATE group_assignment_inputs SET artifact_id = ? WHERE assignment_id = ? AND task_id = ? AND path = ?', artifact, assignmentId, taskId, path);
  }
  /** Open input rows for assignments targeted at a recipient (used to link a newly published artifact). */
  openInputs(groupId: string, toMemberId: string, taskId: string, path: string): InputRow[] {
    return this.all(
      `SELECT i.* FROM group_assignment_inputs i JOIN group_assignments a ON a.id = i.assignment_id
       WHERE a.group_id = ? AND a.to_member_id = ? AND i.task_id = ? AND i.path = ? AND i.artifact_id IS NULL`, groupId, toMemberId, taskId, path,
    ).map((r) => ({ assignmentId: r.assignment_id as string, taskId: r.task_id as string, path: r.path as string, artifactId: null }));
  }
  insertArtifact(a: Omit<ArtifactRow, 'createdAt'>): void {
    this.run(`INSERT INTO group_artifacts(id, group_id, request_id, from_member_id, to_member_id, task_id, path, commit_id, blob, reference, handoff_event_id, handoff_message_id, message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, a.id, a.groupId, a.requestId, a.fromMemberId, a.toMemberId, a.taskId, a.path, a.commitId, a.blob, a.reference,
    a.handoffEventId, a.handoffMessageId, a.messageId, nowIso());
  }
  getArtifact(id: string): ArtifactRow | undefined {
    const row = this.get('SELECT * FROM group_artifacts WHERE id = ?', id);
    return row ? mapArtifact(row) : undefined;
  }
  findArtifact(groupId: string, from: string, to: string, path: string, commitId: string, taskId: string | null = null): ArtifactRow | undefined {
    const row = this.get('SELECT * FROM group_artifacts WHERE group_id = ? AND from_member_id = ? AND to_member_id = ? AND path = ? AND commit_id = ? AND task_id IS ?', groupId, from, to, path, commitId, taskId);
    return row ? mapArtifact(row) : undefined;
  }
  /** Artifacts that satisfy an exact producer-task / recipient / path reference, newest first. */
  matchingArtifacts(groupId: string, toMemberId: string, taskId: string, path: string): ArtifactRow[] {
    return this.all('SELECT * FROM group_artifacts WHERE group_id = ? AND to_member_id = ? AND task_id = ? AND path = ? ORDER BY rowid DESC', groupId, toMemberId, taskId, path).map(mapArtifact);
  }
}

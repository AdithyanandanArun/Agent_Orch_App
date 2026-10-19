import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AppSettings, Approval, Message, Policy, Project, Provider, RunChanges, RunChangesSummary, Session, SessionStatus, SessionRun, ToolCall, ToolCategory, RunStatus, Task, TaskStatus, WorkspaceEvent } from '@relay/contracts';
import { SCHEMA_VERSION } from './db.ts';
import { newId, nowIso } from './util.ts';

type Row = Record<string, unknown>;

export const DEFAULT_SETTINGS: AppSettings = {
  defaultProvider: 'codex', defaultCodexModel: 'gpt-6.1-sol', defaultClaudeModel: 'claude-sonnet-5-5', defaultEffort: 'high', defaultIsolated: true,
  defaultPolicy: 'supervised', defaultServiceTier: 'standard', theme: 'dark', claudeExecutable: '', codexExecutable: '',
};

export interface NewSession {
  id?: string; projectId: string; name: string; provider: Provider; model: string; effort: Session['effort']; policy: Policy; isolated: boolean;
  worktreePath: string; branch: string | null; status?: SessionStatus; serviceTier?: string;
}

export interface NewTask { id?: string; projectId: string; title: string; description: string; acceptanceCriteria: string; sessionId: string | null; dependsOn: string[]; status: TaskStatus }

export type ChangeListener = (event: WorkspaceEvent | undefined) => void;

const mapProject = (r: Row): Project => ({ id: r.id as string, name: r.name as string, path: r.path as string, createdAt: r.created_at as string, isExample: r.is_example === 1 });
const mapSession = (r: Row): Session => ({
  id: r.id as string, projectId: r.project_id as string, name: r.name as string, provider: r.provider as Provider, model: r.model as string,
  effort: r.effort as Session['effort'], status: r.status as SessionStatus, policy: r.policy as Policy, serviceTier: (r.service_tier as string) ?? 'standard', isolated: r.isolated === 1,
  worktreePath: r.worktree_path as string, branch: (r.branch as string | null) ?? null, providerSessionId: (r.provider_session_id as string | null) ?? null,
  createdAt: r.created_at as string, updatedAt: r.updated_at as string, error: (r.error as string | null) ?? null,
  pinned: r.pinned === 1, unread: r.unread === 1,
  inputTokens: r.input_tokens as number, outputTokens: r.output_tokens as number, costUsd: (r.cost_usd as number | null) ?? null,
});
const mapMessage = (r: Row): Message => {
  const message: Message = { id: r.id as string, sessionId: r.session_id as string, role: r.role as Message['role'], content: r.content as string, createdAt: r.created_at as string };
  if (r.kind) message.kind = r.kind as string;
  if (r.run_id) message.runId = r.run_id as string;
  return message;
};
const mapEvent = (r: Row): WorkspaceEvent => ({
  id: r.id as number, projectId: (r.project_id as string | null) ?? null, sessionId: (r.session_id as string | null) ?? null, type: r.type as string,
  summary: r.summary as string, payload: JSON.parse(r.payload as string) as Record<string, unknown>, createdAt: r.created_at as string,
});
const mapApproval = (r: Row): Approval => ({
  id: r.id as string, sessionId: r.session_id as string, tool: r.tool as string, description: r.description as string,
  input: JSON.parse(r.input as string) as Record<string, unknown>, status: r.status as Approval['status'], createdAt: r.created_at as string,
});

export class Store {
  private listeners = new Set<ChangeListener>();
  private depth = 0;

  constructor(readonly db: DatabaseSync) {}

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Signals that durable state changed without a workspace event (messages, settings, deltas). */
  touch(): void {
    for (const listener of this.listeners) listener(undefined);
  }

  /** Runs `fn` in an IMMEDIATE transaction; nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  // meta
  getMeta(key: string): string | null {
    return (this.get('SELECT value FROM meta WHERE key = ?', key)?.value as string | undefined) ?? null;
  }
  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }
  schemaVersion(): number {
    return SCHEMA_VERSION;
  }

  // projects
  insertProject(input: { id?: string; name: string; path: string; isExample?: boolean }): Project {
    const project: Project = { id: input.id ?? newId('prj'), name: input.name, path: input.path, createdAt: nowIso(), isExample: input.isExample ?? false };
    this.run('INSERT INTO projects(id, name, path, created_at, is_example) VALUES (?, ?, ?, ?, ?)', project.id, project.name, project.path, project.createdAt, project.isExample ? 1 : 0);
    return project;
  }
  renameProject(id: string, name: string): Project {
    this.run('UPDATE projects SET name = ? WHERE id = ?', name, id);
    return this.getProject(id)!;
  }
  getProject(id: string): Project | undefined {
    const row = this.get('SELECT * FROM projects WHERE id = ?', id);
    return row ? mapProject(row) : undefined;
  }
  getProjectByPath(path: string): Project | undefined {
    const row = this.get('SELECT * FROM projects WHERE path = ?', path);
    return row ? mapProject(row) : undefined;
  }
  listProjects(): Project[] {
    return this.all('SELECT * FROM projects ORDER BY is_example ASC, created_at ASC').map(mapProject);
  }

  // sessions
  insertSession(input: NewSession): Session {
    const now = nowIso();
    const id = input.id ?? newId('ses');
    this.run(
      `INSERT INTO sessions(id, project_id, name, provider, model, effort, status, policy, isolated, worktree_path, branch, created_at, updated_at, service_tier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.projectId, input.name, input.provider, input.model, input.effort, input.status ?? 'idle', input.policy, input.isolated ? 1 : 0, input.worktreePath, input.branch, now, now, input.serviceTier ?? 'standard',
    );
    return this.getSession(id)!;
  }
  getSession(id: string, includeArchived = false): Session | undefined {
    const row = this.get(`SELECT * FROM sessions WHERE id = ?${includeArchived ? '' : ' AND archived_at IS NULL'}`, id);
    return row ? mapSession(row) : undefined;
  }
  listSessions(projectId?: string): Session[] {
    const rows = projectId
      ? this.all('SELECT * FROM sessions WHERE archived_at IS NULL AND project_id = ? ORDER BY created_at ASC, rowid ASC', projectId)
      : this.all('SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY created_at ASC, rowid ASC');
    return rows.map(mapSession);
  }
  updateSession(id: string, patch: Partial<Pick<Session, 'name' | 'provider' | 'model' | 'effort' | 'policy' | 'serviceTier' | 'status' | 'error' | 'providerSessionId' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'pinned' | 'unread'>>): Session {
    const columns: Record<string, string> = { name: 'name', provider: 'provider', model: 'model', effort: 'effort', policy: 'policy', serviceTier: 'service_tier', status: 'status', error: 'error', providerSessionId: 'provider_session_id', inputTokens: 'input_tokens', outputTokens: 'output_tokens', costUsd: 'cost_usd', pinned: 'pinned', unread: 'unread' };
    // Organizing a session does not count as conversation activity or change its recency.
    const activityChanged = Object.entries(patch).some(([key, value]) => value !== undefined && key !== 'pinned' && key !== 'unread');
    const sets: string[] = activityChanged ? ['updated_at = ?'] : [];
    const params: SQLInputValue[] = activityChanged ? [nowIso()] : [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(typeof value === 'boolean' ? Number(value) : value as SQLInputValue);
    }
    if (sets.length) this.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    return this.getSession(id, true)!;
  }
  archiveSession(id: string): void {
    this.run('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
  }
  sessionsInStatus(statuses: SessionStatus[]): Session[] {
    return this.all(`SELECT * FROM sessions WHERE archived_at IS NULL AND status IN (${statuses.map(() => '?').join(',')})`, ...statuses).map(mapSession);
  }

  // durable runs and tool invocations
  private mapRun(row: Row): SessionRun {
    const counts = this.all('SELECT category, COUNT(*) AS n FROM tool_calls WHERE run_id = ? GROUP BY category', row.id as string);
    const toolCounts: Partial<Record<ToolCategory, number>> = {};
    for (const item of counts) toolCounts[item.category as ToolCategory] = Number(item.n);
    return { id: row.id as string, sessionId: row.session_id as string, userMessageId: row.user_message_id as string,
      provider: row.provider as Provider, model: row.model as string, status: row.status as RunStatus,
      startedAt: row.started_at as string, finishedAt: row.finished_at as string | null, durationMs: row.duration_ms as number | null,
      toolCount: counts.reduce((sum, item) => sum + Number(item.n), 0), toolCounts,
      changes: row.changes_summary ? JSON.parse(row.changes_summary as string) as RunChangesSummary : null };
  }
  insertRun(input: { id: string; sessionId: string; userMessageId: string; provider: Provider; model: string; startedAt: string }): SessionRun {
    this.run('INSERT INTO session_runs(id, session_id, user_message_id, provider, model, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)', input.id, input.sessionId, input.userMessageId, input.provider, input.model, 'running', input.startedAt);
    return this.getRun(input.id)!;
  }
  getRun(id: string): SessionRun | undefined {
    const row = this.get('SELECT * FROM session_runs WHERE id = ?', id);
    return row ? this.mapRun(row) : undefined;
  }
  finishRun(id: string, status: Exclude<RunStatus, 'running'>, durationMs: number | null, finishedAt = nowIso()): void {
    this.run('UPDATE session_runs SET status = ?, finished_at = ?, duration_ms = ? WHERE id = ? AND status = ?', status, finishedAt, durationMs, id, 'running');
  }
  setRunChanges(id: string, changes: RunChanges): void {
    this.run('UPDATE session_runs SET changes_summary = ?, changes_diff = ?, changes_diff_truncated = ? WHERE id = ?',
      JSON.stringify(changes.summary), changes.diff, Number(changes.diffTruncated), id);
  }
  getRunChanges(id: string): RunChanges | undefined {
    const row = this.get('SELECT changes_summary, changes_diff, changes_diff_truncated FROM session_runs WHERE id = ?', id);
    if (!row?.changes_summary) return undefined;
    return { summary: JSON.parse(row.changes_summary as string) as RunChangesSummary, diff: (row.changes_diff as string | null) ?? '', diffTruncated: row.changes_diff_truncated === 1 };
  }
  bootstrapRuns(limit = 200): SessionRun[] {
    return this.all(`SELECT r.* FROM session_runs r JOIN sessions s ON s.id = r.session_id WHERE s.archived_at IS NULL
      ORDER BY (r.status = 'running') DESC, r.rowid DESC LIMIT ?`, limit).map((row) => this.mapRun(row));
  }
  putToolCall(call: ToolCall): void {
    this.run(`INSERT INTO tool_calls(id, run_id, session_id, provider_id, category, status, data) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider_id) DO UPDATE SET category = excluded.category, status = excluded.status, data = excluded.data`,
      call.id, call.runId, call.sessionId, call.providerId, call.category, call.status, JSON.stringify(call));
  }
  getToolCall(id: string): ToolCall | undefined {
    const row = this.get('SELECT data FROM tool_calls WHERE id = ?', id);
    return row ? JSON.parse(row.data as string) as ToolCall : undefined;
  }
  listRunTools(runId: string, limit = 1000): ToolCall[] {
    return this.all('SELECT data FROM tool_calls WHERE run_id = ? ORDER BY rowid ASC LIMIT ?', runId, limit).map((row) => JSON.parse(row.data as string) as ToolCall);
  }
  bootstrapToolCalls(runIds: string[], limit = 1000): ToolCall[] {
    if (!runIds.length) return [];
    const rows = this.all(`SELECT t.data FROM tool_calls t JOIN session_runs r ON r.id = t.run_id
      WHERE t.run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY (r.status = 'running') DESC, t.rowid DESC LIMIT ?`, ...runIds, limit);
    // Full bounded output is loaded on demand when a tool disclosure opens.
    return rows.reverse().map((row) => { const call = JSON.parse(row.data as string) as ToolCall; return { ...call, input: call.input.slice(0, 4000), output: call.output.slice(-2000), outputTruncated: Boolean(call.outputTruncated || call.output.length > 2000) }; });
  }
  recoverRuns(): void {
    const at = nowIso();
    for (const row of this.all("SELECT id FROM session_runs WHERE status = 'running'")) {
      const id = row.id as string;
      this.finishRun(id, 'interrupted', null, at);
      for (const tool of this.listRunTools(id, 100_000)) {
        if (tool.status === 'running') this.putToolCall({ ...tool, status: 'interrupted', finishedAt: at, durationMs: null });
      }
    }
  }

  // messages
  insertMessage(input: { id?: string; sessionId: string; role: Message['role']; content: string; kind?: string | null; runId?: string }): Message {
    const id = input.id ?? newId('msg');
    const createdAt = nowIso();
    this.run('INSERT INTO messages(id, session_id, role, content, kind, created_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)', id, input.sessionId, input.role, input.content, input.kind ?? null, createdAt, input.runId ?? null);
    return this.getMessage(id)!;
  }
  getMessage(id: string): Message | undefined {
    const row = this.get('SELECT * FROM messages WHERE id = ?', id);
    return row ? mapMessage(row) : undefined;
  }
  updateMessage(id: string, patch: { content?: string; kind?: string | null }): void {
    if (patch.content !== undefined) this.run('UPDATE messages SET content = ? WHERE id = ?', patch.content, id);
    if (patch.kind !== undefined) this.run('UPDATE messages SET kind = ? WHERE id = ?', patch.kind, id);
  }
  listMessages(sessionId: string, options: { limit?: number; beforeId?: string } = {}): Message[] {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000);
    const before = options.beforeId ? (this.get('SELECT seq FROM messages WHERE id = ?', options.beforeId)?.seq as number | undefined) : undefined;
    const rows = before !== undefined
      ? this.all('SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', sessionId, before, limit)
      : this.all('SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?', sessionId, limit);
    return rows.reverse().map(mapMessage);
  }
  /** Most recent `perSession` messages of every active session, oldest first within each session. */
  bootstrapMessages(perSession: number): Message[] {
    const rows = this.all(
      `SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id AND s.archived_at IS NULL
       WHERE m.seq IN (SELECT seq FROM messages m2 WHERE m2.session_id = m.session_id ORDER BY seq DESC LIMIT ?) ORDER BY m.seq ASC`,
      perSession,
    );
    return rows.map(mapMessage);
  }
  unconsumedHandoffs(sessionId: string): Array<Message & { seq: number }> {
    return this.all("SELECT * FROM messages WHERE session_id = ? AND kind = 'handoff' AND consumed_at IS NULL ORDER BY seq ASC", sessionId).map((r) => ({ ...mapMessage(r), seq: r.seq as number }));
  }
  markConsumed(ids: string[]): void {
    const at = nowIso();
    for (const id of ids) this.run('UPDATE messages SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', at, id);
  }
  finalizeStreamingMessages(kind: string): number {
    const rows = this.all("SELECT id FROM messages WHERE kind = 'streaming'");
    for (const row of rows) this.run('UPDATE messages SET kind = ? WHERE id = ?', kind, row.id as string);
    return rows.length;
  }

  // events
  recordEvent(input: { projectId?: string | null; sessionId?: string | null; type: string; summary: string; payload?: Record<string, unknown> }): WorkspaceEvent {
    const createdAt = nowIso();
    const result = this.db.prepare('INSERT INTO events(project_id, session_id, type, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.projectId ?? null, input.sessionId ?? null, input.type, input.summary, JSON.stringify(input.payload ?? {}), createdAt);
    const event = mapEvent(this.get('SELECT * FROM events WHERE id = ?', Number(result.lastInsertRowid))!);
    for (const listener of this.listeners) listener(event);
    return event;
  }
  listEvents(options: { after?: number; projectId?: string; limit?: number } = {}): WorkspaceEvent[] {
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 5000);
    const after = options.after ?? 0;
    const rows = options.projectId
      ? this.all('SELECT * FROM events WHERE id > ? AND (project_id = ? OR project_id IS NULL) ORDER BY id ASC LIMIT ?', after, options.projectId, limit)
      : this.all('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?', after, limit);
    return rows.map(mapEvent);
  }
  recentEvents(limit: number): WorkspaceEvent[] {
    return this.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit).reverse().map(mapEvent);
  }

  // approvals
  insertApproval(input: { sessionId: string; tool: string; description: string; input: Record<string, unknown> }): Approval {
    const id = newId('apr');
    this.run('INSERT INTO approvals(id, session_id, tool, description, input, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, input.sessionId, input.tool, input.description, JSON.stringify(input.input), 'pending', nowIso());
    return this.getApproval(id)!;
  }
  getApproval(id: string): Approval | undefined {
    const row = this.get('SELECT * FROM approvals WHERE id = ?', id);
    return row ? mapApproval(row) : undefined;
  }
  resolveApproval(id: string, status: 'approved' | 'denied', resolution: string): Approval {
    this.run("UPDATE approvals SET status = ?, resolved_at = ?, resolution = ? WHERE id = ? AND status = 'pending'", status, nowIso(), resolution, id);
    return this.getApproval(id)!;
  }
  pendingApprovals(sessionId?: string): Approval[] {
    const rows = sessionId
      ? this.all("SELECT * FROM approvals WHERE status = 'pending' AND session_id = ? ORDER BY created_at ASC, rowid ASC", sessionId)
      : this.all("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC");
    return rows.map(mapApproval);
  }
  bootstrapApprovals(resolvedLimit: number): Approval[] {
    const pending = this.pendingApprovals();
    const resolved = this.all("SELECT * FROM approvals WHERE status <> 'pending' ORDER BY rowid DESC LIMIT ?", resolvedLimit).reverse().map(mapApproval);
    return [...resolved, ...pending];
  }

  // settings
  getSettings(): AppSettings {
    const settings: AppSettings = { ...DEFAULT_SETTINGS };
    for (const row of this.all('SELECT key, value FROM settings')) {
      if ((row.key as string) in settings) (settings as unknown as Record<string, unknown>)[row.key as string] = JSON.parse(row.value as string);
    }
    return settings;
  }
  updateSettings(patch: Partial<AppSettings>): AppSettings {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !(key in DEFAULT_SETTINGS)) continue;
      this.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    }
    return this.getSettings();
  }

  // tasks
  private depsOf(taskId: string): string[] {
    return this.all('SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY rowid ASC', taskId).map((r) => r.depends_on as string);
  }
  private mapTask(r: Row): Task {
    return {
      id: r.id as string, projectId: r.project_id as string, title: r.title as string, description: r.description as string,
      acceptanceCriteria: r.acceptance_criteria as string, sessionId: (r.session_id as string | null) ?? null, dependsOn: this.depsOf(r.id as string),
      status: r.status as TaskStatus, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    };
  }
  insertTask(input: NewTask): Task {
    const id = input.id ?? newId('tsk');
    const now = nowIso();
    this.run('INSERT INTO tasks(id, project_id, title, description, acceptance_criteria, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, input.projectId, input.title, input.description, input.acceptanceCriteria, input.sessionId, input.status, now, now);
    for (const dep of input.dependsOn) this.run('INSERT INTO task_deps(task_id, depends_on) VALUES (?, ?)', id, dep);
    return this.getTask(id)!;
  }
  getTask(id: string): Task | undefined {
    const row = this.get('SELECT * FROM tasks WHERE id = ?', id);
    return row ? this.mapTask(row) : undefined;
  }
  listTasks(projectId?: string): Task[] {
    const rows = projectId ? this.all('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC, rowid ASC', projectId) : this.all('SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC');
    return rows.map((r) => this.mapTask(r));
  }
  updateTask(id: string, patch: { title?: string; description?: string; acceptanceCriteria?: string; sessionId?: string | null; status?: TaskStatus; dependsOn?: string[] }): Task {
    const sets: string[] = ['updated_at = ?'];
    const params: SQLInputValue[] = [nowIso()];
    const columns: Array<[keyof typeof patch, string]> = [['title', 'title'], ['description', 'description'], ['acceptanceCriteria', 'acceptance_criteria'], ['sessionId', 'session_id'], ['status', 'status']];
    for (const [key, column] of columns) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(patch[key] as SQLInputValue);
    }
    this.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    if (patch.dependsOn) {
      this.run('DELETE FROM task_deps WHERE task_id = ?', id);
      for (const dep of patch.dependsOn) this.run('INSERT INTO task_deps(task_id, depends_on) VALUES (?, ?)', id, dep);
    }
    return this.getTask(id)!;
  }
  dependentsOf(taskId: string): Task[] {
    return this.all('SELECT t.* FROM tasks t JOIN task_deps d ON d.task_id = t.id WHERE d.depends_on = ? ORDER BY t.rowid ASC', taskId).map((r) => this.mapTask(r));
  }
  tasksInStatus(status: TaskStatus): Task[] {
    return this.all('SELECT * FROM tasks WHERE status = ?', status).map((r) => this.mapTask(r));
  }
  unassignTasksOfSession(sessionId: string): Task[] {
    const tasks = this.all('SELECT * FROM tasks WHERE session_id = ?', sessionId).map((r) => this.mapTask(r));
    this.run('UPDATE tasks SET session_id = NULL, updated_at = ? WHERE session_id = ?', nowIso(), sessionId);
    return tasks;
  }

  counts(): { projects: number; sessions: number; tasks: number; events: number; pendingApprovals: number } {
    const n = (sql: string) => Number((this.get(sql) as Row).n);
    return {
      projects: n('SELECT COUNT(*) AS n FROM projects'),
      sessions: n('SELECT COUNT(*) AS n FROM sessions WHERE archived_at IS NULL'),
      tasks: n('SELECT COUNT(*) AS n FROM tasks'),
      events: n('SELECT COUNT(*) AS n FROM events'),
      pendingApprovals: n("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'"),
    };
  }

  close(): void {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    this.db.close();
  }
}

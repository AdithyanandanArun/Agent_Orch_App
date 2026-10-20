import type { Project, ProjectContext, ProviderTaskPlan, Session, Task, WorkspaceEvent } from '@relay/contracts';
import type { Store } from '../store.ts';
import type { TaskService } from '../tasks.ts';
import type { Logger } from '../types.ts';
import { errorMessage, notFound, nowIso, redactSecrets } from '../util.ts';
import { contextSignature, describeContextChange } from './change.ts';
import { LIMITS } from './limits.ts';
import { applyProviderPlan } from './plans.ts';
import { classifyPrompt } from './requests.ts';
import { syncChanged, syncPayload, syncRepositoryTasks } from './reposync.ts';
import type { RepoSyncSummary } from './reposync.ts';
import { scanProject } from './scan.ts';
import type { ScanResult } from './scan.ts';
import { TaskOps } from './taskops.ts';

export interface ProjectIntelligenceOptions {
  store: Store; tasks: TaskService; log: Logger;
  /** Periodic outside-edit refresh; defaults to 30 s. */
  intervalMs?: number;
  /** Quiet period that coalesces bursts of change events; defaults to 800 ms. */
  debounceMs?: number;
}

type Outcome = 'completed' | 'failed' | 'interrupted';

interface Deferred { promise: Promise<ProjectContext>; resolve: (context: ProjectContext) => void }
interface ProjectState { active: Promise<void> | null; next: Deferred | null; lastDurationMs: number; lastFinishedAt: number }

const MAX_WAIT_MS = 5_000;
const RUN_FINISHED = /^session\.run\.(?:completed|failed|interrupted)$/;
const EXAMPLE_NOTICE = 'Example workspace: automatic indexing and task tracking are off. Open your own project to have Relay map it and track its work.';

const deferred = (): Deferred => {
  let resolve!: (context: ProjectContext) => void;
  const promise = new Promise<ProjectContext>((done) => { resolve = done; });
  return { promise, resolve };
};

/**
 * Keeps a project's map and task list in step with reality: a bounded static scan of the folder, the Git state, the
 * requests sessions actually run, and the plans native providers actually report. It never runs project scripts or
 * models, never edits project files, and every automatic task change defers to fields a person has changed by hand.
 */
export class ProjectIntelligenceService {
  private readonly store: Store;
  private readonly tasks: TaskService;
  private readonly log: Logger;
  private readonly ops: TaskOps;
  private readonly intervalMs: number;
  private readonly debounceMs: number;
  private closed = false;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private tickRunning = false;
  private readonly states = new Map<string, ProjectState>();
  private readonly debounce = new Map<string, { timer: NodeJS.Timeout; firstAt: number }>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly scanTimes = new Map<string, string>();
  /** Parent task of each live run: an explicit task, or the request task this service tracked for it. */
  private readonly runParents = new Map<string, { taskId: string; explicit: boolean }>();

  constructor(options: ProjectIntelligenceOptions) {
    this.store = options.store;
    this.tasks = options.tasks;
    this.log = options.log;
    this.ops = new TaskOps(this.store, this.tasks);
    this.intervalMs = options.intervalMs ?? LIMITS.periodicIntervalMs;
    this.debounceMs = options.debounceMs ?? LIMITS.debounceMs;
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event));
    this.guard('reconcile interrupted runs', () => this.reconcile());
    const startup = (async () => {
      for (const project of this.store.listProjects()) {
        if (this.closed) return;
        if (!project.isExample) await this.refresh(project.id);
      }
    })().catch((error) => this.log('warn', 'Project intelligence startup scan failed', error));
    this.track(startup);
    this.timer = setInterval(() => this.track(this.tick()), this.intervalMs);
    this.timer.unref();
  }

  /** Stops the timer and event subscription, drops queued work, then waits for scans already running before the database closes. */
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const entry of this.debounce.values()) clearTimeout(entry.timer);
    this.debounce.clear();
    for (const state of this.states.values()) {
      const queued = state.next;
      state.next = null;
      queued?.resolve(this.placeholderFor(undefined));
    }
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private track<T>(promise: Promise<T>): void {
    const tracked = promise.catch(() => undefined).finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  private guard(what: string, fn: () => void): void {
    try { fn(); } catch (error) { this.log('warn', `Project intelligence failed to ${what}`, error); }
  }

  private emit(projectId: string, sessionId: string | null, type: string, summary: string, payload: Record<string, unknown>): WorkspaceEvent | null {
    if (this.closed) return null;
    return this.store.recordEvent({ projectId, sessionId, type, summary, payload });
  }

  // ---- context ---------------------------------------------------------------------------------------------------

  private requireProject(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw notFound('Project not found');
    return project;
  }

  private placeholderFor(project: Project | undefined, status: ProjectContext['status'] = 'indexing', notices: string[] = []): ProjectContext {
    return {
      projectId: project?.id ?? '', status, scannedAt: null, root: project?.path ?? '', isRepo: false, branch: null, head: null, fileCount: 0,
      components: [], languages: [], recentCommits: [], changedPaths: [], taskCount: project && !this.closed ? this.ops.sourcedCount(project.id) : 0, notices, error: null,
    };
  }

  /** The stored map for a project. Before the first scan completes it reports `indexing`; example workspaces are never indexed. */
  context(projectId: string): ProjectContext {
    const project = this.requireProject(projectId);
    if (project.isExample) return this.placeholderFor(project, 'ready', [EXAMPLE_NOTICE]);
    const stored = this.store.getProjectContext(projectId);
    if (!stored) return this.placeholderFor(project);
    return { ...stored, scannedAt: this.scanTimes.get(projectId) ?? stored.scannedAt, taskCount: this.ops.sourcedCount(projectId) };
  }

  /** Scans now (coalescing with any scan already queued for the project) and resolves with the resulting context. */
  refresh(projectId: string): Promise<ProjectContext> {
    let project: Project;
    try { project = this.requireProject(projectId); } catch (error) { return Promise.reject(error); }
    if (project.isExample || this.closed) return Promise.resolve(this.safeContext(projectId));
    const state = this.stateFor(projectId);
    state.next ??= deferred();
    const promise = state.next.promise;
    this.pump(projectId, state);
    return promise;
  }

  private safeContext(projectId: string): ProjectContext {
    try { return this.context(projectId); } catch { return this.placeholderFor(undefined); }
  }

  private stateFor(projectId: string): ProjectState {
    let state = this.states.get(projectId);
    if (!state) { state = { active: null, next: null, lastDurationMs: 0, lastFinishedAt: 0 }; this.states.set(projectId, state); }
    return state;
  }

  /** Per-project serialisation: at most one scan runs and at most one more waits, however many callers ask. */
  private pump(projectId: string, state: ProjectState): void {
    if (state.active || !state.next || this.closed) return;
    const job = state.next;
    state.next = null;
    const startedAt = Date.now();
    const active: Promise<void> = (async () => {
      try {
        job.resolve(await this.scan(projectId));
      } catch (error) {
        this.log('error', `Project scan failed for ${projectId}`, error);
        job.resolve(this.safeContext(projectId));
      }
    })().finally(() => {
      state.active = null;
      state.lastDurationMs = Date.now() - startedAt;
      state.lastFinishedAt = Date.now();
      this.inflight.delete(active);
      this.pump(projectId, state);
    });
    state.active = active;
    this.inflight.add(active);
  }

  private async scan(projectId: string): Promise<ProjectContext> {
    const project = this.requireProject(projectId);
    const previous = this.store.getProjectContext(projectId);
    let result: ScanResult;
    try {
      result = await scanProject(project.path, () => this.closed);
    } catch (error) {
      return this.recordScanFailure(project, previous, error);
    }
    if (this.closed) return previous ?? this.placeholderFor(undefined);

    let sync: RepoSyncSummary | null = null;
    const notices = [...result.context.notices];
    try {
      sync = this.store.tx(() => syncRepositoryTasks(this.store, this.ops, projectId, result));
      notices.push(...sync.notices);
    } catch (error) {
      this.log('warn', `Repository task sync failed for ${projectId}`, error);
      notices.push(`Repository tasks could not be updated: ${redactSecrets(errorMessage(error))}`);
    }

    const now = nowIso();
    const context: ProjectContext = { ...result.context, projectId, notices, status: 'ready', scannedAt: now, taskCount: this.ops.sourcedCount(projectId), error: null };
    const changed = !previous || contextSignature(previous) !== contextSignature(context);
    this.scanTimes.set(projectId, now);
    if (changed) {
      this.store.setProjectContext(projectId, context);
      const change = describeContextChange(previous, context);
      this.emit(projectId, null, 'project.context.updated', change.summary, change.payload);
    }
    if (sync && syncChanged(sync)) {
      const parts = [
        sync.created.length && `${sync.created.length} new`, sync.completed.length && `${sync.completed.length} completed`, sync.reopened.length && `${sync.reopened.length} reopened`,
        sync.missing.length && `${sync.missing.length} no longer in source`, sync.restored.length && `${sync.restored.length} back in source`,
      ].filter(Boolean);
      this.emit(projectId, null, 'task.auto.repository', `Repository tasks synced: ${parts.join(', ')}`, syncPayload(sync));
    }
    if (!this.closed) this.ops.flush();
    return this.context(projectId);
  }

  private recordScanFailure(project: Project, previous: ProjectContext | undefined, error: unknown): ProjectContext {
    const message = redactSecrets(errorMessage(error)).slice(0, 300);
    if (this.closed) return previous ?? this.placeholderFor(undefined);
    const base = previous ?? this.placeholderFor(project, 'error');
    const context: ProjectContext = { ...base, projectId: project.id, root: project.path, status: 'error', error: message, taskCount: this.ops.sourcedCount(project.id) };
    if (previous?.status !== 'error' || previous.error !== message) {
      this.store.setProjectContext(project.id, context);
      this.emit(project.id, null, 'project.context.updated', `Project scan failed: ${message}`, { error: message });
    }
    return context;
  }

  // ---- change detection ------------------------------------------------------------------------------------------

  private onEvent(event: WorkspaceEvent | undefined): void {
    if (this.closed || !event?.projectId) return;
    const { type } = event;
    // Never react to our own output: that would turn every scan into the trigger for the next one.
    if (type.startsWith('project.context.') || type.startsWith('task.auto.')) return;
    if (type === 'project.created' || type === 'project.restored' || type.startsWith('repository.')) return this.schedule(event.projectId);
    if (type === 'file.saved' || RUN_FINISHED.test(type)) {
      // Isolated sessions edit their own worktree, so the project folder itself did not change.
      const session = event.sessionId ? this.store.getSession(event.sessionId, true) : undefined;
      if (!session?.isolated) this.schedule(event.projectId);
    }
  }

  private schedule(projectId: string): void {
    if (this.closed) return;
    const project = this.store.getProject(projectId);
    if (!project || project.isExample) return;
    const now = Date.now();
    const pending = this.debounce.get(projectId);
    if (pending && now - pending.firstAt >= MAX_WAIT_MS) return; // a continuous burst still scans within MAX_WAIT_MS
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      this.debounce.delete(projectId);
      this.track(this.refresh(projectId));
    }, this.debounceMs);
    timer.unref();
    this.debounce.set(projectId, { timer, firstAt: pending?.firstAt ?? now });
  }

  private async tick(): Promise<void> {
    if (this.closed || this.tickRunning) return;
    this.tickRunning = true;
    try {
      this.guard('reconcile interrupted runs', () => this.reconcile());
      for (const project of this.store.listProjects()) {
        if (this.closed) return;
        if (project.isExample) continue;
        const state = this.stateFor(project.id);
        // Slow projects are scanned less often so the periodic refresh stays a small, bounded cost.
        const due = Date.now() - state.lastFinishedAt >= Math.max(this.intervalMs, state.lastDurationMs * 4);
        if (due && !state.active && !state.next && !this.debounce.has(project.id)) await this.refresh(project.id);
      }
    } finally {
      this.tickRunning = false;
    }
  }

  /** Auto-tracked tasks still `running` for a run that is no longer live (server restart, missed finalisation) return to pending. */
  private reconcile(): void {
    for (const project of this.store.listProjects()) {
      if (project.isExample) continue;
      const stale = [...this.ops.sourced(project.id, 'request'), ...this.ops.sourced(project.id, 'provider')]
        .filter((task) => task.status === 'running' && (!task.source?.runId || this.store.getRun(task.source.runId)?.status !== 'running'));
      const moved = this.store.tx(() => stale.map((task) => this.ops.setStatus(task, 'ready', { blockedFallback: true })).filter((task): task is Task => Boolean(task)));
      if (moved.length) {
        this.ops.markDirty();
        this.emit(project.id, null, 'task.auto.run', `Run no longer active: ${moved.length} tracked task${moved.length === 1 ? '' : 's'} returned to pending`, { outcome: 'interrupted', tasks: moved.slice(0, 20).map((task) => ({ taskId: task.id, title: task.title, status: task.status })) });
      }
    }
    this.ops.flush();
  }

  // ---- request and plan tracking ---------------------------------------------------------------------------------

  /**
   * Called when a run actually starts. Returns the task the run belongs to: the explicit task, a reused unresolved
   * request task (simple "continue" follow-ups), or a newly created request task. Acknowledgements, questions and
   * slash commands create nothing. The explicit task's own status stays with TaskService.
   */
  trackRequest(session: Session, runId: string, prompt: string, explicitTaskId?: string): string | null {
    try {
      if (explicitTaskId) {
        const explicit = this.store.getTask(explicitTaskId);
        if (explicit && explicit.projectId === session.projectId) {
          this.rememberRun(runId, { taskId: explicit.id, explicit: true });
          return explicit.id;
        }
      }
      const project = this.store.getProject(session.projectId);
      if (!project || project.isExample || this.closed) return null;
      const classified = classifyPrompt(prompt);
      if (classified.kind === 'ignore') return null;
      const tracked = this.store.tx(() => {
        let task: Task | null = null;
        if (classified.kind === 'continue') {
          task = this.latestUnresolvedRequest(session);
          if (!task) return null;
        } else {
          const base = `request:${session.id}:${classified.fingerprint}`;
          for (let ordinal = 1; ordinal <= 50 && !task; ordinal++) {
            const key = ordinal === 1 ? base : `${base}#${ordinal}`;
            const existing = this.store.findSourcedTask(session.projectId, key);
            if (!existing) return this.createRequestTask(session, runId, prompt, classified.title, key);
            if (existing.status !== 'done') task = existing;
          }
          if (!task) return null;
        }
        return this.resumeRequestTask(task, session, runId);
      });
      this.ops.flush();
      return tracked;
    } catch (error) {
      this.log('warn', 'Project intelligence could not track the request', error);
      return explicitTaskId ?? null;
    }
  }

  private rememberRun(runId: string, parent: { taskId: string; explicit: boolean }): void {
    if (this.runParents.size >= 500) this.runParents.delete(this.runParents.keys().next().value!);
    this.runParents.set(runId, parent);
  }

  private latestUnresolvedRequest(session: Session): Task | null {
    const candidates = this.ops.sourced(session.projectId, 'request').filter((task) => task.sessionId === session.id && task.status !== 'done' && !task.source?.missing);
    // Order by when the request's latest run actually started, so renaming an old request by hand cannot make it "latest".
    const workedAt = (task: Task) => (task.source?.runId ? this.store.getRun(task.source.runId)?.startedAt : undefined) ?? task.createdAt;
    return candidates.reduce<Task | null>((best, task) => (!best || workedAt(task) >= workedAt(best) ? task : best), null);
  }

  private createRequestTask(session: Session, runId: string, prompt: string, title: string, key: string): string {
    const created = this.store.insertTask({
      projectId: session.projectId, title: redactSecrets(title).slice(0, 200), description: redactSecrets(prompt.trim()).slice(0, 4000), acceptanceCriteria: '',
      sessionId: session.id, dependsOn: [], status: 'running',
    });
    this.store.setTaskSource(created.id, { kind: 'request', key, runId, reportedStatus: 'in_progress' });
    this.rememberRun(runId, { taskId: created.id, explicit: false });
    this.emit(session.projectId, session.id, 'task.auto.created', `Request tracked: ${created.title}`, { taskId: created.id, runId, kind: 'request' });
    return created.id;
  }

  private resumeRequestTask(task: Task, session: Session, runId: string): string {
    this.ops.patchSource(task, { runId, reportedStatus: 'in_progress', missing: false });
    const moved = this.ops.setStatus(task, 'running');
    this.rememberRun(runId, { taskId: task.id, explicit: false });
    if (moved) this.emit(session.projectId, session.id, 'task.auto.running', `Request resumed: ${task.title}`, { taskId: task.id, runId });
    return task.id;
  }

  /** Applies a validated native provider plan; steps become tasks keyed by the provider's own plan and step identities. */
  applyPlan(session: Session, runId: string, plan: ProviderTaskPlan): void {
    try {
      const project = this.store.getProject(session.projectId);
      if (!project || project.isExample || this.closed) return;
      const parentTaskId = this.parentTaskOf(session.projectId, runId);
      const summary = this.store.tx(() => applyProviderPlan(this.store, this.ops, session, runId, plan, parentTaskId));
      this.ops.flush();
      if (!summary.changed) return;
      const parts = [summary.created.length && `${summary.created.length} new`, summary.updated.length && `${summary.updated.length} updated`, summary.missing.length && `${summary.missing.length} dropped from the plan`].filter(Boolean);
      const brief = (tasks: Task[]) => tasks.slice(0, 20).map((task) => ({ taskId: task.id, title: task.title, status: task.status }));
      this.emit(session.projectId, session.id, 'task.auto.plan', `Provider plan: ${parts.join(', ')}`, {
        runId, planId: plan.planId, parentTaskId: parentTaskId ?? null, created: brief(summary.created), updated: brief(summary.updated), missing: brief(summary.missing),
      });
    } catch (error) {
      this.log('warn', 'Project intelligence could not apply the provider plan', error);
    }
  }

  private parentTaskOf(projectId: string, runId: string): string | undefined {
    return this.runParents.get(runId)?.taskId ?? this.ops.sourced(projectId, 'request', runId)[0]?.id;
  }

  /**
   * Called as a run finalises. A successful turn leaves tracked work for review (never done); a failed or interrupted
   * one returns it to pending. An explicit task's own status was already handled by TaskService and is not touched.
   */
  finishRun(session: Session, runId: string, outcome: Outcome): void {
    const parent = this.runParents.get(runId);
    this.runParents.delete(runId);
    try {
      const project = this.store.getProject(session.projectId);
      if (!project || project.isExample || this.closed) return;
      const moved = this.store.tx(() => {
        const changed: Task[] = [];
        for (const task of [...this.ops.sourced(session.projectId, 'request', runId), ...this.ops.sourced(session.projectId, 'provider', runId)]) {
          if (task.id === parent?.taskId && parent.explicit) continue;
          if (task.source!.kind === 'request') this.ops.patchSource(task, { reportedStatus: outcome === 'completed' ? 'completed' : 'pending' });
          if (task.status !== 'running') continue;
          // A step still in progress when a turn succeeds needs a person's look (review); after a failure or interruption it is pending again.
          const next = this.ops.setStatus(task, outcome === 'completed' ? 'review' : 'ready', { blockedFallback: true });
          if (next) changed.push(next);
        }
        return changed;
      });
      this.ops.flush();
      if (!moved.length) return;
      const first = moved[0]!;
      const label = outcome === 'completed' ? 'Ready for review' : `Run ${outcome}, left pending`;
      this.emit(session.projectId, session.id, 'task.auto.run', `${label}: ${first.title}${moved.length > 1 ? ` (+${moved.length - 1} more)` : ''}`, {
        runId, outcome, tasks: moved.slice(0, 20).map((task) => ({ taskId: task.id, title: task.title, status: task.status })),
      });
    } catch (error) {
      this.log('warn', 'Project intelligence could not finish run tracking', error);
    }
  }
}

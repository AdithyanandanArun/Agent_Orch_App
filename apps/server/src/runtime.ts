import { existsSync, statSync } from 'node:fs';
import type { AdapterEvent, Approval, Message, Session } from '@relay/contracts';
import type { Hub } from './hub.ts';
import type { Store } from './store.ts';
import type { TaskService } from './tasks.ts';
import type { Logger, ProviderRuntime } from './types.ts';
import { conflict, errorMessage, notFound, redactSecrets, truncate } from './util.ts';

export interface RuntimeOptions {
  /** Milliseconds to wait after an abort before declaring an unresponsive adapter interrupted. */
  abortGraceMs?: number;
  /** Interval for persisting streamed assistant text. */
  flushIntervalMs?: number;
}

interface ActiveRun {
  sessionId: string;
  controller: AbortController;
  closed: boolean;
  cleanupPending: boolean;
  approvals: Map<string, (allowed: boolean) => void>;
  stream: { messageId: string; text: string; dirty: boolean } | null;
  flushTimer: NodeJS.Timeout | null;
  consumedHandoffs: string[];
  firstEvent: boolean;
  baseInput: number;
  baseOutput: number;
  baseCost: number | null;
  taskId: string | null;
  promise: Promise<void>;
}

export interface StartOptions { taskId?: string; userMessage?: { content: string; kind?: string } }

const MAX_TOOL_CHARS = 20_000;
const MAX_APPROVAL_INPUT_CHARS = 20_000;

export class SessionRuntime {
  private readonly active = new Map<string, ActiveRun>();
  private readonly abortGraceMs: number;
  private readonly flushIntervalMs: number;

  constructor(
    private readonly store: Store, private readonly hub: Hub, private readonly providers: ProviderRuntime, private readonly tasks: TaskService,
    private readonly log: Logger, options: RuntimeOptions = {},
  ) {
    // Covers the supported adapters' interrupt grace and escalating process shutdown.
    this.abortGraceMs = options.abortGraceMs ?? 30_000;
    this.flushIntervalMs = options.flushIntervalMs ?? 300;
  }

  activeCount(): number {
    return this.active.size;
  }
  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /**
   * Starts an asynchronous provider run. All validation and bookkeeping is synchronous and the session is registered as
   * active before any await, so two concurrent requests can never both start a provider Promise for one session.
   */
  start(sessionId: string, content: string, options: StartOptions = {}): void {
    const session = this.store.getSession(sessionId);
    if (!session) throw notFound('Session not found');
    if (this.active.has(sessionId) || session.status === 'running' || session.status === 'waiting') throw conflict('Session already has an active run or provider cleanup is still in progress');
    if (!existsSync(session.worktreePath) || !statSync(session.worktreePath).isDirectory()) throw conflict('The session worktree no longer exists on disk');

    const handoffs = this.store.unconsumedHandoffs(sessionId);
    const prompt = this.composePrompt(handoffs, content);
    const run: ActiveRun = {
      sessionId, controller: new AbortController(), closed: false, cleanupPending: false, approvals: new Map(), stream: null, flushTimer: null, consumedHandoffs: handoffs.map((h) => h.id), firstEvent: false,
      baseInput: session.inputTokens, baseOutput: session.outputTokens, baseCost: session.costUsd, taskId: options.taskId ?? null, promise: Promise.resolve(),
    };
    this.store.tx(() => {
      this.store.insertMessage({ sessionId, role: 'user', content: options.userMessage?.content ?? content, kind: options.userMessage?.kind ?? null });
      this.store.updateSession(sessionId, { status: 'running', error: null });
      if (options.taskId) {
        const task = this.store.getTask(options.taskId);
        if (task) this.tasks.markRunning(task);
      }
      this.store.recordEvent({ projectId: session.projectId, sessionId, type: 'session.run.started', summary: `Run started: ${session.name}`, payload: { provider: session.provider, model: session.model, taskId: options.taskId ?? null, handoffsIncluded: handoffs.length } });
    });
    this.active.set(sessionId, run);
    run.promise = this.execute(run, session, prompt);
  }

  private composePrompt(handoffs: Message[], content: string): string {
    if (!handoffs.length) return content;
    const blocks = handoffs.map((h) => h.content.trim());
    return ['[Relay context — artifacts handed off to this session since your last turn]', ...blocks, '[End of handed-off context]', '', content].join('\n\n');
  }

  private async execute(run: ActiveRun, startSession: Session, prompt: string): Promise<void> {
    let outcome: 'completed' | 'failed' | 'interrupted' = 'completed';
    let failure: string | null = null;
    try {
      const adapter = this.providers.createAdapter(startSession.provider);
      const session = this.store.getSession(run.sessionId) ?? startSession;
      const adapterRun = Promise.resolve().then(() => adapter.run({
        session, prompt, signal: run.controller.signal, settings: this.store.getSettings(),
        onEvent: (event) => this.handleEvent(run, event),
        requestApproval: (request) => this.requestApproval(run, request),
      }));
      const grace = new Promise<'grace'>((resolve) => {
        run.controller.signal.addEventListener('abort', () => setTimeout(() => resolve('grace'), this.abortGraceMs).unref(), { once: true });
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
        failure = truncate(redactSecrets(errorMessage(error)), 4000);
      }
    }
    this.finish(run, outcome, failure);
  }

  private releaseAfterCleanup(run: ActiveRun): void {
    run.cleanupPending = false;
    if (run.closed && this.active.get(run.sessionId) === run) this.active.delete(run.sessionId);
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
        case 'session':
          if (event.providerSessionId) this.store.updateSession(run.sessionId, { providerSessionId: event.providerSessionId });
          break;
        case 'text':
          if (!event.text) return;
          this.appendText(run, event.text);
          break;
        case 'tool': {
          this.closeStream(run, null);
          this.store.insertMessage({ sessionId: run.sessionId, role: 'tool', kind: 'tool', content: truncate(redactSecrets(`${event.name}${event.content ? `\n${event.content}` : ''}`), MAX_TOOL_CHARS) });
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
          this.store.insertMessage({ sessionId: run.sessionId, role: 'system', kind: 'info', content: truncate(redactSecrets(event.content), MAX_TOOL_CHARS) });
          this.store.touch();
          break;
      }
    } catch (error) {
      this.log('error', `Failed to record adapter event for ${run.sessionId}`, error);
    }
  }

  private appendText(run: ActiveRun, text: string): void {
    const offset = run.stream?.text.length ?? 0;
    if (!run.stream) {
      const message = this.store.insertMessage({ sessionId: run.sessionId, role: 'assistant', content: text, kind: 'streaming' });
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

  private finish(run: ActiveRun, outcome: 'completed' | 'failed' | 'interrupted', failure: string | null): void {
    run.closed = true;
    this.denyApprovals(run, outcome === 'completed' ? 'run finished' : outcome);
    try {
      this.store.tx(() => {
        this.closeStream(run, outcome === 'completed' ? null : 'partial');
        const session = this.store.getSession(run.sessionId, true);
        if (!session) return;
        if (outcome === 'failed') {
          this.store.insertMessage({ sessionId: run.sessionId, role: 'system', kind: 'error', content: `Run failed: ${failure}` });
          this.store.updateSession(run.sessionId, { status: 'error', error: failure });
        } else if (outcome === 'interrupted') {
          this.store.insertMessage({ sessionId: run.sessionId, role: 'system', kind: 'info', content: 'Run interrupted.' });
          this.store.updateSession(run.sessionId, { status: 'interrupted', error: null });
        } else {
          this.consumeHandoffsOnce(run);
          this.store.updateSession(run.sessionId, { status: 'idle', error: null });
        }
        if (outcome === 'completed' && !run.firstEvent) this.store.markConsumed(run.consumedHandoffs);
        if (run.taskId) this.tasks.finishRun(run.taskId, outcome);
        this.store.recordEvent({
          projectId: session.projectId, sessionId: run.sessionId, type: `session.run.${outcome}`,
          summary: outcome === 'completed' ? `Run completed: ${session.name}` : outcome === 'failed' ? `Run failed: ${session.name}` : `Run interrupted: ${session.name}`,
          payload: { taskId: run.taskId, ...(failure ? { error: failure } : {}) },
        });
      });
    } catch (error) {
      this.log('error', `Failed to finalise run for ${run.sessionId}`, error);
    } finally {
      if (!run.cleanupPending) this.active.delete(run.sessionId);
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

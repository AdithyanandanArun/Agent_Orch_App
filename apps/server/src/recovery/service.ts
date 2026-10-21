import { randomUUID } from 'node:crypto';
import { RecoveryCheckpointSchema, ProviderFailureSchema } from '@mingle/contracts';
import type { ProviderFailure, RecoveryCheckpoint } from '@mingle/contracts';
import { git } from '../repository/git-run.ts';
import type { Store } from '../store.ts';
import { badRequest, nowIso, redactSecrets } from '../util.ts';

const MAX_CHECKPOINT_BYTES = 64 * 1024;
const MAX_FAILURE_BYTES = 8 * 1024;
const MAX_DIRTY_PATHS = 500;
const shortId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const safeText = (value: unknown, max: number): string => redactSecrets(typeof value === 'string' ? value : String(value ?? '')).slice(0, max);

interface GitSnapshot {
  branch: string | null; head: string | null; dirtyPaths: string[]; dirtyPathsTruncated: boolean;
  isRepository: boolean; statusKnown: boolean; notices: string[];
}

/** Persists small recovery references and redacted outcomes without capturing file contents or tool inputs. */
export class RecoveryService {
  private readonly pendingCaptures = new Set<Promise<RecoveryCheckpoint>>();

  constructor(private readonly store: Store) {}

  capture(sessionId: string, reason: string, runId?: string): Promise<RecoveryCheckpoint> {
    const pending = this.captureNow(sessionId, reason, runId);
    this.pendingCaptures.add(pending);
    void pending.finally(() => this.pendingCaptures.delete(pending)).catch(() => undefined);
    return pending;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pendingCaptures]);
  }

  private async captureNow(sessionId: string, reason: string, runId?: string): Promise<RecoveryCheckpoint> {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 200) throw badRequest('Checkpoint reason must be 1–200 characters');
    const session = this.store.getSession(sessionId, true);
    if (!session) throw badRequest('Session does not exist');
    if (runId) {
      const run = this.store.getRun(runId);
      if (!run || run.sessionId !== sessionId) throw badRequest('Run does not belong to this session');
    }

    const latestObjective = this.store.recoveryLatestUserMessage(sessionId)?.trim();
    const tasks = this.store.recoveryTasksForSession(sessionId).map((task) => ({
        id: safeText(task.id, 100), title: safeText(task.title, 300), description: safeText(task.description, 1000),
        acceptanceCriteria: safeText(task.acceptanceCriteria, 1000), status: task.status,
      }));
    const pendingApprovals = this.store.recoveryPendingApprovals(sessionId).slice(0, 100).map((approval) => ({
      id: safeText(approval.id, 100), tool: safeText(approval.tool, 200), description: safeText(approval.description, 1000),
    }));
    const errors = this.store.recoveryErrorMessages(sessionId, 20).map((entry) => ({
      id: safeText(entry.id, 100), message: safeText(entry.content, 1000), ...(entry.runId ? { runId: safeText(entry.runId, 100) } : {}),
    }));
    if (session.error && !errors.some((entry) => entry.message === safeText(session.error, 1000))) {
      errors.push({ id: `session_${sessionId}`, message: safeText(session.error, 1000) });
    }
    const uncertainTools = this.store.recoveryToolSummaries(sessionId, 100).map((tool) => ({
      id: safeText(tool.id, 100), name: safeText(tool.name, 200), status: tool.status, summary: safeText(tool.summary, 1000),
    }));
    const artifacts = this.store.recoveryArtifactReferences(sessionId, 100).map((artifact) => ({
      id: safeText(artifact.id, 100), path: safeText(artifact.path, 4096), revision: safeText(artifact.revision, 100),
      taskId: artifact.taskId ? safeText(artifact.taskId, 100) : null,
    }));
    const gitState = await this.gitSnapshot(session.worktreePath);
    const checkpoint = RecoveryCheckpointSchema.parse({
      id: shortId('chk'), version: 1, sessionId, ...(runId ? { runId } : {}), reason: safeText(reason.trim(), 200), capturedAt: nowIso(),
      objective: latestObjective ? safeText(latestObjective, 1000) : null, tasks,
      worktree: {
        path: safeText(session.worktreePath, 4096), branch: gitState.branch, head: gitState.head,
        dirtyPaths: gitState.dirtyPaths, dirtyPathsTruncated: gitState.dirtyPathsTruncated,
        isRepository: gitState.isRepository, statusKnown: gitState.statusKnown,
      },
      artifacts, pendingApprovals, errors: errors.slice(-100), uncertainTools,
      notices: gitState.notices.slice(0, 20),
    });
    const bounded = this.boundCheckpoint(checkpoint);
    this.store.insertRecoveryCheckpoint(bounded);
    return bounded;
  }

  latest(sessionId: string): RecoveryCheckpoint | null {
    const checkpoint = this.store.latestRecoveryCheckpoint(sessionId);
    return checkpoint ? RecoveryCheckpointSchema.parse(checkpoint) : null;
  }

  recordFailure(sessionId: string, runId: string, failure: ProviderFailure): void {
    if (!runId || runId.length > 100) throw badRequest('A valid run ID is required for a provider failure');
    const run = this.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) throw badRequest('Provider failure run does not belong to this session');
    const parsed = ProviderFailureSchema.parse({ ...failure, sessionId, runId });
    const occurredAt = new Date(parsed.occurredAt);
    const retryAt = parsed.retryAt ? new Date(parsed.retryAt) : null;
    const boundedRetryAt = retryAt && Number.isFinite(retryAt.getTime()) && retryAt.getTime() >= occurredAt.getTime() && retryAt.getTime() <= occurredAt.getTime() + 86_400_000
      ? retryAt.toISOString()
      : undefined;
    const cleanFailure: ProviderFailure = {
      ...parsed,
      ...(parsed.providerCode ? { providerCode: safeText(parsed.providerCode, 100) } : {}),
      ...(parsed.quotaPool ? { quotaPool: safeText(parsed.quotaPool, 100) } : {}),
      ...(parsed.retryAt !== undefined ? { retryAt: boundedRetryAt ?? null } : {}),
      message: safeText(parsed.message, 1000),
    };
    if (Buffer.byteLength(JSON.stringify(cleanFailure)) > MAX_FAILURE_BYTES) throw badRequest('Provider failure record exceeds its size limit');
    this.store.insertProviderFailure(sessionId, runId, cleanFailure, nowIso());
  }

  failure(sessionId: string): ProviderFailure | null {
    const failure = this.store.latestProviderFailure(sessionId);
    return failure ? ProviderFailureSchema.parse(failure) : null;
  }

  failureForRun(runId: string): ProviderFailure | null {
    const failure = this.store.providerFailureForRun(runId);
    return failure ? ProviderFailureSchema.parse(failure) : null;
  }

  clearFailure(sessionId: string): void {
    this.store.clearProviderFailures(sessionId);
  }

  private async gitSnapshot(worktreePath: string): Promise<GitSnapshot> {
    const snapshot: GitSnapshot = { branch: null, head: null, dirtyPaths: [], dirtyPathsTruncated: false, isRepository: false, statusKnown: false, notices: [] };
    try {
      const root = await git(worktreePath, ['rev-parse', '--show-toplevel'], { allowFailure: true, timeoutMs: 5_000, maxBuffer: 64 * 1024 });
      if (root.code !== 0) {
        if (/not a git repository/i.test(root.stderr || root.stdout)) {
          snapshot.isRepository = false;
          snapshot.statusKnown = true;
        } else {
          snapshot.notices.push('Git repository state could not be determined.');
        }
        return snapshot;
      }
      snapshot.isRepository = true;
      const [branch, head, status] = await Promise.all([
        git(worktreePath, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true, timeoutMs: 5_000, maxBuffer: 64 * 1024 }),
        git(worktreePath, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true, timeoutMs: 5_000, maxBuffer: 64 * 1024 }),
        git(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 10_000, maxBuffer: 2 * 1024 * 1024 }),
      ]);
      if (branch.code === 0) snapshot.branch = safeText(branch.stdout.trim(), 1000) || null;
      if (head.code === 0) snapshot.head = safeText(head.stdout.trim(), 100) || null;
      else snapshot.notices.push('Git HEAD is unavailable (the worktree may not have a commit yet).');
      const dirty = this.parseDirtyPaths(status.stdout);
      snapshot.dirtyPaths = dirty.paths;
      snapshot.dirtyPathsTruncated = dirty.truncated;
      snapshot.statusKnown = true;
      return snapshot;
    } catch {
      snapshot.notices.push('Git branch, HEAD, or dirty-file state could not be captured; no clean state is assumed.');
      return snapshot;
    }
  }

  private parseDirtyPaths(output: string): { paths: string[]; truncated: boolean } {
    const entries = output.split('\0');
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.length < 4) continue;
      const status = entry.slice(0, 2);
      const path = safeText(entry.slice(3), 4096);
      if (path) paths.push(path);
      if (status.includes('R') || status.includes('C')) {
        const second = entries[index + 1];
        if (second) paths.push(safeText(second, 4096));
        index++;
      }
    }
    const unique = [...new Set(paths.filter(Boolean))];
    return { paths: unique.slice(0, MAX_DIRTY_PATHS), truncated: unique.length > MAX_DIRTY_PATHS };
  }

  private boundCheckpoint(checkpoint: RecoveryCheckpoint): RecoveryCheckpoint {
    const bounded = structuredClone(checkpoint);
    if (bounded.worktree.dirtyPathsTruncated && !bounded.notices.some((notice) => notice.includes('dirty path'))) {
      bounded.notices = [...bounded.notices.slice(0, 19), 'Dirty path list was truncated to keep the checkpoint bounded.'];
    }
    const encodedSize = () => Buffer.byteLength(JSON.stringify(bounded));
    while (encodedSize() > MAX_CHECKPOINT_BYTES) {
      if (bounded.worktree.dirtyPaths.length) {
        bounded.worktree.dirtyPaths.pop();
        bounded.worktree.dirtyPathsTruncated = true;
      } else if (bounded.uncertainTools.length) bounded.uncertainTools.pop();
      else if (bounded.errors.length) bounded.errors.pop();
      else if (bounded.pendingApprovals.length) bounded.pendingApprovals.pop();
      else if (bounded.artifacts.length) bounded.artifacts.pop();
      else if (bounded.tasks.length > 1) bounded.tasks.pop();
      else if (bounded.objective && bounded.objective.length > 100) bounded.objective = bounded.objective.slice(0, Math.floor(bounded.objective.length / 2));
      else if (bounded.tasks[0]?.description) bounded.tasks[0].description = bounded.tasks[0].description.slice(0, Math.floor(bounded.tasks[0].description.length / 2));
      else if (bounded.tasks[0]?.acceptanceCriteria) bounded.tasks[0].acceptanceCriteria = bounded.tasks[0].acceptanceCriteria.slice(0, Math.floor(bounded.tasks[0].acceptanceCriteria.length / 2));
      else throw new Error('Recovery checkpoint could not be reduced to its durable size limit');
    }
    return RecoveryCheckpointSchema.parse(bounded);
  }
}

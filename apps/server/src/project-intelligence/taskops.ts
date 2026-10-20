import type { Task, TaskOverride, TaskSource, TaskStatus } from '@mingle/contracts';
import { unfinishedDeps } from '../dag.ts';
import type { Store } from '../store.ts';
import type { TaskService } from '../tasks.ts';

/** Guarded task mutation shared by every automatic writer: manual overrides and real dependencies always win. */
export class TaskOps {
  private dirty = false;

  constructor(private readonly store: Store, private readonly tasks: TaskService) {}

  /** Records that task or source state changed without a workspace event, so clients still refresh. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Signals one coalesced state change if anything was written since the last flush; call once per top-level operation. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.store.touch();
  }

  hasOverride(task: Task, field: TaskOverride): boolean {
    return task.source?.overrides?.includes(field) ?? false;
  }

  unfinished(task: Task): number {
    return unfinishedDeps(task.dependsOn, (id) => this.store.getTask(id)?.status).length;
  }

  /** Tasks of a project whose source record matches `kind` (and optionally a run). */
  sourced(projectId: string, kind: TaskSource['kind'], runId?: string): Task[] {
    const rows = this.store.db.prepare(
      `SELECT task_id FROM task_sources WHERE project_id = ? AND json_extract(data, '$.kind') = ?${runId ? " AND json_extract(data, '$.runId') = ?" : ''} ORDER BY rowid ASC`,
    ).all(...(runId ? [projectId, kind, runId] : [projectId, kind])) as Array<{ task_id: string }>;
    return rows.map((row) => this.store.getTask(row.task_id)).filter((task): task is Task => Boolean(task?.source));
  }

  sourcedCount(projectId: string): number {
    const row = this.store.db.prepare('SELECT COUNT(*) AS n FROM task_sources WHERE project_id = ?').get(projectId) as { n: number | bigint };
    return Number(row.n);
  }

  /** Merges `patch` into the stored source. `missing: false` removes the flag. Returns whether anything changed. */
  patchSource(task: Task, patch: Partial<TaskSource>): boolean {
    const current = task.source;
    if (!current) return false;
    const next: TaskSource = { ...current, ...patch };
    for (const key of Object.keys(next) as Array<keyof TaskSource>) if (next[key] === undefined) delete next[key];
    if (next.missing === false) delete next.missing;
    if (JSON.stringify(next) === JSON.stringify(current)) return false;
    this.store.setTaskSource(task.id, next);
    task.source = next;
    this.dirty = true;
    return true;
  }

  /**
   * Moves a task to `next` unless the user overrode its status. Ready/running/review/done require finished dependencies; with
   * `blockedFallback` a task that cannot honestly be ready is shown blocked instead. Returns the updated task or null.
   */
  setStatus(task: Task, next: TaskStatus, options: { blockedFallback?: boolean } = {}): Task | null {
    if (this.hasOverride(task, 'status')) return null;
    let target = next;
    // Nothing becomes ready, running, in review or done past unfinished prerequisites; observed provider state stays in source.reportedStatus.
    if ((target === 'ready' || target === 'running' || target === 'review' || target === 'done') && this.unfinished(task) > 0) {
      if (!options.blockedFallback) return null;
      target = 'blocked';
    }
    if (target === task.status) return null;
    const updated = this.store.updateTask(task.id, { status: target });
    this.dirty = true;
    this.tasks.cascade(updated, task.status);
    return this.store.getTask(task.id) ?? updated;
  }

  /** Applies a source-derived title unless the user renamed the task. */
  retitle(task: Task, title: string): boolean {
    if (this.hasOverride(task, 'title') || task.title === title) return false;
    this.store.updateTask(task.id, { title });
    this.dirty = true;
    return true;
  }
}

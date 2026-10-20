import type { Task } from '@relay/contracts';
import type { Store } from '../store.ts';
import { LIMITS } from './limits.ts';
import type { RepoItem, ScanResult } from './scan.ts';
import type { TaskOps } from './taskops.ts';

export interface RepoSyncSummary { created: Task[]; completed: Task[]; reopened: Task[]; missing: Task[]; restored: Task[]; skippedByLimit: number; notices: string[] }

const brief = (tasks: Task[]) => tasks.slice(0, 20).map((task) => ({ taskId: task.id, title: task.title }));
export const syncPayload = (summary: RepoSyncSummary) => ({
  created: brief(summary.created), completed: brief(summary.completed), reopened: brief(summary.reopened), missing: brief(summary.missing), restored: brief(summary.restored),
});
export const syncChanged = (summary: RepoSyncSummary) => summary.created.length + summary.completed.length + summary.reopened.length + summary.missing.length + summary.restored.length > 0;

/**
 * Reconciles scan items with repository-sourced tasks. Identity is the stable source key (file + normalised text), never
 * a line number. A checked checkbox completes its task; a vanished source is flagged for review and never completed
 * or deleted; items in files that were not fully read are left alone.
 */
export function syncRepositoryTasks(store: Store, ops: TaskOps, projectId: string, scan: ScanResult): RepoSyncSummary {
  const summary: RepoSyncSummary = { created: [], completed: [], reopened: [], missing: [], restored: [], skippedByLimit: 0, notices: [] };
  const existing = ops.sourced(projectId, 'repository');
  const byKey = new Map(existing.map((task) => [task.source!.key, task]));
  const seen = new Set<string>();
  const fresh: RepoItem[] = [];

  for (const item of scan.items) {
    seen.add(item.key);
    const task = byKey.get(item.key);
    if (!task) { fresh.push(item); continue; }
    const wasMissing = Boolean(task.source!.missing);
    const reported = item.checked ? 'completed' : 'pending';
    const previousReport = task.source!.reportedStatus;
    ops.patchSource(task, { path: item.path, line: item.line, missing: false, reportedStatus: reported });
    ops.retitle(task, item.title);
    if (wasMissing) summary.restored.push(task);
    if (item.kind !== 'checkbox') continue;
    if (item.checked && task.status !== 'done' && task.status !== 'running') {
      const done = ops.setStatus(task, 'done');
      if (done) summary.completed.push(done);
      else if (!ops.hasOverride(task, 'status')) summary.notices.push(`“${task.title}” is checked in ${item.path} but depends on unfinished tasks, so its status was kept.`);
    } else if (!item.checked && task.status === 'done' && previousReport === 'completed') {
      const reopened = ops.setStatus(task, 'backlog');
      if (reopened) summary.reopened.push(reopened);
    }
  }

  // Open work is tracked before completed history so the task limit never hides what still needs doing.
  const priority = (item: RepoItem) => (item.checked ? 2 : item.kind === 'checkbox' ? 0 : 1);
  let capacity = Math.max(0, LIMITS.maxRepositoryTasks - existing.length);
  for (const item of [...fresh].sort((a, b) => priority(a) - priority(b))) {
    if (capacity <= 0) { summary.skippedByLimit++; continue; }
    capacity--;
    const task = store.insertTask({ projectId, title: item.title, description: item.description, acceptanceCriteria: '', sessionId: null, dependsOn: [], status: item.checked ? 'done' : 'backlog' });
    store.setTaskSource(task.id, { kind: 'repository', key: item.key, path: item.path, line: item.line, reportedStatus: item.checked ? 'completed' : 'pending' });
    summary.created.push(store.getTask(task.id) ?? task);
  }
  if (summary.skippedByLimit) summary.notices.push(`Repository task limit (${LIMITS.maxRepositoryTasks}) reached; ${summary.skippedByLimit} further item${summary.skippedByLimit === 1 ? ' was' : 's were'} not tracked.`);

  for (const task of existing) {
    const source = task.source!;
    if (seen.has(source.key) || source.missing) continue;
    const scope = source.key.startsWith('repo:checklist:') ? scan.complete.checklist : source.key.startsWith('repo:comment:') ? scan.complete.comments : false;
    const gone = scope && Boolean(source.path) && (scan.covered.has(source.path!) || (scan.fileSet !== null && !scan.fileSet.has(source.path!)));
    if (!gone) continue;
    ops.patchSource(task, { missing: true });
    // Never invent completion: unstarted work goes to review so a person decides whether it was done, dropped or moved.
    if (task.status === 'backlog' || task.status === 'ready') ops.setStatus(task, 'review');
    summary.missing.push(store.getTask(task.id) ?? task);
  }
  return summary;
}

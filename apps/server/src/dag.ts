import type { TaskStatus } from '@mingle/contracts';

export interface DagTask { id: string; projectId: string; status: TaskStatus; dependsOn: string[] }

/**
 * Returns the cycle (as a path of task ids) that would be created if `taskId` depended on `deps`, or null.
 * `lookup` returns the current dependency list of any task.
 */
export function findCycle(taskId: string, deps: string[], lookup: (id: string) => string[] | undefined): string[] | null {
  const visited = new Set<string>();
  const walk = (id: string, trail: string[]): string[] | null => {
    if (id === taskId) return [...trail, id];
    if (visited.has(id)) return null;
    visited.add(id);
    for (const next of lookup(id) ?? []) {
      const found = walk(next, [...trail, id]);
      if (found) return found;
    }
    return null;
  };
  for (const dep of deps) {
    const found = walk(dep, [taskId]);
    if (found) return found;
  }
  return null;
}

export function unfinishedDeps(deps: string[], statusOf: (id: string) => TaskStatus | undefined): string[] {
  return deps.filter((id) => statusOf(id) !== 'done');
}

/** Topological order of the whole graph; throws if a cycle exists (used to assert invariants in tests and on load). */
export function topologicalOrder(tasks: DagTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 1 | 2>();
  const order: string[] = [];
  const visit = (id: string) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`Dependency cycle through ${id}`);
    state.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep);
    state.set(id, 2);
    order.push(id);
  };
  for (const task of tasks) visit(task.id);
  return order;
}

const SETTABLE: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['ready', 'blocked', 'done'],
  ready: ['backlog', 'blocked', 'review', 'done'],
  running: [],
  blocked: ['backlog', 'ready'],
  review: ['ready', 'backlog', 'blocked', 'done'],
  done: ['ready', 'review', 'backlog', 'blocked'],
};

export interface TransitionCheck { ok: boolean; reason?: string }

/** Validates a manual status change against the dependency state. `running` is only ever set by dispatch. */
export function checkTransition(from: TaskStatus, to: TaskStatus, unfinished: number): TransitionCheck {
  if (from === to) return { ok: true };
  if (to === 'running') return { ok: false, reason: 'A task becomes running only when it is dispatched to a session' };
  if (from === 'running') return { ok: false, reason: 'Task is running; interrupt its session first' };
  if (!SETTABLE[from].includes(to)) return { ok: false, reason: `Cannot move a ${from} task to ${to}` };
  if (unfinished > 0 && (to === 'ready' || to === 'review' || to === 'done')) return { ok: false, reason: `Task has ${unfinished} unfinished dependenc${unfinished === 1 ? 'y' : 'ies'}` };
  return { ok: true };
}

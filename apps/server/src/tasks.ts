import type { TaskOverride, Task, TaskStatus, WorkspaceEvent } from '@relay/contracts';
import { CreateTaskSchema, UpdateTaskSchema } from '@relay/contracts';
import type { z } from 'zod';
import { checkTransition, findCycle, unfinishedDeps } from './dag.ts';
import type { Store } from './store.ts';
import { conflict, notFound, unprocessable } from './util.ts';

type CreateInput = z.infer<typeof CreateTaskSchema>;
type UpdateInput = z.infer<typeof UpdateTaskSchema>;

export class TaskService {
  constructor(private readonly store: Store) {}

  private validateRefs(projectId: string, sessionId: string | null | undefined, deps: string[], selfId?: string): string[] {
    const unique = [...new Set(deps)];
    for (const dep of unique) {
      if (dep === selfId) throw unprocessable('A task cannot depend on itself');
      const other = this.store.getTask(dep);
      if (!other) throw unprocessable(`Dependency ${dep} does not exist`);
      if (other.projectId !== projectId) throw unprocessable('Dependencies must belong to the same project');
    }
    if (sessionId) {
      const session = this.store.getSession(sessionId);
      if (!session) throw unprocessable(`Session ${sessionId} does not exist`);
      if (session.projectId !== projectId) throw unprocessable('A task can only be assigned to a session of the same project');
    }
    return unique;
  }

  create(input: CreateInput): Task {
    if (!this.store.getProject(input.projectId)) throw notFound('Project not found');
    return this.store.tx(() => {
      const deps = this.validateRefs(input.projectId, input.sessionId, input.dependsOn);
      // A brand-new task cannot be part of a cycle, but its dependencies may not be done yet.
      const status: TaskStatus = unfinishedDeps(deps, (id) => this.store.getTask(id)?.status).length > 0 ? 'blocked' : 'ready';
      const task = this.store.insertTask({ ...input, dependsOn: deps, status });
      this.store.recordEvent({ projectId: task.projectId, sessionId: task.sessionId, type: 'task.created', summary: `Task created: ${task.title}`, payload: { taskId: task.id, status: task.status, dependsOn: deps } });
      return task;
    });
  }

  update(id: string, patch: UpdateInput): Task {
    return this.store.tx(() => {
      const current = this.store.getTask(id);
      if (!current) throw notFound('Task not found');
      const deps = patch.dependsOn !== undefined ? this.validateRefs(current.projectId, undefined, patch.dependsOn, id) : current.dependsOn;
      if (patch.sessionId) this.validateRefs(current.projectId, patch.sessionId, []);
      if (patch.dependsOn !== undefined) {
        const cycle = findCycle(id, deps, (taskId) => this.store.getTask(taskId)?.dependsOn);
        if (cycle) throw unprocessable(`Dependency cycle: ${cycle.map((t) => this.store.getTask(t)?.title ?? t).join(' → ')}`);
      }
      const unfinished = unfinishedDeps(deps, (dep) => this.store.getTask(dep)?.status).length;
      let status: TaskStatus = current.status;
      if (patch.status !== undefined && patch.status !== current.status) {
        const check = checkTransition(current.status, patch.status, unfinished);
        if (!check.ok) throw conflict(check.reason!);
        status = patch.status;
      } else if (patch.status === undefined && current.status !== 'running') {
        // Dependency edits adjust ready/blocked implicitly; other states are left as the user set them.
        if (status === 'ready' && unfinished > 0) status = 'blocked';
        else if (status === 'blocked' && unfinished === 0 && patch.dependsOn !== undefined) status = 'ready';
      }
      if (patch.sessionId !== undefined && patch.sessionId !== current.sessionId && current.status === 'running') throw conflict('Cannot reassign a running task');
      if (current.source) {
        const overrides = new Set<TaskOverride>(current.source.overrides ?? []);
        for (const key of Object.keys(patch) as TaskOverride[]) {
          if (patch[key] !== undefined && JSON.stringify(patch[key]) !== JSON.stringify(current[key])) overrides.add(key);
        }
        this.store.setTaskSource(id, { ...current.source, overrides: [...overrides] });
      }
      const next = this.store.updateTask(id, { title: patch.title, description: patch.description, acceptanceCriteria: patch.acceptanceCriteria, sessionId: patch.sessionId, status, dependsOn: patch.dependsOn !== undefined ? deps : undefined });
      this.store.recordEvent({ projectId: next.projectId, sessionId: next.sessionId, type: 'task.updated', summary: `Task updated: ${next.title}${next.status !== current.status ? ` (${current.status} → ${next.status})` : ''}`, payload: { taskId: id, from: current.status, to: next.status, fields: Object.keys(patch) } });
      this.cascade(next, current.status);
      return this.store.getTask(id)!;
    });
  }

  /** Called whenever a task's status changed: unblock dependents when it became done, re-block ready ones when it left done. */
  cascade(task: Task, previous: TaskStatus): WorkspaceEvent[] {
    const events: WorkspaceEvent[] = [];
    const becameDone = task.status === 'done' && previous !== 'done';
    const leftDone = previous === 'done' && task.status !== 'done';
    if (!becameDone && !leftDone) return events;
    for (const dependent of this.store.dependentsOf(task.id)) {
      const unfinished = unfinishedDeps(dependent.dependsOn, (dep) => this.store.getTask(dep)?.status).length;
      if (becameDone && dependent.status === 'blocked' && unfinished === 0) {
        this.store.updateTask(dependent.id, { status: 'ready' });
        events.push(this.store.recordEvent({ projectId: dependent.projectId, sessionId: dependent.sessionId, type: 'task.unblocked', summary: `Task ready: ${dependent.title}`, payload: { taskId: dependent.id, because: task.id } }));
      } else if (leftDone && dependent.status === 'ready' && unfinished > 0) {
        this.store.updateTask(dependent.id, { status: 'blocked' });
        events.push(this.store.recordEvent({ projectId: dependent.projectId, sessionId: dependent.sessionId, type: 'task.blocked', summary: `Task blocked: ${dependent.title}`, payload: { taskId: dependent.id, because: task.id } }));
      }
    }
    return events;
  }

  /** Validates that a task may be dispatched now; throws HTTP errors otherwise. */
  assertRunnable(id: string): Task {
    const task = this.store.getTask(id);
    if (!task) throw notFound('Task not found');
    if (!task.sessionId) throw conflict('Assign a session to the task before running it');
    if (task.status !== 'ready' && task.status !== 'review') throw conflict(`Task is ${task.status}; only ready tasks (or tasks in review) can be run`);
    const unfinished = unfinishedDeps(task.dependsOn, (dep) => this.store.getTask(dep)?.status);
    if (unfinished.length) throw conflict('Task has unfinished dependencies');
    return task;
  }

  buildPrompt(task: Task): string {
    const deps = task.dependsOn.map((dep) => this.store.getTask(dep)).filter((t): t is Task => Boolean(t));
    const lines = [`You have been assigned a Relay task. Work in your current worktree and do not merge or push.`, '', `Task: ${task.title}`];
    if (task.description.trim()) lines.push('', 'Description:', task.description.trim());
    if (task.acceptanceCriteria.trim()) lines.push('', 'Acceptance criteria:', task.acceptanceCriteria.trim());
    if (deps.length) lines.push('', 'Completed prerequisite tasks:', ...deps.map((d) => `- ${d.title}`));
    lines.push('', 'When finished, summarise what changed and how it was verified. A human reviews the result before the task is marked done.');
    return lines.join('\n');
  }

  markRunning(task: Task): void {
    const next = this.store.updateTask(task.id, { status: 'running' });
    this.store.recordEvent({ projectId: next.projectId, sessionId: next.sessionId, type: 'task.running', summary: `Task running: ${next.title}`, payload: { taskId: next.id } });
  }

  finishRun(taskId: string, outcome: 'completed' | 'failed' | 'interrupted'): void {
    const task = this.store.getTask(taskId);
    if (!task || task.status !== 'running') return;
    const status: TaskStatus = outcome === 'completed' ? 'review' : 'ready';
    const next = this.store.updateTask(taskId, { status });
    this.store.recordEvent({
      projectId: next.projectId, sessionId: next.sessionId, type: outcome === 'completed' ? 'task.review' : 'task.run.stopped',
      summary: outcome === 'completed' ? `Task ready for review: ${next.title}` : `Task run ${outcome}: ${next.title}`, payload: { taskId, outcome },
    });
  }
}


import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { Project, ProjectContext, Session, Task, ToolCall, WorkspaceEvent } from '@mingle/contracts';

export type Component = ProjectContext['components'][number];
export interface RootData { project: Project; context: ProjectContext | null; [key: string]: unknown }
export interface ComponentData { component: Component; [key: string]: unknown }
export interface SessionData { session: Session; assigned: number; [key: string]: unknown }
export interface TaskData { task: Task; blocked: boolean; [key: string]: unknown }
export interface AgentData { call: ToolCall; [key: string]: unknown }

export const MAX_COMPONENT_NODES = 40;
export const MAX_AGENT_NODES = 40;
export const MAX_TASK_NODES = 200;

const TASK_PRIORITY: Record<Task['status'], number> = { running: 0, blocked: 1, ready: 2, review: 3, backlog: 4, done: 5 };

/** Keeps at most `limit` tasks: active states first, then most recently updated; the selected task is always kept. Original order is preserved. */
export function pickVisibleTasks(tasks: Task[], limit: number, selectedId: string | null): Task[] {
  if (tasks.length <= limit) return tasks;
  const ranked = [...tasks].sort((a, b) => TASK_PRIORITY[a.status] - TASK_PRIORITY[b.status] || b.updatedAt.localeCompare(a.updatedAt));
  const keep = new Set(ranked.slice(0, limit).map((t) => t.id));
  if (selectedId && !keep.has(selectedId) && tasks.some((t) => t.id === selectedId)) {
    keep.delete(ranked[limit - 1].id);
    keep.add(selectedId);
  }
  return tasks.filter((t) => keep.has(t.id));
}

export interface GraphInput {
  project: Project; context: ProjectContext | null; sessions: Session[]; tasks: Task[]; toolCalls: ToolCall[]; events: WorkspaceEvent[]; selected: string | null;
}
export interface GraphResult {
  nodes: Node[]; edges: Edge[];
  hiddenComponents: number; hiddenAgents: number; hiddenTasks: number;
  /** Component id -> the dependency strings that matched no scanned component. */
  unresolved: Map<string, string[]>;
  components: Component[]; agentCalls: ToolCall[];
  /** Tasks drawn as nodes; a subset of the input tasks, which stay untouched. */
  visibleTasks: Task[];
}

const marker = { type: MarkerType.ArrowClosed, width: 16, height: 16 };

function handoffEdges(events: WorkspaceEvent[], ids: Set<string>): { from: string; to: string; id: number }[] {
  const out: { from: string; to: string; id: number }[] = [];
  for (const e of events) {
    if (!/handoff/i.test(e.type)) continue;
    const from = e.payload.fromSessionId;
    const to = e.payload.toSessionId;
    if (typeof from === 'string' && typeof to === 'string' && ids.has(from) && ids.has(to)) out.push({ from, to, id: e.id });
  }
  return out;
}

/** Longest-path level from the given sources over `next`, ignoring cycles. */
function levels(ids: string[], next: Map<string, string[]>, sources: string[]): Map<string, number> {
  const level = new Map<string, number>();
  const visit = (id: string, depth: number, path: Set<string>): void => {
    if (path.has(id)) return;
    if ((level.get(id) ?? -1) >= depth) return;
    level.set(id, depth);
    path.add(id);
    for (const child of next.get(id) ?? []) visit(child, depth + 1, path);
    path.delete(id);
  };
  for (const source of sources) visit(source, 0, new Set());
  for (const id of ids) if (!level.has(id)) level.set(id, 0);
  return level;
}

/**
 * Builds the map from recorded data only: the project root, scanned components and their declared local dependencies,
 * sessions, tasks, recorded handoffs, and provider-reported agent invocations linked by native parent IDs.
 * `source.parentTaskId` is drawn as containment, never as a dependency.
 */
export function buildGraph({ project, context, sessions, tasks: allTasks, toolCalls, events, selected }: GraphInput): GraphResult {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const sel = (id: string) => selected === id;

  /* Components */
  const allComponents = context?.components ?? [];
  const components = allComponents.slice(0, MAX_COMPONENT_NODES);
  const shown = new Set(components.map((c) => c.id));
  const lookup = new Map<string, Component>();
  for (const c of allComponents) { lookup.set(c.id, c); if (!lookup.has(c.name)) lookup.set(c.name, c); if (!lookup.has(c.path)) lookup.set(c.path, c); }
  const unresolved = new Map<string, string[]>();
  const depsOf = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const c of components) {
    const resolved: string[] = [];
    const missing: string[] = [];
    for (const dep of c.dependencies) {
      const target = lookup.get(dep);
      if (!target || target.id === c.id) { if (!target) missing.push(dep); continue; }
      if (!resolved.includes(target.id)) resolved.push(target.id);
    }
    depsOf.set(c.id, resolved.filter((id) => shown.has(id)));
    for (const id of depsOf.get(c.id)!) dependents.set(id, [...(dependents.get(id) ?? []), c.id]);
    if (missing.length) unresolved.set(c.id, missing);
  }
  const tops = components.filter((c) => !(dependents.get(c.id)?.length)).map((c) => c.id);
  const compLevel = levels(components.map((c) => c.id), depsOf, tops);
  const perLevel = new Map<number, number>();
  for (const c of components) {
    const level = compLevel.get(c.id) ?? 0;
    const row = perLevel.get(level) ?? 0;
    perLevel.set(level, row + 1);
    nodes.push({ id: `c:${c.id}`, type: 'component', position: { x: 300 + level * 240, y: row * 84 }, data: { component: c } satisfies ComponentData, selected: sel(`c:${c.id}`) });
  }
  const compHeight = components.length ? Math.max(...perLevel.values()) * 84 : 0;
  for (const c of components) {
    if (tops.includes(c.id)) edges.push({ id: `rc:${c.id}`, source: `r:${project.id}`, target: `c:${c.id}`, label: 'contains', className: 'edge-contains', markerEnd: marker });
    for (const dep of depsOf.get(c.id) ?? []) edges.push({ id: `cd:${c.id}:${dep}`, source: `c:${c.id}`, target: `c:${dep}`, label: 'depends on', className: 'edge-component', markerEnd: marker });
  }

  /* Root */
  nodes.push({ id: `r:${project.id}`, type: 'root', position: { x: 0, y: 0 }, data: { project, context } satisfies RootData, selected: sel(`r:${project.id}`) });

  /* Sessions and tasks */
  const y0 = compHeight + (components.length ? 80 : 150);
  const everyTask = new Map(allTasks.map((t) => [t.id, t]));
  const tasks = pickVisibleTasks(allTasks, MAX_TASK_NODES, selected?.startsWith('t:') ? selected.slice(2) : null);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const depthOf = (t: Task, seen = new Set<string>()): number => {
    if (depth.has(t.id)) return depth.get(t.id)!;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const d = t.dependsOn.reduce((m, id) => { const dep = byId.get(id); return dep ? Math.max(m, depthOf(dep, seen) + 1) : m; }, 0);
    depth.set(t.id, d);
    return d;
  };
  tasks.forEach((t) => depthOf(t));
  sessions.forEach((s, i) => {
    nodes.push({ id: `s:${s.id}`, type: 'session', position: { x: 0, y: y0 + i * 120 }, data: { session: s, assigned: allTasks.filter((t) => t.sessionId === s.id).length } satisfies SessionData, selected: sel(`s:${s.id}`) });
    edges.push({ id: `rs:${s.id}`, source: `r:${project.id}`, sourceHandle: 'down', target: `s:${s.id}`, targetHandle: 'up', className: 'edge-contains', markerEnd: marker });
  });
  const perDepth = new Map<number, number>();
  for (const t of tasks) {
    const d = depth.get(t.id) ?? 0;
    const row = perDepth.get(d) ?? 0;
    perDepth.set(d, row + 1);
    const blocked = t.dependsOn.some((id) => everyTask.get(id) && everyTask.get(id)!.status !== 'done');
    nodes.push({ id: `t:${t.id}`, type: 'task', position: { x: 270 + d * 250, y: y0 + row * 96 }, data: { task: t, blocked } satisfies TaskData, selected: sel(`t:${t.id}`) });
  }
  for (const t of tasks) {
    if (t.sessionId && sessions.some((s) => s.id === t.sessionId)) edges.push({ id: `a:${t.id}`, source: `s:${t.sessionId}`, target: `t:${t.id}`, label: 'assigned', className: 'edge-assign', markerEnd: marker });
    for (const d of t.dependsOn) if (byId.has(d)) edges.push({ id: `d:${d}:${t.id}`, source: `t:${d}`, target: `t:${t.id}`, label: 'blocks', className: 'edge-dep', markerEnd: marker });
    const parent = t.source?.parentTaskId;
    if (parent && parent !== t.id && byId.has(parent)) edges.push({ id: `p:${parent}:${t.id}`, source: `t:${parent}`, target: `t:${t.id}`, label: 'contains', className: 'edge-contains', markerEnd: marker });
  }
  const sessionIds = new Set(sessions.map((s) => s.id));
  for (const h of handoffEdges(events, sessionIds)) edges.push({ id: `h:${h.id}`, source: `s:${h.from}`, target: `s:${h.to}`, label: `handoff #${h.id}`, className: 'edge-handoff', markerEnd: marker });

  /* Agent invocations: only provider-reported tool calls of category "agent", linked through native parent IDs. */
  const scoped = toolCalls.filter((c) => sessionIds.has(c.sessionId));
  const byProviderId = new Map(scoped.map((c) => [`${c.runId}\u0000${c.providerId}`, c]));
  const allAgents = scoped.filter((c) => c.category === 'agent').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const agentCalls = allAgents.slice(0, MAX_AGENT_NODES).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const drawn = new Set(agentCalls.map((c) => c.id));
  const ownerOf = (call: ToolCall): { parent: ToolCall | null; resolved: boolean } => {
    let parentId = call.parentProviderId;
    const seen = new Set<string>();
    while (parentId) {
      const parent = byProviderId.get(`${call.runId}\u0000${parentId}`);
      if (!parent || seen.has(parent.id)) return { parent: null, resolved: false };
      if (parent.category === 'agent') return drawn.has(parent.id) ? { parent, resolved: true } : { parent: null, resolved: false };
      seen.add(parent.id);
      parentId = parent.parentProviderId;
    }
    return { parent: null, resolved: true };
  };
  const agentDepth = new Map<string, number>();
  const owners = new Map<string, ReturnType<typeof ownerOf>>();
  for (const call of agentCalls) owners.set(call.id, ownerOf(call));
  const depthOfCall = (call: ToolCall, guard = new Set<string>()): number => {
    if (agentDepth.has(call.id)) return agentDepth.get(call.id)!;
    const parent = owners.get(call.id)?.parent;
    if (!parent || guard.has(call.id)) return 0;
    guard.add(call.id);
    const d = depthOfCall(parent, guard) + 1;
    agentDepth.set(call.id, d);
    return d;
  };
  const y1 = y0 + Math.max(sessions.length * 120, (perDepth.size ? Math.max(...perDepth.values()) : 0) * 96) + 90;
  const perAgentDepth = new Map<number, number>();
  for (const call of agentCalls) {
    const d = depthOfCall(call);
    const row = perAgentDepth.get(d) ?? 0;
    perAgentDepth.set(d, row + 1);
    nodes.push({ id: `a:${call.id}`, type: 'agent', position: { x: 270 + d * 250, y: y1 + row * 92 }, data: { call } satisfies AgentData, selected: sel(`a:${call.id}`) });
    const owner = owners.get(call.id)!;
    if (owner.parent) edges.push({ id: `ag:${owner.parent.id}:${call.id}`, source: `a:${owner.parent.id}`, target: `a:${call.id}`, label: 'invoked', className: 'edge-agent', markerEnd: marker });
    else edges.push({ id: `ag:s:${call.sessionId}:${call.id}`, source: `s:${call.sessionId}`, target: `a:${call.id}`, label: owner.resolved ? 'invoked' : 'parent not shown', className: owner.resolved ? 'edge-agent' : 'edge-unresolved', markerEnd: marker });
  }

  return { nodes, edges, hiddenComponents: allComponents.length - components.length, hiddenAgents: allAgents.length - agentCalls.length, hiddenTasks: allTasks.length - tasks.length, unresolved, components, agentCalls, visibleTasks: tasks };
}

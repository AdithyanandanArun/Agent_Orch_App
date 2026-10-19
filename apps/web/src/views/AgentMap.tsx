import { useMemo } from 'react';
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowRightLeft, ListChecks, MessagesSquare, Play } from 'lucide-react';
import type { Session, Task, WorkspaceEvent } from '@relay/contracts';
import { useRelay, useProject } from '../store/store';
import { cx } from '../lib/format';
import { Badge, Button, EmptyState, PROVIDER_NAME, ProviderMark, StatusDot } from '../components/ui';
import { Network } from 'lucide-react';

type SessionData = { session: Session; assigned: number };
type TaskData = { task: Task; blocked: boolean };

function SessionNode({ data, selected }: NodeProps<Node<SessionData>>) {
  const { session, assigned } = data;
  return (
    <div className={cx('gnode gnode--session', selected && 'is-selected', `gnode--${session.status}`)}>
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
      <div className="gnode__row"><ProviderMark provider={session.provider} size={18} /><strong>{session.name}</strong></div>
      <div className="gnode__row gnode__row--meta"><StatusDot status={session.status} /><span>{assigned} task{assigned === 1 ? '' : 's'}</span></div>
    </div>
  );
}
function TaskNode({ data, selected }: NodeProps<Node<TaskData>>) {
  const { task, blocked } = data;
  return (
    <div className={cx('gnode gnode--task', selected && 'is-selected', blocked && 'is-blocked')}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="gnode__row"><span className={`tdot tdot--${task.status}`} aria-hidden="true" /><strong>{task.title}</strong></div>
      <div className="gnode__row gnode__row--meta"><Badge>{task.status}</Badge>{blocked ? <span>waiting on dependencies</span> : null}</div>
    </div>
  );
}
const nodeTypes = { session: SessionNode, task: TaskNode };

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

export default function AgentMap() {
  const project = useProject();
  const boot = useRelay((s) => s.boot);
  const selected = useRelay((s) => s.mapSelection);

  const { nodes, edges, sessions, tasks } = useMemo(() => {
    const sessions = (boot?.sessions ?? []).filter((s) => s.projectId === project?.id);
    const tasks = (boot?.tasks ?? []).filter((t) => t.projectId === project?.id);
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
    const perDepth = new Map<number, number>();
    const nodes: Node[] = [];
    sessions.forEach((s, i) => {
      nodes.push({ id: `s:${s.id}`, type: 'session', position: { x: 0, y: i * 120 }, data: { session: s, assigned: tasks.filter((t) => t.sessionId === s.id).length } satisfies SessionData, selected: selected === `s:${s.id}` });
    });
    tasks.forEach((t) => {
      const d = depth.get(t.id) ?? 0;
      const row = perDepth.get(d) ?? 0;
      perDepth.set(d, row + 1);
      const blocked = t.dependsOn.some((id) => byId.get(id) && byId.get(id)!.status !== 'done');
      nodes.push({ id: `t:${t.id}`, type: 'task', position: { x: 270 + d * 250, y: row * 96 }, data: { task: t, blocked } satisfies TaskData, selected: selected === `t:${t.id}` });
    });
    const edges: Edge[] = [];
    const marker = { type: MarkerType.ArrowClosed, width: 16, height: 16 };
    for (const t of tasks) {
      if (t.sessionId && sessions.some((s) => s.id === t.sessionId)) edges.push({ id: `a:${t.id}`, source: `s:${t.sessionId}`, target: `t:${t.id}`, label: 'assigned', className: 'edge-assign', markerEnd: marker });
      for (const d of t.dependsOn) if (byId.has(d)) edges.push({ id: `d:${d}:${t.id}`, source: `t:${d}`, target: `t:${t.id}`, label: 'blocks', className: 'edge-dep', markerEnd: marker });
    }
    const ids = new Set(sessions.map((s) => s.id));
    for (const h of handoffEdges(boot?.events ?? [], ids)) edges.push({ id: `h:${h.id}`, source: `s:${h.from}`, target: `s:${h.to}`, label: `handoff #${h.id}`, className: 'edge-handoff', markerEnd: marker, sourceHandle: undefined });
    return { nodes, edges, sessions, tasks };
  }, [boot?.sessions, boot?.tasks, boot?.events, project?.id, selected]);

  const theme = boot?.settings.theme ?? 'dark';
  const sel = selected?.startsWith('s:') ? sessions.find((s) => `s:${s.id}` === selected) : undefined;
  const selTask = selected?.startsWith('t:') ? tasks.find((t) => `t:${t.id}` === selected) : undefined;

  if (!project) return <EmptyState icon={<Network size={20} />} title="No project">Open a project to see its sessions and tasks.</EmptyState>;
  if (sessions.length === 0 && tasks.length === 0) {
    return (
      <EmptyState icon={<Network size={20} />} title="Nothing to map yet" action={<Button variant="primary" onClick={() => useRelay.getState().openDialog({ kind: 'session' })}>New session</Button>}>
        The map is drawn from this project&apos;s real sessions, tasks, dependencies and recorded handoffs.
      </EmptyState>
    );
  }

  return (
    <div className="map">
      <div className="map__canvas">
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode={theme} fitView fitViewOptions={{ padding: 0.12, maxZoom: 1 }} minZoom={0.3} maxZoom={1.6}
          nodesConnectable={false} elementsSelectable
          onNodeClick={(_, n) => useRelay.getState().setMapSelection(n.id)} onPaneClick={() => useRelay.getState().setMapSelection(null)}
          aria-label="Agent map"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} />
        </ReactFlow>
        <div className="map__legend" aria-label="Legend">
          <span><i className="lg lg--assign" /> assigned</span><span><i className="lg lg--dep" /> dependency</span><span><i className="lg lg--handoff" /> handoff</span>
          <em>Static relationships from recorded data — no live traffic is shown.</em>
        </div>
      </div>
      <aside className="map__detail" aria-label="Selection details">
        {sel ? <SessionDetail session={sel} tasks={tasks.filter((t) => t.sessionId === sel.id)} /> : selTask ? <TaskDetail task={selTask} session={sessions.find((s) => s.id === selTask.sessionId)} /> : (
          <EmptyState icon={<MessagesSquare size={20} />} title="Select a node">Choose a session or task to see its details and actions.</EmptyState>
        )}
      </aside>
    </div>
  );
}

function SessionDetail({ session, tasks }: { session: Session; tasks: Task[] }) {
  const { selectSession, selectTask, setView, openDialog } = useRelay.getState();
  return (
    <div className="pane-pad stack">
      <div className="card__head"><ProviderMark provider={session.provider} size={22} /><div className="card__title"><strong>{session.name}</strong><span>{PROVIDER_NAME[session.provider]} · {session.model}</span></div></div>
      <StatusDot status={session.status} />
      <p className="muted small">{session.isolated ? 'Isolated worktree' : 'Project folder'}{session.branch ? ` · ${session.branch}` : ''} · {session.policy} policy</p>
      <div className="card__actions">
        <Button size="sm" variant="primary" onClick={() => selectSession(session.id)}>Open session</Button>
        <Button size="sm" onClick={() => openDialog({ kind: 'handoff', fromSessionId: session.id })}><ArrowRightLeft size={13} /> Handoff</Button>
      </div>
      <h4 className="mini-h"><ListChecks size={13} /> Assigned tasks</h4>
      {tasks.length === 0 ? <p className="muted small">None.</p> : (
        <ul className="mini-list">{tasks.map((t) => (
          <li key={t.id}><button type="button" onClick={() => { selectTask(t.id); setView('tasks'); }}><span className={`tdot tdot--${t.status}`} /><span className="mini-list__text">{t.title}</span><Badge>{t.status}</Badge></button></li>
        ))}</ul>
      )}
    </div>
  );
}

function TaskDetail({ task, session }: { task: Task; session?: Session }) {
  const { selectTask, setView } = useRelay.getState();
  return (
    <div className="pane-pad stack">
      <div className="card__head"><span className={`tdot tdot--${task.status}`} /><div className="card__title"><strong>{task.title}</strong><span>{task.status}</span></div></div>
      {task.description ? <p className="small">{task.description}</p> : null}
      {task.acceptanceCriteria ? <><h4 className="mini-h">Acceptance criteria</h4><p className="small">{task.acceptanceCriteria}</p></> : null}
      <p className="muted small">{session ? `Assigned to ${session.name}` : 'Unassigned'} · {task.dependsOn.length} dependenc{task.dependsOn.length === 1 ? 'y' : 'ies'}</p>
      <div className="card__actions"><Button size="sm" variant="primary" onClick={() => { selectTask(task.id); setView('tasks'); }}><Play size={13} /> Open in board</Button></div>
    </div>
  );
}

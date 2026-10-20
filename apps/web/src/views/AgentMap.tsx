import { useMemo } from 'react';
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowRightLeft, Boxes, ListChecks, MessagesSquare, Network, Package, Play, Settings2, Folder, Bot } from 'lucide-react';
import type { Session, Task, ToolCall } from '@mingle/contracts';
import { useMingle, useProject } from '../store/store';
import { useProjectContext } from '../store/projectContext';
import { clockTime, cx } from '../lib/format';
import { formatElapsed } from '../lib/activity';
import { Badge, Button, EmptyState, PROVIDER_NAME, StatusDot } from '../components/ui';
import { AgentIdentity } from '../components/group/AgentIdentity';
import { ContextCard } from '../components/automation/ContextSummary';
import { SourceBadges } from '../components/automation/TaskSource';
import { MAX_AGENT_NODES, MAX_COMPONENT_NODES, MAX_TASK_NODES, buildGraph, type AgentData, type Component, type ComponentData, type RootData, type SessionData, type TaskData } from './map/graph';

function RootNode({ data, selected }: NodeProps<Node<RootData>>) {
  const { project, context } = data;
  return (
    <div className={cx('gnode gnode--root', selected && 'is-selected')}>
      <Handle type="source" position={Position.Right} />
      <Handle type="source" position={Position.Bottom} id="down" />
      <div className="gnode__row"><Folder size={16} aria-hidden="true" /><strong>{project.name}</strong></div>
      <div className="gnode__row gnode__row--meta">
        <span>{project.isExample ? 'Example workspace' : 'Project'}</span>
        <span>{context?.branch ? context.branch : context && !context.isRepo ? 'not a repo' : ''}</span>
      </div>
    </div>
  );
}
function ComponentNode({ data, selected }: NodeProps<Node<ComponentData>>) {
  const { component } = data;
  const Icon = component.kind === 'package' ? Package : component.kind === 'config' ? Settings2 : Boxes;
  return (
    <div className={cx('gnode gnode--component', selected && 'is-selected')}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="gnode__row"><Icon size={14} aria-hidden="true" /><strong title={component.name}>{component.name}</strong></div>
      <div className="gnode__row gnode__row--meta"><span>{component.kind}</span><span>{component.fileCount} file{component.fileCount === 1 ? '' : 's'}</span></div>
    </div>
  );
}
function SessionIdentity({ session }: { session: Session }) {
  const member = useMingle((state) => {
    const memberships = state.boot?.groups?.flatMap((snapshot) => snapshot.members) ?? [];
    return memberships.find((entry) => entry.sessionId === session.id && !entry.removedAt) ?? memberships.find((entry) => entry.sessionId === session.id);
  });
  return <AgentIdentity handle={member?.handle ?? session.name} identityKey={session.id} provider={session.provider} prefix={Boolean(member)} removed={Boolean(member?.removedAt)} />;
}

function SessionNode({ data, selected }: NodeProps<Node<SessionData>>) {
  const { session, assigned } = data;
  return (
    <div className={cx('gnode gnode--session', selected && 'is-selected', `gnode--${session.status}`)}>
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
      <Handle type="target" position={Position.Top} id="up" />
      <div className="gnode__row"><SessionIdentity session={session} /></div>
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
      <div className="gnode__row gnode__row--meta"><Badge>{task.status}</Badge>{blocked ? <span>waiting on dependencies</span> : task.source ? <span>{task.source.kind}</span> : null}</div>
    </div>
  );
}
function AgentNode({ data, selected }: NodeProps<Node<AgentData>>) {
  const { call } = data;
  return (
    <div className={cx('gnode gnode--agent', selected && 'is-selected', `gnode--tool-${call.status}`)}>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="gnode__row"><Bot size={14} aria-hidden="true" /><strong title={call.summary || call.name}>{call.summary || call.name}</strong></div>
      <div className="gnode__row gnode__row--meta"><Badge tone={call.status === 'failed' ? 'err' : call.status === 'running' ? 'accent' : 'neutral'}>{call.status}</Badge><span>{call.durationMs !== null ? formatElapsed(call.durationMs) : ''}</span></div>
    </div>
  );
}
const nodeTypes = { root: RootNode, component: ComponentNode, session: SessionNode, task: TaskNode, agent: AgentNode };

export default function AgentMap() {
  const project = useProject();
  const boot = useMingle((s) => s.boot);
  const selected = useMingle((s) => s.mapSelection);
  const creatingSession = useMingle((s) => s.creatingSession);
  const { entry } = useProjectContext(project?.id);
  const context = entry.context;

  const graph = useMemo(() => {
    if (!project) return null;
    const sessions = (boot?.sessions ?? []).filter((s) => s.projectId === project.id);
    const tasks = (boot?.tasks ?? []).filter((t) => t.projectId === project.id);
    return { sessions, tasks, ...buildGraph({ project, context, sessions, tasks, toolCalls: boot?.toolCalls ?? [], events: boot?.events ?? [], selected }) };
  }, [boot?.sessions, boot?.tasks, boot?.events, boot?.toolCalls, project, context, selected]);

  if (!project || !graph) return <EmptyState icon={<Network size={20} />} title="No project">Open a project to see its structure, sessions and tasks.</EmptyState>;

  const { nodes, edges, sessions, tasks, components, agentCalls, unresolved, hiddenComponents, hiddenAgents, hiddenTasks } = graph;
  const theme = boot?.settings.theme ?? 'dark';
  const sel = selected?.startsWith('s:') ? sessions.find((s) => `s:${s.id}` === selected) : undefined;
  const selTask = selected?.startsWith('t:') ? tasks.find((t) => `t:${t.id}` === selected) : undefined;
  const selComponent = selected?.startsWith('c:') ? components.find((c) => `c:${c.id}` === selected) : undefined;
  const selAgent = selected?.startsWith('a:') ? agentCalls.find((c) => `a:${c.id}` === selected) : undefined;
  const rootSelected = selected === `r:${project.id}`;

  const notice = !context
    ? entry.error ? `Project scan unavailable: ${entry.error}` : 'Reading the project scan…'
    : context.status === 'indexing' ? 'Scanning project files…'
      : context.status === 'error' ? `Project scan failed${context.error ? `: ${context.error}` : ''}`
        : components.length === 0 ? 'The scan found no components to draw.'
          : null;

  return (
    <div className="map">
      <div className="map__canvas">
        <ReactFlow
          key={`${project.id}:${components.length > 0}`}
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode={theme} fitView fitViewOptions={{ padding: 0.12, maxZoom: 1 }} minZoom={0.3} maxZoom={1.6}
          nodesConnectable={false} elementsSelectable
          onNodeClick={(_, n) => useMingle.getState().setMapSelection(n.id)} onPaneClick={() => useMingle.getState().setMapSelection(null)}
          aria-label="Agent map"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {notice || (sessions.length === 0 && tasks.length === 0) ? (
          <div className="map__notice" role="status">
            {notice ? <span>{notice}</span> : null}
            {sessions.length === 0 ? (
              <span>No sessions yet. <button type="button" className="link-btn" disabled={creatingSession} onClick={() => void useMingle.getState().createSession()}>New session</button></span>
            ) : null}
          </div>
        ) : null}
        <div className="map__legend" aria-label="Legend">
          <span><i className="lg lg--contains" /> contains</span><span><i className="lg lg--component" /> component dependency</span><span><i className="lg lg--assign" /> assigned</span><span><i className="lg lg--dep" /> task dependency</span><span><i className="lg lg--handoff" /> handoff</span><span><i className="lg lg--agent" /> agent invocation</span>
          <em>
            Components are scanned folders and packages, not running agents. Agent nodes appear only when a provider reported them.
            {hiddenComponents > 0 ? ` ${hiddenComponents} more components are not drawn (limit ${MAX_COMPONENT_NODES}).` : ''}
            {hiddenTasks > 0 ? ` Showing ${MAX_TASK_NODES} of ${tasks.length} tasks (running, blocked, ready and in review first, then the most recently updated); ${hiddenTasks} hidden here but still on the board, and dependencies are drawn only between shown tasks.` : ''}
            {hiddenAgents > 0 ? ` Showing the latest ${MAX_AGENT_NODES} of ${agentCalls.length + hiddenAgents} agent invocations.` : ''}
          </em>
        </div>
      </div>
      <aside className="map__detail" aria-label="Selection details">
        {sel ? <SessionDetail session={sel} tasks={tasks.filter((t) => t.sessionId === sel.id)} />
          : selTask ? <TaskDetail task={selTask} tasks={tasks} session={sessions.find((s) => s.id === selTask.sessionId)} />
            : selComponent ? <ComponentDetail component={selComponent} all={context?.components ?? []} unresolved={unresolved.get(selComponent.id) ?? []} />
              : selAgent ? <AgentDetail call={selAgent} session={sessions.find((s) => s.id === selAgent.sessionId)} />
                : rootSelected ? <div className="pane-pad stack"><ContextCard projectId={project.id} /></div>
                  : (
                    <EmptyState icon={<MessagesSquare size={20} />} title="Select a node">Choose the project, a component, session, task or agent invocation to see its details.</EmptyState>
                  )}
      </aside>
    </div>
  );
}

function ComponentDetail({ component, all, unresolved }: { component: Component; all: Component[]; unresolved: string[] }) {
  const { setMapSelection } = useMingle.getState();
  const byKey = new Map<string, Component>();
  for (const c of all) { byKey.set(c.id, c); byKey.set(c.name, c); byKey.set(c.path, c); }
  const resolved = Array.from(new Set(component.dependencies.map((d) => byKey.get(d)).filter((c): c is Component => Boolean(c && c.id !== component.id))));
  const dependents = all.filter((c) => c.id !== component.id && c.dependencies.some((d) => byKey.get(d)?.id === component.id));
  return (
    <div className="pane-pad stack">
      <div className="card__head"><span className="card__glyph"><Boxes size={15} /></span><div className="card__title"><strong>{component.name}</strong><span>{component.kind} · {component.fileCount} file{component.fileCount === 1 ? '' : 's'}</span></div></div>
      <p className="small"><code>{component.path || '.'}</code></p>
      <h4 className="mini-h">Depends on</h4>
      {resolved.length === 0 ? <p className="muted small">No local dependencies were found.</p> : (
        <ul className="mini-list">{resolved.map((c) => <li key={c.id}><button type="button" onClick={() => setMapSelection(`c:${c.id}`)}><span className="mini-list__text">{c.name}</span><Badge>{c.kind}</Badge></button></li>)}</ul>
      )}
      {unresolved.length > 0 ? <p className="muted small">Not matched to a scanned component (external or outside the scan): {unresolved.join(', ')}</p> : null}
      <h4 className="mini-h">Used by</h4>
      {dependents.length === 0 ? <p className="muted small">No scanned component declares a dependency on this one.</p> : (
        <ul className="mini-list">{dependents.map((c) => <li key={c.id}><button type="button" onClick={() => setMapSelection(`c:${c.id}`)}><span className="mini-list__text">{c.name}</span><Badge>{c.kind}</Badge></button></li>)}</ul>
      )}
    </div>
  );
}

function AgentDetail({ call, session }: { call: ToolCall; session?: Session }) {
  return (
    <div className="pane-pad stack">
      <div className="card__head"><span className="card__glyph"><Bot size={15} /></span><div className="card__title"><strong>{call.summary || call.name}</strong><span>{call.name} · {call.status}</span></div></div>
      <p className="muted small">Reported by {session ? PROVIDER_NAME[session.provider] : 'the provider'} during a run{session ? ` in ${session.name}` : ''}. Started {clockTime(call.startedAt)}{call.durationMs !== null ? ` · took ${formatElapsed(call.durationMs)}` : call.status === 'running' ? ' · still running' : ''}.</p>
      {call.command ? <pre className="evt__payload">{call.command}</pre> : null}
      <p className="muted small">Native ID <code>{call.providerId}</code>{call.parentProviderId ? <> · parent <code>{call.parentProviderId}</code></> : ' · top-level in its run'}</p>
      {session ? <div className="card__actions"><Button size="sm" variant="primary" onClick={() => useMingle.getState().selectSession(session.id)}>Open session</Button></div> : null}
    </div>
  );
}

function SessionDetail({ session, tasks }: { session: Session; tasks: Task[] }) {
  const { selectSession, selectTask, setView, openDialog } = useMingle.getState();
  return (
    <div className="pane-pad stack">
      <div className="card__head"><div className="card__title"><SessionIdentity session={session} /><span>{PROVIDER_NAME[session.provider]} · {session.model}</span></div></div>
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

function TaskDetail({ task, tasks, session }: { task: Task; tasks: Task[]; session?: Session }) {
  const { selectTask, setView } = useMingle.getState();
  const parent = task.source?.parentTaskId ? tasks.find((t) => t.id === task.source?.parentTaskId) : undefined;
  return (
    <div className="pane-pad stack">
      <div className="card__head"><span className={`tdot tdot--${task.status}`} /><div className="card__title"><strong>{task.title}</strong><span>{task.status}</span></div></div>
      {task.source ? <div className="tcard__source"><SourceBadges task={task} /></div> : null}
      {task.description ? <p className="small">{task.description}</p> : null}
      {task.acceptanceCriteria ? <><h4 className="mini-h">Acceptance criteria</h4><p className="small">{task.acceptanceCriteria}</p></> : null}
      <p className="muted small">{session ? `Assigned to ${session.name}` : 'Unassigned'} · {task.dependsOn.length} dependenc{task.dependsOn.length === 1 ? 'y' : 'ies'}{parent ? ` · part of “${parent.title}” (grouping, not a dependency)` : ''}</p>
      <div className="card__actions"><Button size="sm" variant="primary" onClick={() => { selectTask(task.id); setView('tasks'); }}><Play size={13} /> Open in board</Button></div>
    </div>
  );
}

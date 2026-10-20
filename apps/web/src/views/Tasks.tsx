import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowRightLeft, GitMerge, ListPlus, Lock, Play, X } from 'lucide-react';
import type { Session, Task, TaskStatus } from '@relay/contracts';
import { useRelay, useProject } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { cx, relativeTime, useNow } from '../lib/format';
import { SOURCE_LABEL } from '../components/automation/TaskSource';
import { Badge, Button, EmptyState, Field, IconButton, InlineError, PROVIDER_NAME, ProviderMark } from '../components/ui';
import { SelectMenu } from '../components/SelectMenu';
import { ContextStrip } from '../components/automation/ContextSummary';
import { SourceBadges, SourceDetails } from '../components/automation/TaskSource';
import { useProjectContext } from '../store/projectContext';

const COLUMNS: { id: TaskStatus; label: string; hint: string }[] = [
  { id: 'backlog', label: 'Backlog', hint: 'Not yet scheduled' },
  { id: 'ready', label: 'Ready', hint: 'Dependencies satisfied' },
  { id: 'running', label: 'Running', hint: 'Set when a run is dispatched' },
  { id: 'blocked', label: 'Blocked', hint: 'Waiting on something' },
  { id: 'review', label: 'Review', hint: 'Turn finished; needs a human' },
  { id: 'done', label: 'Done', hint: 'Accepted by you' },
];

const unfinishedDeps = (task: Task, byId: Map<string, Task>): Task[] =>
  task.dependsOn.map((d) => byId.get(d)).filter((d): d is Task => Boolean(d) && d!.status !== 'done');

function TaskCard({ task, byId, session, selected, onDragStart }: { task: Task; byId: Map<string, Task>; session?: Session; selected: boolean; onDragStart: (e: DragEvent, id: string) => void }) {
  const open = unfinishedDeps(task, byId);
  const parent = task.source?.parentTaskId ? byId.get(task.source.parentTaskId) : undefined;
  return (
    <button
      type="button" className={cx('tcard', selected && 'is-selected')} draggable onDragStart={(e) => onDragStart(e, task.id)}
      onClick={() => useRelay.getState().selectTask(task.id)} aria-label={`Task ${task.title}, ${task.status}`}
    >
      <span className="tcard__title">{task.title}</span>
      {task.description ? <span className="tcard__desc">{task.description}</span> : null}
      {parent ? <span className="tcard__parent" title="Grouping only — not a dependency">Part of {parent.title}</span> : null}
      {task.source ? <span className="tcard__source"><SourceBadges task={task} /></span> : null}
      <span className="tcard__meta">
        {session ? <span className="tcard__owner"><ProviderMark provider={session.provider} size={14} />{session.name}</span> : <span className="tcard__owner tcard__owner--none">Unassigned</span>}
        {task.dependsOn.length > 0 ? (
          <span className={cx('tcard__deps', open.length > 0 && 'is-open')} title={open.length ? `Waiting on: ${open.map((d) => d.title).join(', ')}` : 'All dependencies done'}>
            {open.length > 0 ? <Lock size={11} aria-hidden="true" /> : <GitMerge size={11} aria-hidden="true" />}{task.dependsOn.length - open.length}/{task.dependsOn.length}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function descendants(taskId: string, tasks: Task[]): Set<string> {
  const out = new Set<string>();
  const stack = [taskId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const t of tasks) if (t.dependsOn.includes(cur) && !out.has(t.id)) { out.add(t.id); stack.push(t.id); }
  }
  return out;
}

function TaskDrawer({ task, tasks, sessions }: { task: Task; tasks: Task[]; sessions: Session[] }) {
  const providers = useRelay((s) => s.boot?.providers);
  const runs = useRelay((s) => s.boot?.runs);
  const connection = useRelay((s) => s.connection);
  const now = useNow();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [criteria, setCriteria] = useState(task.acceptanceCriteria);
  const [sessionId, setSessionId] = useState<string>(task.sessionId ?? '');
  const [deps, setDeps] = useState<string[]>(task.dependsOn);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = title !== task.title || description !== task.description || criteria !== task.acceptanceCriteria || sessionId !== (task.sessionId ?? '') || status !== task.status || deps.join() !== task.dependsOn.join();

  // Follow server updates, but never clobber an edit in progress.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setTitle(task.title); setDescription(task.description); setCriteria(task.acceptanceCriteria);
    setSessionId(task.sessionId ?? ''); setDeps(task.dependsOn); setStatus(task.status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.updatedAt]);

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const blockedFromDeps = useMemo(() => descendants(task.id, tasks), [task.id, tasks]);
  const owner = sessions.find((s) => s.id === task.sessionId);
  const provider = providers?.find((p) => p.id === owner?.provider);
  const open = unfinishedDeps(task, byId);

  const runWhy =
    connection !== 'online' ? 'Disconnected from the server'
      : dirty ? 'Save your changes first'
        : !owner ? 'Assign a session to run this task'
          : owner.status === 'running' || owner.status === 'waiting' ? `${owner.name} is already running`
            : open.length > 0 ? `Waiting on ${open.length} unfinished ${open.length === 1 ? 'dependency' : 'dependencies'}`
              : task.status === 'done' ? 'Task is already done'
                : task.status === 'running' ? 'Task is already running'
                  : provider && !provider.available ? `${PROVIDER_NAME[provider.id]} needs setup in Settings`
                    : undefined;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateTask(task.id, {
        title: title.trim(), description, acceptanceCriteria: criteria, sessionId: sessionId || null, dependsOn: deps,
        ...(status !== task.status ? { status } : {}),
      });
      await useRelay.getState().refreshNow();
      useRelay.getState().toast('success', 'Task saved');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await api.runTask(task.id);
      useRelay.getState().toast('info', `Dispatched to ${owner?.name ?? 'session'}`);
      await useRelay.getState().refreshNow();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  const statusOptions = COLUMNS.filter((c) => c.id !== 'running' || task.status === 'running');

  return (
    <aside className="drawer" aria-label={`Task details: ${task.title}`}>
      <header className="drawer__head">
        <Badge tone="accent">{task.status}</Badge>
        <span className="muted small">Updated {relativeTime(task.updatedAt, now)}</span>
        <span className="spacer" />
        <IconButton label="Close task details" onClick={() => useRelay.getState().selectTask(null)}><X size={15} /></IconButton>
      </header>
      <div className="drawer__body form">
        <SourceDetails task={task} tasks={tasks} sessions={sessions} runs={runs ?? []} />
        <Field label="Title" htmlFor="td-title"><input id="td-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
        <Field label="Description" htmlFor="td-desc"><textarea id="td-desc" className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} /></Field>
        <Field label="Acceptance criteria" htmlFor="td-ac" hint="Sent with the task when it is run."><textarea id="td-ac" className="textarea" value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3} /></Field>
        <div className="form-row">
          <Field label="Status" htmlFor="td-status" hint="“Running” is only set by dispatching a run.">
            <SelectMenu id="td-status" label="Task status" value={status} onChange={(value) => setStatus(value as TaskStatus)} options={statusOptions.map((c) => ({ value: c.id, label: c.label }))} />
          </Field>
          <Field label="Assigned session" htmlFor="td-session">
            <SelectMenu id="td-session" label="Assigned session" value={sessionId} onChange={setSessionId} options={[{ value: '', label: 'Unassigned' }, ...sessions.map((s) => ({ value: s.id, label: `${s.name} · ${PROVIDER_NAME[s.provider]}` }))]} />
          </Field>
        </div>
        <fieldset className="fieldset">
          <legend>Depends on</legend>
          {tasks.filter((t) => t.id !== task.id).length === 0 ? <p className="muted small">No other tasks in this project.</p> : null}
          {tasks.filter((t) => t.id !== task.id).map((t) => {
            const cyc = blockedFromDeps.has(t.id);
            return (
              <label key={t.id} className={cx('check', cyc && 'is-disabled')} title={cyc ? 'Would create a dependency cycle' : undefined}>
                <input type="checkbox" checked={deps.includes(t.id)} disabled={cyc} onChange={(e) => setDeps((d) => (e.target.checked ? [...d, t.id] : d.filter((x) => x !== t.id)))} />
                <span>{t.title} <Badge>{t.status}</Badge>{cyc ? <em className="muted small"> · depends on this task</em> : null}</span>
              </label>
            );
          })}
        </fieldset>
        {error ? <InlineError>{error}</InlineError> : null}
        <div className="drawer__actions">
          <Button variant="primary" busy={saving} disabled={!dirty || !title.trim()} why={!title.trim() ? 'Title is required' : 'No changes to save'} onClick={save}>Save changes</Button>
          <Button onClick={run} busy={running} disabled={Boolean(runWhy)} why={runWhy}><Play size={13} /> Run task</Button>
          <Button variant="ghost" disabled={!owner || sessions.length < 2} why={!owner ? 'Assign a session first' : 'Needs a second session in this project'} onClick={() => useRelay.getState().openDialog({ kind: 'handoff', taskId: task.id, fromSessionId: owner?.id })}><ArrowRightLeft size={13} /> Handoff</Button>
        </div>
        <p className="field__hint">Run sends this task to the assigned session as a real provider turn. A successful turn moves it to Review — Relay never marks tasks Done on its own.</p>
      </div>
    </aside>
  );
}

export function TasksView() {
  const project = useProject();
  const boot = useRelay((s) => s.boot);
  const selectedId = useRelay((s) => s.selectedTaskId);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [filter, setFilter] = useState('');
  const [origin, setOrigin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scan = useProjectContext(project?.id).entry.context;

  const tasks = useMemo(() => (boot?.tasks ?? []).filter((t) => t.projectId === project?.id), [boot?.tasks, project?.id]);
  const sessions = useMemo(() => (boot?.sessions ?? []).filter((s) => s.projectId === project?.id), [boot?.sessions, project?.id]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const sById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const visible = tasks
    .filter((t) => !filter || (filter === 'none' ? !t.sessionId : t.sessionId === filter))
    .filter((t) => !origin || (origin === 'manual' ? !t.source : t.source?.kind === origin));
  const originKinds = useMemo(() => Array.from(new Set(tasks.flatMap((t) => (t.source ? [t.source.kind] : [])))), [tasks]);
  const missingCount = tasks.filter((t) => t.source?.missing).length;

  if (!project) return <EmptyState title="No project">Open a project to manage tasks.</EmptyState>;

  const onDragStart = (e: DragEvent, id: string) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; };
  const onDrop = async (e: DragEvent, status: TaskStatus) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/plain');
    const t = byId.get(id);
    if (!t || t.status === status || status === 'running') return;
    setError(null);
    try {
      await api.updateTask(id, { status });
      await useRelay.getState().refreshNow();
    } catch (err) {
      setError(`Could not move “${t.title}”: ${errorMessage(err)}`);
    }
  };

  return (
    <div className="tasks">
      <div className="tasks__main">
        <div className="viewbar">
          <div>
            <h1>Tasks</h1>
            <p className="muted small">{tasks.length} in {project.name}. Dependencies gate when a task can start; runs are always started by you.</p>
          </div>
          <span className="spacer" />
          {originKinds.length > 0 ? (
            <>
              <label className="sr-only" htmlFor="task-origin">Filter by source</label>
              <SelectMenu id="task-origin" label="Filter by source" value={origin} onChange={setOrigin} options={[
                { value: '', label: 'All sources' }, { value: 'manual', label: 'Manual' },
                ...originKinds.map((kind) => ({ value: kind, label: SOURCE_LABEL[kind] })),
              ]} />
            </>
          ) : null}
          <label className="sr-only" htmlFor="task-filter">Filter by session</label>
          <SelectMenu id="task-filter" label="Filter by session" value={filter} onChange={setFilter} options={[{ value: '', label: 'All sessions' }, { value: 'none', label: 'Unassigned' }, ...sessions.map((s) => ({ value: s.id, label: s.name }))]} />
          <Button size="sm" variant="primary" onClick={() => useRelay.getState().openDialog({ kind: 'task' })}><ListPlus size={13} /> New task</Button>
        </div>
        <ContextStrip projectId={project.id} />
        {missingCount > 0 ? <div className="viewbar__error"><p className="ctxstrip__warn" role="status">{missingCount} task{missingCount === 1 ? ' is' : 's are'} no longer found at {missingCount === 1 ? 'its' : 'their'} source and kept on the board. Open one to see where it came from.</p></div> : null}
        {error ? <div className="viewbar__error"><InlineError>{error}</InlineError></div> : null}
        {tasks.length === 0 ? (
          <EmptyState icon={<ListPlus size={20} />} title="No tasks yet" action={<Button variant="primary" onClick={() => useRelay.getState().openDialog({ kind: 'task' })}>Create the first task</Button>}>
            {scan?.status === 'ready' && scan.scannedAt
              ? 'The project scan found no tasks to track automatically. Tasks also appear from provider plans in sessions; or create one yourself and chain tasks with dependencies.'
              : 'Break work into tasks, assign each to a session, and chain them with dependencies. Tasks found by the project scan appear here automatically.'}
          </EmptyState>
        ) : (
          <div className="board" role="list">
            {COLUMNS.map((col) => {
              const items = visible.filter((t) => t.status === col.id);
              return (
                <section
                  key={col.id} role="listitem" aria-label={`${col.label}, ${items.length} tasks`} className={cx('col', over === col.id && col.id !== 'running' && 'is-over')}
                  onDragOver={(e) => { if (col.id !== 'running') { e.preventDefault(); setOver(col.id); } }} onDragLeave={() => setOver((o) => (o === col.id ? null : o))} onDrop={(e) => void onDrop(e, col.id)}
                >
                  <header className="col__head"><span className={`tdot tdot--${col.id}`} aria-hidden="true" /><strong>{col.label}</strong><span className="col__count">{items.length}</span></header>
                  <div className="col__body">
                    {items.map((t) => <TaskCard key={t.id} task={t} byId={byId} session={t.sessionId ? sById.get(t.sessionId) : undefined} selected={t.id === selectedId} onDragStart={onDragStart} />)}
                    {items.length === 0 ? <p className="col__empty">{col.hint}</p> : null}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
      {selected ? <TaskDrawer key={selected.id} task={selected} tasks={tasks} sessions={sessions} /> : null}
    </div>
  );
}

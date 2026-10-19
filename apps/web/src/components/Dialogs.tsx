import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Provider } from '@relay/contracts';
import { useRelay, useActiveSession, useProject } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { basename } from '../lib/format';
import { Button, Field, InlineError, Modal, PROVIDER_NAME, ProviderMark, Segmented, Switch } from './ui';

function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function ProjectDialog() {
  const close = useRelay.getState().closeDialog;
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const { busy, error, run } = useSubmit(close);

  useEffect(() => { if (!touched) setName(basename(path)); }, [path, touched]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const project = await api.createProject({ name: name.trim(), path: path.trim() });
      await useRelay.getState().refreshNow();
      useRelay.getState().selectProject(project.id);
      useRelay.getState().toast('success', `Opened ${project.name}`);
    });
  };

  return (
    <Modal title="Open project" description="Point Relay at a folder on this machine. Git repositories get isolated session worktrees." onClose={close}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="project-form" busy={busy} disabled={!path.trim() || !name.trim()} why="Enter a folder path and a name">Open project</Button></>}>
      <form id="project-form" className="form" onSubmit={submit}>
        <Field label="Folder path" htmlFor="pf-path" hint="Absolute path on the machine running the Relay server. The server resolves it to its real path.">
          <input id="pf-path" data-autofocus className="input input--mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/code/my-app" spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="Name" htmlFor="pf-name">
          <input id="pf-name" className="input" value={name} maxLength={100} onChange={(e) => { setTouched(true); setName(e.target.value); }} />
        </Field>
        {error ? <InlineError>{error}</InlineError> : null}
      </form>
    </Modal>
  );
}

export function SessionDialog() {
  const close = useRelay.getState().closeDialog;
  const project = useProject();
  const providers = useRelay((s) => s.boot?.providers ?? []);
  const settings = useRelay((s) => s.boot?.settings);
  const existing = useRelay((s) => s.boot?.sessions.filter((x) => x.projectId === s.activeProjectId).length ?? 0);
  const firstAvailable = providers.find((p) => p.available)?.id ?? 'codex';
  const [provider, setProvider] = useState<Provider>(firstAvailable);
  const info = providers.find((p) => p.id === provider);
  const [model, setModel] = useState(info?.models[0]?.id ?? '');
  const [name, setName] = useState(`${PROVIDER_NAME[firstAvailable]} ${existing + 1}`);
  const [nameTouched, setNameTouched] = useState(false);
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('high');
  const [policy, setPolicy] = useState<'supervised' | 'balanced'>(settings?.defaultPolicy ?? 'supervised');
  const [isolated, setIsolated] = useState(true);
  const { busy, error, run } = useSubmit(close);

  useEffect(() => {
    setModel(info?.models[0]?.id ?? '');
    if (!nameTouched) setName(`${PROVIDER_NAME[provider]} ${existing + 1}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!project) return;
    void run(async () => {
      const s = await api.createSession({ projectId: project.id, name: name.trim(), provider, model: model.trim(), effort, policy, isolated });
      await useRelay.getState().refreshNow();
      useRelay.getState().selectSession(s.id);
    });
  };

  return (
    <Modal title="New session" description={`An independent agent working in ${project?.name ?? 'this project'}.`} onClose={close}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="session-form" busy={busy} disabled={!project || !name.trim() || !model.trim()} why={!project ? 'Open a project first' : 'Name and model are required'}>Create session</Button></>}>
      <form id="session-form" className="form" onSubmit={submit}>
        <Field label="Provider">
          <Segmented
            label="Provider" value={provider} onChange={setProvider}
            options={(['codex', 'claude'] as const).map((id) => ({ value: id, label: <><ProviderMark provider={id} size={14} />{PROVIDER_NAME[id]}</> }))}
          />
          {info ? (
            info.available ? (
              <p className="field__hint">{info.name} executable found{info.version ? ` (${info.version})` : ''}. This only means the program exists — sign-in or API credentials are checked when a run starts.</p>
            ) : (
              <p className="field__hint field__hint--warn"><AlertTriangle size={12} /> {info.name} executable unavailable{info.reason ? `: ${info.reason}` : ''}. You can still create the session, but runs will fail until this is fixed in Settings.</p>
            )
          ) : (
            <p className="field__hint">Provider availability has not been reported by the server yet. You can still create the session; check Settings if runs fail.</p>
          )}
        </Field>
        <Field label="Name" htmlFor="sf-name"><input id="sf-name" data-autofocus className="input" value={name} maxLength={100} onChange={(e) => { setNameTouched(true); setName(e.target.value); }} /></Field>
        <div className="form-row">
          <Field label="Model" htmlFor="sf-model" hint={info && info.models.length === 0 ? 'No models were reported by the provider; enter a model ID.' : undefined}>
            {info && info.models.length > 0 ? (
              <select id="sf-model" className="select" value={model} onChange={(e) => setModel(e.target.value)}>
                {info.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            ) : (
              <input id="sf-model" className="input input--mono" value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
            )}
          </Field>
          <Field label="Effort">
            <Segmented label="Effort" value={effort} onChange={setEffort} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
          </Field>
        </div>
        <Field label="Approval policy" hint={policy === 'supervised' ? 'Supervised: the agent asks before using tools that change things.' : 'Balanced: fewer interruptions; the provider decides which actions need approval.'}>
          <Segmented label="Approval policy" value={policy} onChange={setPolicy} options={[{ value: 'supervised', label: 'Supervised' }, { value: 'balanced', label: 'Balanced' }]} />
        </Field>
        <Switch
          checked={isolated} onChange={setIsolated} label="Isolated worktree"
          description={isolated ? 'Edits happen on a dedicated Git branch in a separate worktree under Relay’s data folder. Requires a Git repository with at least one commit.' : undefined}
        />
        {!isolated ? <div className="inline-warn" role="note"><AlertTriangle size={14} /> This session will edit the project folder directly. Other sessions and your own changes can collide with it.</div> : null}
        {error ? <InlineError>{error}</InlineError> : null}
      </form>
    </Modal>
  );
}

export function TaskDialog() {
  const close = useRelay.getState().closeDialog;
  const project = useProject();
  const sessions = useRelay((s) => s.boot?.sessions.filter((x) => x.projectId === s.activeProjectId) ?? []);
  const allTasks = useRelay((s) => s.boot?.tasks);
  const tasks = useMemo(() => (allTasks ?? []).filter((t) => t.projectId === project?.id), [allTasks, project?.id]);
  const activeSession = useActiveSession();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [sessionId, setSessionId] = useState(activeSession?.id ?? '');
  const [deps, setDeps] = useState<string[]>([]);
  const { busy, error, run } = useSubmit(close);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!project) return;
    void run(async () => {
      const t = await api.createTask({ projectId: project.id, title: title.trim(), description, acceptanceCriteria: criteria, sessionId: sessionId || null, dependsOn: deps });
      await useRelay.getState().refreshNow();
      useRelay.getState().setView('tasks');
      useRelay.getState().selectTask(t.id);
    });
  };

  return (
    <Modal title="New task" description="Tasks are units of work you can assign to a session and chain with dependencies." onClose={close}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="task-form" busy={busy} disabled={!project || !title.trim()} why={!project ? 'Open a project first' : 'A title is required'}>Create task</Button></>}>
      <form id="task-form" className="form" onSubmit={submit}>
        <Field label="Title" htmlFor="tf-title"><input id="tf-title" data-autofocus className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Add the /health endpoint" /></Field>
        <Field label="Description" htmlFor="tf-desc"><textarea id="tf-desc" className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Acceptance criteria" htmlFor="tf-ac" hint="How will you know it is done? Included when the task is run."><textarea id="tf-ac" className="textarea" rows={2} value={criteria} onChange={(e) => setCriteria(e.target.value)} /></Field>
        <Field label="Assigned session" htmlFor="tf-session">
          <select id="tf-session" className="select" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            <option value="">Unassigned</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.name} · {PROVIDER_NAME[s.provider]}</option>)}
          </select>
        </Field>
        {tasks.length > 0 ? (
          <fieldset className="fieldset">
            <legend>Depends on</legend>
            {tasks.map((t) => (
              <label key={t.id} className="check"><input type="checkbox" checked={deps.includes(t.id)} onChange={(e) => setDeps((d) => (e.target.checked ? [...d, t.id] : d.filter((x) => x !== t.id)))} /><span>{t.title}</span></label>
            ))}
          </fieldset>
        ) : null}
        {error ? <InlineError>{error}</InlineError> : null}
      </form>
    </Modal>
  );
}

export function HandoffDialog({ taskId, fromSessionId }: { taskId?: string; fromSessionId?: string }) {
  const close = useRelay.getState().closeDialog;
  const project = useProject();
  const active = useActiveSession();
  const allSessions = useRelay((s) => s.boot?.sessions);
  const allTasks = useRelay((s) => s.boot?.tasks);
  const sessions = useMemo(() => (allSessions ?? []).filter((s) => s.projectId === project?.id), [allSessions, project?.id]);
  const tasks = useMemo(() => (allTasks ?? []).filter((t) => t.projectId === project?.id), [allTasks, project?.id]);
  const [from, setFrom] = useState(fromSessionId ?? active?.id ?? sessions[0]?.id ?? '');
  const [to, setTo] = useState(() => sessions.find((s) => s.id !== (fromSessionId ?? active?.id))?.id ?? '');
  const [task, setTask] = useState(taskId ?? '');
  const [path, setPath] = useState('');
  const [revision, setRevision] = useState('');
  const [note, setNote] = useState('');
  const [suggest, setSuggest] = useState<string[]>([]);
  const { busy, error, run } = useSubmit(close);

  useEffect(() => {
    if (!project || !from) return;
    let live = true;
    api.git(project.id, from).then((g) => { if (live) setSuggest(g.files.map((f) => f.path)); }).catch(() => { if (live) setSuggest([]); });
    return () => { live = false; };
  }, [project, from]);

  const same = from === to;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.handoff({ fromSessionId: from, toSessionId: to, taskId: task || undefined, path: path.trim(), revision: revision.trim(), note });
      await useRelay.getState().refreshNow();
      useRelay.getState().toast('success', 'Handoff recorded');
    });
  };
  const why = same ? 'Choose two different sessions' : !path.trim() || !revision.trim() ? 'Path and revision are required' : !to ? 'Choose a receiving session' : undefined;

  return (
    <Modal title="Hand off an artifact" description="Share a committed file from one session with another." onClose={close}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="handoff-form" busy={busy} disabled={Boolean(why)} why={why}>Record handoff</Button></>}>
      <form id="handoff-form" className="form" onSubmit={submit}>
        <div className="form-row">
          <Field label="From session" htmlFor="hf-from">
            <select id="hf-from" className="select" value={from} onChange={(e) => setFrom(e.target.value)}>{sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </Field>
          <Field label="To session" htmlFor="hf-to">
            <select id="hf-to" className="select" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose…</option>
              {sessions.filter((s) => s.id !== from).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Task (optional)" htmlFor="hf-task">
          <select id="hf-task" className="select" value={task} onChange={(e) => setTask(e.target.value)}>
            <option value="">None</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </Field>
        <div className="form-row">
          <Field label="Artifact path" htmlFor="hf-path" hint="Relative to the source session’s repository.">
            <input id="hf-path" data-autofocus className="input input--mono" list="hf-paths" value={path} onChange={(e) => setPath(e.target.value)} placeholder="contracts/auth.openapi.json" spellCheck={false} />
            <datalist id="hf-paths">{suggest.map((p) => <option key={p} value={p} />)}</datalist>
          </Field>
          <Field label="Revision" htmlFor="hf-rev" hint="Commit the artifact is committed at.">
            <input id="hf-rev" className="input input--mono" value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="9ab31c" spellCheck={false} />
          </Field>
        </div>
        <Field label="Note" htmlFor="hf-note"><textarea id="hf-note" className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <p className="field__hint">The server verifies the file is committed at that revision. A handoff adds a durable reference to the receiving session; it does not merge anything or start a model run — the receiver sees it on its next explicit run.</p>
        {error ? <InlineError>{error}</InlineError> : null}
      </form>
    </Modal>
  );
}

export function RenameDialog({ sessionId }: { sessionId: string }) {
  const close = useRelay.getState().closeDialog;
  const session = useRelay((s) => s.boot?.sessions.find((x) => x.id === sessionId));
  const [name, setName] = useState(session?.name ?? '');
  const { busy, error, run } = useSubmit(close);
  return (
    <Modal title="Rename session" onClose={close} width={440}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="rename-form" busy={busy} disabled={!name.trim() || name.trim() === session?.name} why="Enter a new name">Rename</Button></>}>
      <form id="rename-form" className="form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.renameSession(sessionId, name.trim()); await useRelay.getState().refreshNow(); }); }}>
        <Field label="Name" htmlFor="rn-name"><input id="rn-name" data-autofocus className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
        {error ? <InlineError>{error}</InlineError> : null}
      </form>
    </Modal>
  );
}

export function ArchiveDialog({ sessionId }: { sessionId: string }) {
  const close = useRelay.getState().closeDialog;
  const session = useRelay((s) => s.boot?.sessions.find((x) => x.id === sessionId));
  const { busy, error, run } = useSubmit(close);
  return (
    <Modal title="Archive session?" onClose={close} width={460}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="danger" busy={busy} onClick={() => void run(async () => { await api.archiveSession(sessionId); await useRelay.getState().refreshNow(); useRelay.getState().toast('info', 'Session archived'); })}>Archive</Button></>}>
      <div className="form">
        <p>“{session?.name ?? 'This session'}” will be removed from the sidebar. Its metadata is kept, and its worktree and branch are <strong>never deleted</strong> by Relay — clean those up with Git when you’re ready.</p>
        {session && (session.status === 'running' || session.status === 'waiting') ? <div className="inline-warn" role="note"><AlertTriangle size={14} /> This session is active. Interrupt it first if you want the run to stop.</div> : null}
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}

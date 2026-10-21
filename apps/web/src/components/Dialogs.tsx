import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMingle, useActiveSession, useProject } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { Button, Field, InlineError, Modal, PROVIDER_NAME } from './ui';
import { SelectMenu } from './SelectMenu';
export { ProjectDialog } from './ProjectDialog';

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

export function TaskDialog() {
  const close = useMingle.getState().closeDialog;
  const project = useProject();
  const allSessions = useMingle((s) => s.boot?.sessions);
  const sessions = useMemo(() => (allSessions ?? []).filter(session => session.projectId === project?.id), [allSessions, project?.id]);
  const allTasks = useMingle((s) => s.boot?.tasks);
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
      await useMingle.getState().refreshNow();
      useMingle.getState().setView('tasks');
      useMingle.getState().selectTask(t.id);
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
          <SelectMenu id="tf-session" label="Assigned session" value={sessionId} onChange={setSessionId} options={[{ value: '', label: 'Unassigned' }, ...sessions.map((s) => ({ value: s.id, label: `${s.name} · ${PROVIDER_NAME[s.provider]}` }))]} />
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
  const close = useMingle.getState().closeDialog;
  const project = useProject();
  const active = useActiveSession();
  const allSessions = useMingle((s) => s.boot?.sessions);
  const allTasks = useMingle((s) => s.boot?.tasks);
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
      await useMingle.getState().refreshNow();
      useMingle.getState().toast('success', 'Handoff recorded');
    });
  };
  const why = same ? 'Choose two different sessions' : !path.trim() || !revision.trim() ? 'Path and revision are required' : !to ? 'Choose a receiving session' : undefined;

  return (
    <Modal title="Hand off an artifact" description="Share a committed file from one session with another." onClose={close}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="handoff-form" busy={busy} disabled={Boolean(why)} why={why}>Record handoff</Button></>}>
      <form id="handoff-form" className="form" onSubmit={submit}>
        <div className="form-row">
          <Field label="From session" htmlFor="hf-from">
            <SelectMenu id="hf-from" label="From session" value={from} onChange={(value) => { setFrom(value); if (value === to) setTo(''); }} options={sessions.map((s) => ({ value: s.id, label: s.name }))} />
          </Field>
          <Field label="To session" htmlFor="hf-to">
            <SelectMenu id="hf-to" label="To session" value={to} onChange={setTo} options={[{ value: '', label: 'Choose a session' }, ...sessions.filter((s) => s.id !== from).map((s) => ({ value: s.id, label: s.name }))]} />
          </Field>
        </div>
        <Field label="Task (optional)" htmlFor="hf-task">
          <SelectMenu id="hf-task" label="Task" value={task} onChange={setTask} options={[{ value: '', label: 'None' }, ...tasks.map((t) => ({ value: t.id, label: t.title }))]} />
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
  const close = useMingle.getState().closeDialog;
  const session = useMingle((s) => s.boot?.sessions.find((x) => x.id === sessionId));
  const [name, setName] = useState(session?.name ?? '');
  const { busy, error, run } = useSubmit(close);
  return (
    <Modal title="Rename session" onClose={close} width={440}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="rename-form" busy={busy} disabled={!name.trim() || name.trim() === session?.name} why="Enter a new name">Rename</Button></>}>
      <form id="rename-form" className="form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.renameSession(sessionId, name.trim()); await useMingle.getState().refreshNow(); }); }}>
        <Field label="Name" htmlFor="rn-name"><input id="rn-name" data-autofocus className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></Field>
        {error ? <InlineError>{error}</InlineError> : null}
      </form>
    </Modal>
  );
}

export function DeleteSessionDialog({ sessionId }: { sessionId: string }) {
  const close = useMingle.getState().closeDialog;
  const session = useMingle((s) => s.boot?.sessions.find((x) => x.id === sessionId));
  const { busy, error, run } = useSubmit(close);
  return (
    <Modal title="Delete session?" onClose={close} width={480}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="danger" busy={busy} onClick={() => void run(async () => {
        const result = await api.deleteSession(sessionId);
        const state = useMingle.getState();
        state.applyArchivedSessions([sessionId]);
        await state.refreshNow();
        state.toast('info', result.notices?.length ? `Session deleted. ${result.notices.join(' ')}` : 'Session deleted. History and project files were retained.');
      })}>Delete session</Button></>}>
      <div className="form">
        <p>“{session?.name ?? 'This session'}” will be removed from the session list. Any active run will be interrupted, its session terminal stopped, and its browser connection disconnected.</p>
        <p>Conversation history and session metadata remain in Mingle. Project files, the worktree and its branch are <strong>never deleted</strong> by Mingle.</p>
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}

export function DeleteGroupDialog({ groupId }: { groupId: string }) {
  const close = useMingle.getState().closeDialog;
  const group = useMingle((s) => s.boot?.groups?.find((item) => item.group.id === groupId));
  const { busy, error, run } = useSubmit(close);
  const memberCount = group?.members.length ?? 0;
  return (
    <Modal title="Delete group?" onClose={close} width={500}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="danger" busy={busy} disabled={!group} why="This group is no longer available" onClick={() => void run(async () => {
        const result = await api.deleteGroup(groupId);
        const state = useMingle.getState();
        state.applyArchivedSessions(result.sessionIds, groupId);
        await state.refreshNow();
        state.toast('info', result.notices.length ? `Group deleted. ${result.notices.join(' ')}` : 'Group deleted. History and project files were retained.');
      })}>Delete group</Button></>}>
      <div className="form">
        <p>“{group?.group.title ?? 'This group'}” and its {memberCount} member sessions will be removed from Mingle. Queued work will be cancelled and running agents interrupted.</p>
        <p>Conversation histories, recovery records and metadata remain in Mingle. Project files, worktrees and branches are <strong>never deleted</strong>. Session terminals will be stopped and browser connections disconnected.</p>
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}

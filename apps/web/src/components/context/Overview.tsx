import { ArrowRightLeft, Archive, FolderGit2, Info, KeyRound, Pencil, Share2 } from 'lucide-react';
import { useRelay, useActiveSession, useProject } from '../../store/store';
import { formatCost, formatCount, relativeTime, shortPath, useNow } from '../../lib/format';
import { Badge, Button, PROVIDER_NAME, ProviderMark, StatusDot } from '../ui';

const KV = ({ k, children, mono }: { k: string; children: React.ReactNode; mono?: boolean }) => (
  <div className="kv"><dt>{k}</dt><dd className={mono ? 'mono' : undefined}>{children}</dd></div>
);

export function Overview() {
  const project = useProject();
  const session = useActiveSession();
  const tasks = useRelay((s) => s.boot?.tasks);
  const sessions = useRelay((s) => s.boot?.sessions);
  const provider = useRelay((s) => s.boot?.providers.find((p) => p.id === session?.provider));
  const { openDialog, selectTask, setView } = useRelay.getState();
  const now = useNow();

  const mine = (tasks ?? []).filter((t) => session && t.sessionId === session.id);
  const otherSessions = (sessions ?? []).filter((s) => s.projectId === project?.id && s.id !== session?.id);

  if (!project) return <div className="pane-pad"><p className="muted">No project selected.</p></div>;

  return (
    <div className="pane-pad stack">
      {session ? (
        <section className="card">
          <header className="card__head">
            <ProviderMark provider={session.provider} size={22} />
            <div className="card__title"><strong>{session.name}</strong><span>{PROVIDER_NAME[session.provider]} · {session.model}</span></div>
            <StatusDot status={session.status} />
          </header>
          {session.error ? <p className="card__error">{session.error}</p> : null}
          <dl className="kvs">
            <KV k="Effort">{session.effort}</KV>
            <KV k="Policy">{session.policy}</KV>
            <KV k="Isolation">{session.isolated ? <Badge tone="ok">Isolated worktree</Badge> : <Badge tone="warn" title="Edits go straight into the project folder">Project folder</Badge>}</KV>
            {session.branch ? <KV k="Branch" mono>{session.branch}</KV> : null}
            <KV k="Path" mono><span title={session.worktreePath}>{shortPath(session.worktreePath, 4)}</span></KV>
            <KV k="Tokens in / out" mono>{formatCount(session.inputTokens)} / {formatCount(session.outputTokens)}</KV>
            <KV k="Cost" mono>{formatCost(session.costUsd)}</KV>
            <KV k="Updated">{relativeTime(session.updatedAt, now)}</KV>
          </dl>
          <div className="card__actions">
            <Button size="sm" onClick={() => openDialog({ kind: 'rename', sessionId: session.id })}><Pencil size={13} /> Rename</Button>
            <Button size="sm" onClick={() => openDialog({ kind: 'handoff', fromSessionId: session.id })} disabled={otherSessions.length === 0} why="Handoffs need a second session in this project"><ArrowRightLeft size={13} /> Handoff</Button>
            <Button size="sm" variant="ghost" onClick={() => openDialog({ kind: 'archive', sessionId: session.id })}><Archive size={13} /> Archive</Button>
          </div>
          {provider && !provider.available ? (
            <p className="card__note card__note--warn"><Info size={13} /> {provider.name} executable unavailable{provider.reason ? `: ${provider.reason}` : ''}. Runs will fail until fixed in Settings.</p>
          ) : provider ? (
            <p className="card__note"><KeyRound size={13} /> {provider.name} executable found{provider.version ? ` (${provider.version})` : ''}. Authentication is checked only when a run starts.</p>
          ) : null}
        </section>
      ) : (
        <section className="card"><p className="muted">No session selected. Pick one in the sidebar or create a new session.</p></section>
      )}

      <section className="card">
        <header className="card__head">
          <span className="card__glyph"><FolderGit2 size={15} /></span>
          <div className="card__title"><strong>{project.name}</strong><span>{project.isExample ? 'Example workspace' : 'Project'}</span></div>
          {project.isExample ? <Badge tone="accent">Example</Badge> : null}
        </header>
        <dl className="kvs">
          <KV k="Path" mono><span title={project.path}>{shortPath(project.path, 4)}</span></KV>
          <KV k="Added">{relativeTime(project.createdAt, now)}</KV>
        </dl>
      </section>

      <section className="card">
        <header className="card__head">
          <span className="card__glyph"><Share2 size={15} /></span>
          <div className="card__title"><strong>Assigned tasks</strong><span>{session ? `${mine.length} for this session` : 'Select a session'}</span></div>
        </header>
        {mine.length === 0 ? (
          <p className="muted small">{session ? 'No tasks are assigned to this session. Assign one from the Tasks view.' : ''}</p>
        ) : (
          <ul className="mini-list">
            {mine.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => { selectTask(t.id); setView('tasks'); }}>
                  <span className={`tdot tdot--${t.status}`} aria-hidden="true" />
                  <span className="mini-list__text">{t.title}</span>
                  <Badge>{t.status}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

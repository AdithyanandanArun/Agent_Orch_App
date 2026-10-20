import { FolderGit2, Info, KeyRound } from 'lucide-react';
import { useRelay, useActiveSession, useProject } from '../../store/store';
import { Badge, PROVIDER_NAME, ProviderMark, StatusDot } from '../ui';
import { ContextCard } from '../automation/ContextSummary';

export function Overview() {
  const project = useProject();
  const session = useActiveSession();
  const tasks = useRelay((s) => s.boot?.tasks);
  const provider = useRelay((s) => s.boot?.providers.find((p) => p.id === session?.provider));
  const { selectTask, setView, openDialog } = useRelay.getState();
  const mine = (tasks ?? []).filter((t) => session && t.sessionId === session.id);

  if (!project) return <div className="pane-pad"><p className="muted">No project selected.</p></div>;

  return (
    <div className="pane-pad stack">
      {session ? (
        <section className="card">
          <header className="card__head">
            <ProviderMark provider={session.provider} size={19} />
            <div className="card__title"><strong>{session.name}</strong><span>{PROVIDER_NAME[session.provider]} · {session.model}</span></div>
            <StatusDot status={session.status} />
          </header>
          {session.error && session.status === 'error' ? <p className="card__error">{session.error}</p> : null}
          {provider && !provider.available ? (
            <p className="card__note card__note--warn"><Info size={13} /><span>{provider.reason || `${provider.name} needs setup.`} <button type="button" className="link-btn" onClick={() => openDialog({ kind: 'settings' })}>Settings</button></span></p>
          ) : provider ? (
            <p className="card__note"><KeyRound size={13} /> {provider.name} is available. Authentication is checked when a run starts.</p>
          ) : null}
        </section>
      ) : <section className="card"><p className="muted">No session selected.</p></section>}

      <section className="card">
        <header className="card__head">
          <span className="card__glyph"><FolderGit2 size={15} /></span>
          <div className="card__title"><strong>{project.name}</strong><span>{project.isExample ? 'Example workspace' : project.path}</span></div>
          {project.isExample ? <Badge tone="neutral">Example</Badge> : null}
        </header>
      </section>

      <ContextCard projectId={project.id} />

      {mine.length > 0 ? (
        <section className="card">
          <header className="card__head"><div className="card__title"><strong>Assigned tasks</strong><span>{mine.length} for this session</span></div></header>
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
        </section>
      ) : null}
    </div>
  );
}

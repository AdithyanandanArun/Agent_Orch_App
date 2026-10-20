import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import type { ProjectContext } from '@relay/contracts';
import { useProjectContext } from '../../store/projectContext';
import { relativeTime, useNow } from '../../lib/format';
import { Badge, Button } from '../ui';
import { shortSha } from '../git/gitUtil';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function languageSummary(context: ProjectContext, limit = 3): string {
  const top = [...context.languages].sort((a, b) => b.files - a.files).slice(0, limit);
  return top.map((l) => `${l.name} ${l.files}`).join(' · ');
}

/** One honest line about the project scan: what was read, when, and what could not be. */
export function ContextStrip({ projectId }: { projectId: string }) {
  const { entry, rescan, reload } = useProjectContext(projectId);
  const now = useNow();
  const { context, error, loading, refreshing } = entry;
  const indexing = context?.status === 'indexing';

  let summary;
  if (!context) {
    summary = error
      ? <span className="ctxstrip__err" role="alert"><AlertTriangle size={13} aria-hidden="true" /> Project scan unavailable: {error} <button type="button" className="link-btn" onClick={() => void reload()}>Retry</button></span>
      : <span role="status"><Loader2 size={12} className="spin" aria-hidden="true" /> {loading ? 'Reading project scan…' : 'Waiting for project scan…'}</span>;
  } else if (indexing || refreshing) {
    summary = <span role="status"><Loader2 size={12} className="spin" aria-hidden="true" /> Scanning project files…{context.scannedAt ? ` Last complete scan ${relativeTime(context.scannedAt, now)}.` : ''}</span>;
  } else if (context.status === 'error') {
    summary = <span className="ctxstrip__err" role="alert"><AlertTriangle size={13} aria-hidden="true" /> Scan failed{context.error ? `: ${context.error}` : ''}. Tasks and the map keep their last known data.</span>;
  } else if (!context.scannedAt) {
    summary = <span>This project has not been scanned yet.</span>;
  } else {
    summary = (
      <span>
        Scanned {relativeTime(context.scannedAt, now)} · {plural(context.fileCount, 'file')} · {plural(context.components.length, 'component')}
        {context.languages.length ? ` · ${languageSummary(context)}` : ''}
        {' · '}{plural(context.taskCount, 'task')} detected
      </span>
    );
  }

  return (
    <div className="ctxstrip">
      <div className="ctxstrip__main">
        {summary}
        {context && !context.isRepo ? <Badge title="Git history, branches and changed files are unavailable for this folder.">Not a Git repository</Badge> : null}
        {error && context ? <span className="ctxstrip__err" role="alert">Couldn’t refresh: {error}</span> : null}
      </div>
      {context?.notices.length ? <details className="ctxstrip__notes"><summary>{plural(context.notices.length, 'notice')}</summary><ul>{context.notices.map((n, i) => <li key={`${i}:${n}`}>{n}</li>)}</ul></details> : null}
      <Button size="sm" variant="ghost" busy={refreshing} disabled={indexing} why={indexing ? 'A scan is already running' : undefined} onClick={() => void rescan()} title="Scan the project again"><RefreshCw size={12} /> Rescan</Button>
    </div>
  );
}

/** Fuller scan details for the overview pane: repository position, recent commits and components. */
export function ContextCard({ projectId }: { projectId: string }) {
  const { entry, rescan, reload } = useProjectContext(projectId);
  const now = useNow();
  const { context, error, loading, refreshing } = entry;
  return (
    <section className="card">
      <header className="card__head">
        <div className="card__title"><strong>Project scan</strong><span>{context?.scannedAt ? `Scanned ${relativeTime(context.scannedAt, now)}` : loading ? 'Reading…' : 'Not scanned'}</span></div>
        <Button size="sm" variant="ghost" busy={refreshing || context?.status === 'indexing'} onClick={() => void rescan()} title="Scan the project again"><RefreshCw size={12} /> Rescan</Button>
      </header>
      {error ? <p className="card__error" role="alert">{error} <button type="button" className="link-btn" onClick={() => void reload()}>Retry</button></p> : null}
      {context?.status === 'error' && context.error ? <p className="card__error">{context.error}</p> : null}
      {context ? (
        <dl className="ctxcard__facts">
          <dt>Files</dt><dd>{context.fileCount}{context.languages.length ? ` · ${languageSummary(context, 4)}` : ''}</dd>
          <dt>Components</dt><dd>{context.components.length === 0 ? 'None detected' : context.components.slice(0, 6).map((c) => c.name).join(', ') + (context.components.length > 6 ? `, +${context.components.length - 6} more` : '')}</dd>
          {context.isRepo ? <><dt>Branch</dt><dd>{context.branch ?? 'detached'}{context.head ? <> · <code>{shortSha(context.head)}</code></> : ' · no commits yet'}</dd></> : <><dt>Git</dt><dd>Not a Git repository</dd></>}
          {context.isRepo ? <><dt>Changed</dt><dd>{context.changedPaths.length === 0 ? 'No changed paths' : plural(context.changedPaths.length, 'path')}</dd></> : null}
          <dt>Tasks</dt><dd>{plural(context.taskCount, 'task')} detected</dd>
        </dl>
      ) : !error ? <p className="muted small">The project scan has not returned yet.</p> : null}
      {context && context.recentCommits.length > 0 ? (
        <>
          <h4 className="mini-h">Recent commits</h4>
          <ul className="ctxcard__commits">{context.recentCommits.slice(0, 5).map((c) => <li key={c.sha}><code>{shortSha(c.sha)}</code><span title={c.title}>{c.title}</span><time dateTime={c.authoredAt}>{relativeTime(c.authoredAt, now)}</time></li>)}</ul>
        </>
      ) : null}
      {context?.notices.map((n, i) => <p key={`${i}:${n}`} className="field__hint">{n}</p>)}
    </section>
  );
}

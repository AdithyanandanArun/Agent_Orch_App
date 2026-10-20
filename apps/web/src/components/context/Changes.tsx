import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, FileCode2, GitBranch, RefreshCw } from 'lucide-react';
import type { GitStatus } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { useActiveSession, useMingle } from '../../store/store';
import { useEditor } from '../../store/editor';
import { parseDiff, type DiffFile } from '../../lib/diff';
import { cx } from '../../lib/format';
import { usePresence } from '../../lib/motion';
import { Badge, EmptyState, IconButton, InlineError, Spinner } from '../ui';
import { ScopeSwitch, useScopeIds } from './scope';

const LINE_CAP = 1500;

const statusTone = (s: string): 'ok' | 'warn' | 'err' | 'info' | 'neutral' => {
  const c = s.trim()[0] ?? '';
  return c === 'A' || c === '?' ? 'ok' : c === 'D' ? 'err' : c === 'M' ? 'warn' : c === 'R' ? 'info' : 'neutral';
};

const DiffBlock = memo(function DiffBlock({ file, projectId, sessionId }: { file: DiffFile; projectId: string; sessionId: string | null }) {
  const [open, setOpen] = useState(true);
  const { present: bodyPresent, closing: bodyClosing } = usePresence(open);
  const [all, setAll] = useState(false);
  const shown = all ? file.lines : file.lines.slice(0, LINE_CAP);
  return (
    <section className="diff" id={`diff-${encodeURIComponent(file.path)}`}>
      <header className="diff__head">
        <button type="button" className="diff__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ChevronRight size={13} className={cx('trow__chev', open && 'is-open')} aria-hidden="true" />
          <span className="diff__path" title={file.path}>{file.path}</span>
        </button>
        <span className="diff__stat"><b className="add">+{file.adds}</b> <b className="del">−{file.dels}</b></span>
        <IconButton label={`Open ${file.path} in editor`} onClick={() => { useMingle.getState().setView('workspace'); useEditor.getState().open(projectId, sessionId, file.path); }}><FileCode2 size={13} /></IconButton>
      </header>
      {bodyPresent ? (
        <div className={cx('diff__body-frame', bodyClosing && 'is-closing')} aria-hidden={bodyClosing || undefined} inert={bodyClosing}>
          <div className="diff__body" role="table" aria-label={`Diff for ${file.path}`}>
            {file.binary ? <p className="muted small pane-pad">Binary file changed.</p> : null}
            {shown.map((l, i) => (
              <div key={i} role="row" className={cx('dl', `dl--${l.kind}`)}>
                <span className="dl__no" aria-hidden="true">{l.oldNo ?? ''}</span>
                <span className="dl__no" aria-hidden="true">{l.newNo ?? ''}</span>
                <span className="dl__sign" aria-hidden="true">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
                <code className="dl__text">{l.text || ' '}</code>
              </div>
            ))}
            {!all && file.lines.length > LINE_CAP ? <button type="button" className="link-btn pane-pad" onClick={() => setAll(true)}>Show {file.lines.length - LINE_CAP} more lines</button> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
});

export function Changes({ active }: { active: boolean }) {
  const ids = useScopeIds();
  const rev = useActiveSession()?.updatedAt;
  const [git, setGit] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ids.projectId) return;
    setLoading(true);
    try {
      setGit(await api.git(ids.projectId, ids.sessionId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [ids.projectId, ids.sessionId]);

  useEffect(() => { setGit(null); setFilter(null); }, [ids.projectId, ids.sessionId]);
  useEffect(() => { if (active) void load(); }, [active, load, rev]);

  const files = useMemo(() => parseDiff(git?.diff ?? ''), [git?.diff]);
  const visible = filter ? files.filter((f) => f.path === filter) : files;

  return (
    <div className="panel-col">
      <div className="panel-tools">
        <ScopeSwitch />
        <IconButton label="Refresh changes" onClick={() => void load()}><RefreshCw size={13} className={loading ? 'spin' : ''} /></IconButton>
      </div>
      <div className="panel-scroll">
        {error ? <div className="pane-pad"><InlineError onRetry={() => void load()}>{error}</InlineError></div> : null}
        {!git && !error ? <div className="pane-pad"><Spinner label="Loading changes" /></div> : null}
        {git && !git.isRepo ? (
          <EmptyState title="Not a Git repository" icon={<GitBranch size={20} />}>Changes are read from Git. This folder is not a repository, so there is nothing to diff.</EmptyState>
        ) : null}
        {git?.isRepo ? (
          <>
            <div className="changes__summary">
              <span className="chip chip--mono"><GitBranch size={12} aria-hidden="true" />{git.branch || 'detached'}</span>
              <span className="muted small">{git.files.length === 0 ? 'Clean working tree' : `${git.files.length} changed file${git.files.length === 1 ? '' : 's'}`}</span>
              {filter ? <button type="button" className="link-btn small" onClick={() => setFilter(null)}>Show all</button> : null}
            </div>
            {git.files.length === 0 ? (
              <EmptyState title="No changes yet">Edits from the session or the editor will appear here. Use the Git controls below the composer to commit or push changes.</EmptyState>
            ) : (
              <ul className="flist">
                {git.files.map((f) => (
                  <li key={f.path}>
                    <button type="button" className={cx('flist__row', filter === f.path && 'is-active')} onClick={() => { setFilter(filter === f.path ? null : f.path); }} title={f.path}>
                      <Badge tone={statusTone(f.status)}>{f.status.trim() || '·'}</Badge>
                      <span>{f.path}</span>
                      {!files.some((d) => d.path === f.path) ? <em title="No textual diff available (for example an untracked file)">no diff</em> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {ids.projectId ? visible.map((f) => <DiffBlock key={f.path} file={f} projectId={ids.projectId!} sessionId={ids.sessionId} />) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

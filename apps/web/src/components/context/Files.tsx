import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, File as FileIcon, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import type { FileEntry } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { useMingle, useActiveSession } from '../../store/store';
import { useEditor } from '../../store/editor';
import { cx } from '../../lib/format';
import { EmptyState, IconButton, InlineError, Spinner } from '../ui';
import { ScopeSwitch, useScopeIds } from './scope';

interface Dir { status: 'loading' | 'ready' | 'error'; entries: FileEntry[]; error?: string }

function Tree({ projectId, sessionId, active }: { projectId: string; sessionId: string | null; active: boolean }) {
  const [dirs, setDirs] = useState<Record<string, Dir>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set(['']));
  const rootRef = useRef<HTMLDivElement>(null);
  const rev = useActiveSession()?.updatedAt;
  const editorTabs = useEditor((s) => s.tabs);
  const centerTab = useMingle((s) => s.centerTab);
  const currentKey = editorTabs.find((t) => t.key === centerTab);

  const load = useCallback(async (dir: string) => {
    setDirs((d) => ({ ...d, [dir]: { status: 'loading', entries: d[dir]?.entries ?? [] } }));
    try {
      const entries = await api.listFiles(projectId, dir, sessionId);
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
      setDirs((d) => ({ ...d, [dir]: { status: 'ready', entries } }));
    } catch (e) {
      setDirs((d) => ({ ...d, [dir]: { status: 'error', entries: [], error: errorMessage(e) } }));
    }
  }, [projectId, sessionId]);

  useEffect(() => { void load(''); }, [load]);

  // Agents edit files while they run; refresh expanded folders when the session record changes.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (active) open.forEach((d) => void load(d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  const toggle = (path: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else { next.add(path); if (!dirs[path]) void load(path); }
      return next;
    });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { rows[Math.min(rows.length - 1, i + 1)]?.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { rows[Math.max(0, i - 1)]?.focus(); e.preventDefault(); }
  };

  const renderDir = (dir: string, depth: number) => {
    const d = dirs[dir];
    if (!d) return null;
    if (d.status === 'error') return <div style={{ paddingLeft: 12 + depth * 14 }}><InlineError onRetry={() => void load(dir)}>{d.error}</InlineError></div>;
    return (
      <>
        {d.entries.map((entry) => {
          const isDir = entry.type === 'directory';
          const expanded = isDir && open.has(entry.path);
          return (
            <div key={entry.path} role="none">
              <button
                type="button" role="treeitem" aria-expanded={isDir ? expanded : undefined} aria-selected={currentKey?.path === entry.path && currentKey.sessionId === sessionId}
                className={cx('trow', currentKey?.path === entry.path && currentKey.sessionId === sessionId && 'is-active')}
                style={{ paddingLeft: 8 + depth * 14 }} title={entry.path}
                onClick={() => {
                  if (isDir) toggle(entry.path);
                  else { useMingle.getState().setView('workspace'); useEditor.getState().open(projectId, sessionId, entry.path); }
                }}
              >
                {isDir ? <ChevronRight size={12} className={cx('trow__chev', expanded && 'is-open')} aria-hidden="true" /> : <span className="trow__chev" />}
                {isDir ? (expanded ? <FolderOpen size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />) : <FileIcon size={14} aria-hidden="true" />}
                <span>{entry.name}</span>
              </button>
              {expanded ? (
                <div role="group">
                  {dirs[entry.path]?.status === 'loading' && !dirs[entry.path]?.entries.length ? <div className="trow trow--loading" style={{ paddingLeft: 30 + depth * 14 }}><Spinner /></div> : null}
                  {renderDir(entry.path, depth + 1)}
                </div>
              ) : null}
            </div>
          );
        })}
        {d.status === 'ready' && d.entries.length === 0 && dir === '' ? <p className="muted small pane-pad">This folder is empty.</p> : null}
      </>
    );
  };

  const root = dirs[''];
  return (
    <div className="tree" role="tree" aria-label="Files" ref={rootRef} onKeyDown={onKey}>
      <div className="tree__tools">
        <span className="muted small">{root?.status === 'loading' ? 'Loading…' : 'Explorer'}</span>
        <IconButton label="Refresh files" onClick={() => open.forEach((d) => void load(d))}><RefreshCw size={13} className={root?.status === 'loading' ? 'spin' : ''} /></IconButton>
      </div>
      {root?.status === 'loading' && !root.entries.length ? <div className="pane-pad"><Spinner label="Loading files" /></div> : renderDir('', 0)}
    </div>
  );
}

export function Files({ active }: { active: boolean }) {
  const ids = useScopeIds();
  return (
    <div className="panel-col">
      <div className="panel-tools"><ScopeSwitch /></div>
      {ids.projectId ? (
        <div className="panel-scroll"><Tree key={`${ids.projectId}:${ids.sessionId}`} projectId={ids.projectId} sessionId={ids.sessionId} active={active} /></div>
      ) : (
        <EmptyState title="No project">Open a project to browse its files.</EmptyState>
      )}
      <p className="panel-foot">Paths outside the scope, <code>.git</code> and secret files are refused by the server.</p>
    </div>
  );
}

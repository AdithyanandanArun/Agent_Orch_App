import { useEffect, useRef, useState } from 'react';
import { Eye, FileText, GitCompare, Info, X } from 'lucide-react';
import { useRelay, type ContextTab } from '../store/store';
import { cx } from '../lib/format';
import { Boundary, IconButton } from './ui';
import { Overview } from './context/Overview';
import { Files } from './context/Files';
import { Changes } from './context/Changes';
import { Preview } from './context/Preview';

const TABS: { id: ContextTab; label: string; icon: typeof Info }[] = [
  { id: 'overview', label: 'Overview', icon: Info },
  { id: 'files', label: 'Files', icon: FileText },
  { id: 'changes', label: 'Changes', icon: GitCompare },
  { id: 'preview', label: 'Preview', icon: Eye },
];

export function ContextPane() {
  const tab = useRelay((s) => s.contextTab);
  const open = useRelay((s) => s.contextOpen);
  const { setContextTab, toggleContext } = useRelay.getState();
  const [visited, setVisited] = useState<Set<ContextTab>>(() => new Set([tab]));
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab))), [tab]);

  const onKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    if (e.key === 'ArrowRight') setContextTab(TABS[(i + 1) % TABS.length]!.id);
    else if (e.key === 'ArrowLeft') setContextTab(TABS[(i + TABS.length - 1) % TABS.length]!.id);
    else return;
    e.preventDefault();
    window.requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };

  return (
    <aside className={cx('context', open && 'is-open')} aria-label="Context" aria-hidden={!open}>
      <div className="context__tabs" role="tablist" aria-label="Context sections" ref={listRef} onKeyDown={onKey}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" role="tab" id={`ctx-tab-${id}`} aria-selected={tab === id} aria-controls={`ctx-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={cx('ctab', tab === id && 'is-active')} onClick={() => setContextTab(id)}>
            <Icon size={13} aria-hidden="true" />{label}
          </button>
        ))}
        <IconButton label="Close context pane" className="context__close" onClick={() => toggleContext(false)}><X size={15} /></IconButton>
      </div>
      <div className="context__body">
        {TABS.map(({ id }) => (
          <div key={id} role="tabpanel" id={`ctx-panel-${id}`} aria-labelledby={`ctx-tab-${id}`} hidden={tab !== id} className="context__panel">
            {visited.has(id) ? (
              <Boundary label={`${id[0]!.toUpperCase()}${id.slice(1)}`}>
                {id === 'overview' ? <Overview /> : id === 'files' ? <Files active={tab === id} /> : id === 'changes' ? <Changes active={tab === id} /> : <Preview />}
              </Boundary>
            ) : null}
          </div>
        ))}
      </div>
    </aside>
  );
}

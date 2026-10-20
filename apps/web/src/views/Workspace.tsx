import { Suspense, lazy, useCallback, useEffect, useRef } from 'react';
import { FileCode2, X } from 'lucide-react';
import { useMingle, useProject } from '../store/store';
import { isDirty, useEditor } from '../store/editor';
import { cx } from '../lib/format';
import { Boundary, Badge, Spinner } from '../components/ui';
import { SessionPane } from '../components/Chat';
import { ContextPane } from '../components/ContextPane';

const EditorPane = lazy(() => import('../components/EditorPane'));
const TerminalPanel = lazy(() => import('../components/TerminalPanel'));

function CenterTabs() {
  const tabs = useEditor((s) => s.tabs);
  const centerTab = useMingle((s) => s.centerTab);
  const sessions = useMingle((s) => s.boot?.sessions);
  if (tabs.length === 0) return null;
  return (
    <div className="ctabs" role="tablist" aria-label="Open views">
      <button type="button" role="tab" aria-selected={centerTab === 'session'} className={cx('ctabs__tab', centerTab === 'session' && 'is-active')} onClick={() => useMingle.getState().setCenterTab('session')}>Session</button>
      {tabs.map((t) => {
        const scope = t.sessionId ? sessions?.find((s) => s.id === t.sessionId)?.name : undefined;
        return (
          <div key={t.key} className={cx('ctabs__tab ctabs__tab--file', centerTab === t.key && 'is-active')} role="presentation">
            <button type="button" role="tab" aria-selected={centerTab === t.key} onClick={() => useMingle.getState().setCenterTab(t.key)} title={scope ? `${t.path} — ${scope}` : t.path}>
              <FileCode2 size={13} aria-hidden="true" />{t.label}{isDirty(t) ? <i className="dirty" aria-label="unsaved changes" /> : null}
            </button>
            <button type="button" className="ctabs__x" aria-label={`Close ${t.path}`} onClick={() => useEditor.getState().close(t.key)}><X size={12} /></button>
          </div>
        );
      })}
    </div>
  );
}

function ExampleBanner() {
  const project = useProject();
  if (!project?.isExample) return null;
  return (
    <div className="banner banner--example" role="note">
      <span><strong>Example workspace</strong><span aria-hidden="true"> · </span>Messages start real runs with your configured provider.</span>
    </div>
  );
}

export function Workspace() {
  const centerTab = useMingle((s) => s.centerTab);
  const tabs = useEditor((s) => s.tabs);
  const terminalOpen = useMingle((s) => s.terminalOpen);
  const termHeight = useMingle((s) => s.terminalHeight);
  const contextOpen = useMingle((s) => s.contextOpen);
  const editorActive = centerTab !== 'session' && tabs.some((t) => t.key === centerTab);
  const drag = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    if (centerTab !== 'session' && !tabs.some((t) => t.key === centerTab)) useMingle.getState().setCenterTab('session');
  }, [centerTab, tabs]);

  const onDrag = useCallback((e: PointerEvent) => {
    if (!drag.current) return;
    const h = Math.max(140, Math.min(window.innerHeight * 0.7, drag.current.h + (drag.current.y - e.clientY)));
    useMingle.getState().setTerminalHeight(Math.round(h));
  }, []);
  const endDrag = useCallback(() => {
    drag.current = null;
    window.removeEventListener('pointermove', onDrag);
    window.removeEventListener('pointerup', endDrag);
    document.body.style.userSelect = '';
  }, [onDrag]);

  return (
    <div className={cx('workspace', contextOpen && 'has-context')}>
      <div className="workspace__center">
        <ExampleBanner />
        <CenterTabs />
        <div className="workspace__main">
          <div className="workspace__pane" hidden={editorActive}><SessionPane /></div>
          {tabs.length > 0 ? (
            <div className="workspace__pane" hidden={!editorActive}>
              {editorActive ? (
                <Boundary label="Editor">
                  <Suspense fallback={<div className="editor__state"><Spinner label="Loading editor" /><span className="muted small">Loading editor…</span></div>}>
                    <EditorPane tabKey={centerTab} />
                  </Suspense>
                </Boundary>
              ) : null}
            </div>
          ) : null}
        </div>
        {terminalOpen ? (
          <div className="workspace__term" style={{ height: termHeight }}>
            <div
              className="resizer" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" tabIndex={0}
              onPointerDown={(e) => {
                drag.current = { y: e.clientY, h: termHeight };
                document.body.style.userSelect = 'none';
                window.addEventListener('pointermove', onDrag);
                window.addEventListener('pointerup', endDrag);
                e.preventDefault();
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') useMingle.getState().setTerminalHeight(Math.min(termHeight + 24, Math.round(window.innerHeight * 0.7)));
                if (e.key === 'ArrowDown') useMingle.getState().setTerminalHeight(Math.max(140, termHeight - 24));
              }}
            />
            <Boundary label="Terminal">
              <Suspense fallback={<div className="editor__state"><Spinner label="Loading terminal" /><Badge>Loading terminal…</Badge></div>}><TerminalPanel /></Suspense>
            </Boundary>
          </div>
        ) : null}
      </div>
      <ContextPane />
      <button type="button" className={cx('context-scrim', contextOpen && 'is-open')} aria-label="Close context pane" aria-hidden={!contextOpen} inert={!contextOpen} tabIndex={-1} onClick={() => useMingle.getState().toggleContext(false)} />
    </div>
  );
}

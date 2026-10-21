import { Suspense, lazy, useEffect, useRef, type ReactNode } from 'react';
import { useMingle } from './store/store';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Workspace } from './views/Workspace';
import { TasksView } from './views/Tasks';
import { ActivityView } from './views/Activity';
import { ConnectionBanner, StartupScreen, Toasts } from './components/Shell';
import { ArchiveDialog, HandoffDialog, ProjectDialog, RenameDialog, TaskDialog } from './components/Dialogs';
import { ImportDialog } from './components/ImportDialog';
import { SettingsPage } from './components/Settings';
import { Palette, ShortcutsDialog } from './components/Palette';
import { Boundary, DialogMotionContext, Spinner } from './components/ui';
import { cx } from './lib/format';
import { useRetainedPresence } from './lib/motion';
import { AddAgentDialog } from './components/group/AddAgentDialog';
import { GroupModeDialog, MemberSettingsDialog } from './components/group/GroupDialogs';
import { BrowserPopout } from './components/browser/BrowserPopout';

const AgentMap = lazy(() => import('./views/AgentMap'));

function Dialogs() {
  const dialog = useMingle((s) => s.dialog);
  const { value: active, present, closing, key } = useRetainedPresence(dialog, 160);
  if (!present || !active) return null;
  let content: ReactNode = null;
  switch (active.kind) {
    case 'project': content = <ProjectDialog />; break;
    case 'task': content = <TaskDialog />; break;
    case 'handoff': content = <HandoffDialog taskId={active.taskId} fromSessionId={active.fromSessionId} />; break;
    case 'settings': break; // Legacy actions route to the Settings page through the store.
    case 'palette': content = <Palette />; break;
    case 'rename': content = <RenameDialog sessionId={active.sessionId} />; break;
    case 'archive': content = <ArchiveDialog sessionId={active.sessionId} />; break;
    case 'import': content = <ImportDialog />; break;
    case 'shortcuts': content = <ShortcutsDialog />; break;
    case 'add-agent': content = <AddAgentDialog sessionId={active.sessionId} />; break;
    case 'group-mode': content = <GroupModeDialog groupId={active.groupId} />; break;
    case 'member-settings': content = <MemberSettingsDialog groupId={active.groupId} memberId={active.memberId} />; break;
  }
  return <DialogMotionContext.Provider key={key} value={closing}>{content}</DialogMotionContext.Provider>;
}

export function App() {
  const boot = useMingle((s) => s.boot);
  const view = useMingle((s) => s.view);
  const theme = useMingle((s) => s.boot?.settings.theme ?? 'dark');
  const sidebarOpen = useMingle((s) => s.sidebarOpen);
  const previousView = useRef(view);

  useEffect(() => { useMingle.getState().init(); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (view === 'settings') document.getElementById('settings-title')?.focus({ preventScroll: true });
    else if (previousView.current === 'settings') {
      const state = useMingle.getState();
      const sessionId = state.activeProjectId ? state.sessionByProject[state.activeProjectId] : undefined;
      const composer = view === 'workspace' && state.centerTab === 'session' && sessionId ? document.getElementById(`composer-${sessionId}`) : null;
      (composer ?? document.getElementById('main'))?.focus({ preventScroll: true });
    }
    previousView.current = view;
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = useMingle.getState();
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (s.dialog?.kind === 'palette') s.closeDialog();
        else s.openDialog({ kind: 'palette' });
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        s.toggleTerminal();
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        if (s.dialog) s.closeDialog();
        else if (s.sidebarOpen) s.setSidebarOpen(false);
        else if (s.selectedTaskId && s.view === 'tasks') s.selectTask(null);
        else if (s.contextOpen && window.innerWidth < 1240) s.toggleContext(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!boot) return <StartupScreen />;

  const browserPopoutId = new URLSearchParams(window.location.search).get('browserPopout');
  if (browserPopoutId) return <BrowserPopout sessionId={browserPopoutId} />;

  return (
    <div className={cx('app', `view-${view}`)}>
      <a className="skip" href="#main">Skip to content</a>
      <Sidebar />
      <button type="button" className={cx('sidebar-scrim', sidebarOpen && 'is-open')} aria-label="Close sidebar" aria-hidden={!sidebarOpen} inert={!sidebarOpen} tabIndex={-1} onClick={() => useMingle.getState().setSidebarOpen(false)} />
      <main className="main" id="main" tabIndex={-1}>
        <Header />
        <ConnectionBanner />
        <div className="main__body">
          <Boundary label="This view">
            {view === 'workspace' ? <Workspace /> : null}
            {view === 'tasks' ? <TasksView /> : null}
            {view === 'activity' ? <ActivityView /> : null}
            {view === 'map' ? <Suspense fallback={<div className="editor__state"><Spinner label="Loading map" /></div>}><AgentMap /></Suspense> : null}
            {view === 'settings' ? <SettingsPage /> : null}
          </Boundary>
        </div>
      </main>
      <Dialogs />
      <Toasts />
    </div>
  );
}

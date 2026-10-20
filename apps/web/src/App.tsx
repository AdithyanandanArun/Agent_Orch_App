import { Suspense, lazy, useEffect, useRef } from 'react';
import { useRelay } from './store/store';
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
import { Boundary, Spinner } from './components/ui';
import { cx } from './lib/format';
import { AddAgentDialog } from './components/group/AddAgentDialog';
import { GroupModeDialog, MemberSettingsDialog } from './components/group/GroupDialogs';

const AgentMap = lazy(() => import('./views/AgentMap'));

function Dialogs() {
  const dialog = useRelay((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'project': return <ProjectDialog />;
    case 'task': return <TaskDialog />;
    case 'handoff': return <HandoffDialog taskId={dialog.taskId} fromSessionId={dialog.fromSessionId} />;
    case 'settings': return null; // Legacy actions route to the Settings page through the store.
    case 'palette': return <Palette />;
    case 'rename': return <RenameDialog sessionId={dialog.sessionId} />;
    case 'archive': return <ArchiveDialog sessionId={dialog.sessionId} />;
    case 'import': return <ImportDialog />;
    case 'shortcuts': return <ShortcutsDialog />;
    case 'add-agent': return <AddAgentDialog sessionId={dialog.sessionId} />;
    case 'group-mode': return <GroupModeDialog groupId={dialog.groupId} />;
    case 'member-settings': return <MemberSettingsDialog groupId={dialog.groupId} memberId={dialog.memberId} />;
  }
}

export function App() {
  const boot = useRelay((s) => s.boot);
  const view = useRelay((s) => s.view);
  const theme = useRelay((s) => s.boot?.settings.theme ?? 'dark');
  const sidebarOpen = useRelay((s) => s.sidebarOpen);
  const previousView = useRef(view);

  useEffect(() => { useRelay.getState().init(); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    if (view === 'settings') document.getElementById('settings-title')?.focus({ preventScroll: true });
    else if (previousView.current === 'settings') {
      const state = useRelay.getState();
      const sessionId = state.activeProjectId ? state.sessionByProject[state.activeProjectId] : undefined;
      const composer = view === 'workspace' && state.centerTab === 'session' && sessionId ? document.getElementById(`composer-${sessionId}`) : null;
      (composer ?? document.getElementById('main'))?.focus({ preventScroll: true });
    }
    previousView.current = view;
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = useRelay.getState();
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

  return (
    <div className={cx('app', `view-${view}`)}>
      <a className="skip" href="#main">Skip to content</a>
      <Sidebar />
      <button type="button" className={cx('sidebar-scrim', sidebarOpen && 'is-open')} aria-label="Close sidebar" aria-hidden={!sidebarOpen} inert={!sidebarOpen} tabIndex={-1} onClick={() => useRelay.getState().setSidebarOpen(false)} />
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

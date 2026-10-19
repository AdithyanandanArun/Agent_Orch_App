import { Suspense, lazy, useEffect } from 'react';
import { useRelay } from './store/store';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Workspace } from './views/Workspace';
import { TasksView } from './views/Tasks';
import { ActivityView } from './views/Activity';
import { ConnectionBanner, StartupScreen, Toasts } from './components/Shell';
import { ArchiveDialog, HandoffDialog, ProjectDialog, RenameDialog, TaskDialog } from './components/Dialogs';
import { SettingsSheet } from './components/Settings';
import { Palette, ShortcutsDialog } from './components/Palette';
import { Boundary, Spinner } from './components/ui';
import { cx } from './lib/format';

const AgentMap = lazy(() => import('./views/AgentMap'));

function Dialogs() {
  const dialog = useRelay((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'project': return <ProjectDialog />;
    case 'task': return <TaskDialog />;
    case 'handoff': return <HandoffDialog taskId={dialog.taskId} fromSessionId={dialog.fromSessionId} />;
    case 'settings': return <SettingsSheet />;
    case 'palette': return <Palette />;
    case 'rename': return <RenameDialog sessionId={dialog.sessionId} />;
    case 'archive': return <ArchiveDialog sessionId={dialog.sessionId} />;
    case 'shortcuts': return <ShortcutsDialog />;
  }
}

export function App() {
  const boot = useRelay((s) => s.boot);
  const view = useRelay((s) => s.view);
  const theme = useRelay((s) => s.boot?.settings.theme ?? 'dark');
  const sidebarOpen = useRelay((s) => s.sidebarOpen);

  useEffect(() => { useRelay.getState().init(); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

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
      {sidebarOpen ? <button type="button" className="sidebar-scrim" aria-label="Close sidebar" tabIndex={-1} onClick={() => useRelay.getState().setSidebarOpen(false)} /> : null}
      <main className="main" id="main">
        <Header />
        <ConnectionBanner />
        <div className="main__body">
          <Boundary label="This view">
            {view === 'workspace' ? <Workspace /> : null}
            {view === 'tasks' ? <TasksView /> : null}
            {view === 'activity' ? <ActivityView /> : null}
            {view === 'map' ? <Suspense fallback={<div className="editor__state"><Spinner label="Loading map" /></div>}><AgentMap /></Suspense> : null}
          </Boundary>
        </div>
      </main>
      <Dialogs />
      <Toasts />
    </div>
  );
}

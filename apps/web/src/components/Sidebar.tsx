import { Activity, ChevronsUpDown, FolderOpen, FolderPlus, Kanban, LayoutPanelLeft, MoreHorizontal, Network, Search, Settings, SquarePen, Loader2 } from 'lucide-react';
import type { Session } from '@relay/contracts';
import { useRelay, useProject, type View } from '../store/store';
import { cx, relativeTime, useNow } from '../lib/format';
import { IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, StatusDot } from './ui';

const VIEWS: { view: View; label: string; icon: typeof Kanban }[] = [
  { view: 'tasks', label: 'Tasks', icon: Kanban }, { view: 'activity', label: 'Activity', icon: Activity }, { view: 'map', label: 'Agent map', icon: Network },
];
const GROUPS: { id: string; label: string; match: (session: Session) => boolean }[] = [
  { id: 'attention', label: 'Needs attention', match: (session) => session.status === 'waiting' || session.status === 'error' },
  { id: 'running', label: 'Running', match: (session) => session.status === 'running' },
  { id: 'idle', label: 'Sessions', match: (session) => session.status === 'idle' || session.status === 'interrupted' },
];

export function Sidebar() {
  const boot = useRelay((state) => state.boot);
  const project = useProject();
  const view = useRelay((state) => state.view);
  const sidebarOpen = useRelay((state) => state.sidebarOpen);
  const activeSessionId = useRelay((state) => state.activeProjectId ? state.sessionByProject[state.activeProjectId] : undefined);
  const connection = useRelay((state) => state.connection);
  const creatingSession = useRelay((state) => state.creatingSession);
  const { setView, selectSession, selectProject, openDialog, createSession } = useRelay.getState();
  const now = useNow();
  const sessions = (boot?.sessions ?? []).filter((session) => session.projectId === project?.id);
  const connectionLabel = connection === 'online' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Disconnected';

  return <aside className={cx('sidebar', sidebarOpen && 'is-open')} aria-label="Primary">
    <div className="sidebar__brand"><span className="brand-name">Relay</span><span className="sidebar__local">local</span></div>
    <div className="sidebar__toolbar">
      <button type="button" className="sidebar__search" onClick={() => openDialog({ kind: 'palette' })} aria-label="Search sessions and commands"><Search size={15} /><span>Search</span></button>
      <IconButton label="Open project" onClick={() => openDialog({ kind: 'project' })}><FolderPlus size={15} /></IconButton>
      <IconButton label="New session" disabled={!project || creatingSession || connection !== 'online'} why={!project ? 'Open a project first' : connection !== 'online' ? 'Reconnect to the server first' : undefined} onClick={() => void createSession()}>{creatingSession ? <Loader2 size={15} className="spin" /> : <SquarePen size={15} />}</IconButton>
    </div>
    <div className="sidebar__project">
      <Menu width={250} trigger={(props) => <button type="button" className="switcher" aria-label={`Project: ${project?.name ?? 'none'}. Switch project`} title={project?.path} {...props}>
        <FolderOpen size={13} /><span className="switcher__text"><strong>{project?.name ?? 'Choose a project'}</strong></span><ChevronsUpDown size={12} />
      </button>}>
        <MenuLabel>Projects</MenuLabel>
        {(boot?.projects ?? []).map((item) => <MenuItem key={item.id} selected={item.id === project?.id} onSelect={() => selectProject(item.id)} icon={<FolderOpen size={14} />} hint={item.isExample ? 'example' : undefined}>{item.name}</MenuItem>)}
        <MenuSeparator /><MenuItem icon={<FolderPlus size={14} />} onSelect={() => openDialog({ kind: 'project' })}>Open project…</MenuItem>
      </Menu>
    </div>
    <div className="sidebar__sessions">
      <div className="session-scroll" role="list" aria-label="Sessions">
        {!sessions.length ? <p className="sidebar__empty">No sessions yet.</p> : null}
        {GROUPS.map((group) => {
          const items = sessions.filter(group.match).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          if (!items.length) return null;
          return <div key={group.id} className="sgroup" role="group" aria-label={group.label}>
            {group.id !== 'idle' ? <div className="sgroup__label">{group.label}</div> : null}
            {items.map((session) => <div role="listitem" key={session.id}>
              <button type="button" className={cx('sitem', session.id === activeSessionId && view === 'workspace' && 'is-active')} onClick={() => selectSession(session.id)} aria-current={session.id === activeSessionId && view === 'workspace' ? 'true' : undefined} title={`${session.name} · ${session.model}`}>
                <span className="sitem__text"><span className="sitem__meta"><span>{project?.name}</span><span>{relativeTime(session.updatedAt, now)}</span></span><strong>{session.name}</strong></span>
                {session.status !== 'idle' ? <StatusDot status={session.status} label={false} /> : null}
              </button>
            </div>)}
          </div>;
        })}
      </div>
    </div>
    <footer className="sidebar__foot">
      <IconButton label="Settings" active={view === 'settings'} onClick={() => useRelay.getState().openSettings()}><Settings size={15} /></IconButton>
      <IconButton label="Workspace" active={view === 'workspace'} onClick={() => setView('workspace')}><LayoutPanelLeft size={15} /></IconButton>
      <Menu width={192} trigger={(props) => <IconButton label="More workspace views" active={VIEWS.some((item) => item.view === view)} {...props}><MoreHorizontal size={16} /></IconButton>}>
        <MenuLabel>Project</MenuLabel>{VIEWS.map(({ view: target, label, icon: Icon }) => <MenuItem key={target} selected={view === target} icon={<Icon size={14} />} onSelect={() => setView(target)}>{label}</MenuItem>)}
      </Menu>
      <span className="spacer" />
      <button type="button" className={cx('sidebar__connection', `sidebar__connection--${connection}`)} onClick={() => useRelay.getState().reconnect()} title={`${connectionLabel} to the local server. Click to reconnect.`}><i aria-hidden="true" /><span className="sr-only">{connectionLabel}</span></button>
    </footer>
  </aside>;
}

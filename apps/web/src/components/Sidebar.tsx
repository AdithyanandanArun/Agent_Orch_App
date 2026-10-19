import { Activity, Check, ChevronsUpDown, FolderOpen, FolderPlus, Kanban, LayoutPanelLeft, MoreHorizontal, Network, Plus, Settings, Wifi, WifiOff } from 'lucide-react';
import type { Session } from '@relay/contracts';
import { useRelay, useProject, type View } from '../store/store';
import { cx, relativeTime, useNow } from '../lib/format';
import { Button, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, ProviderMark, RelayGlyph, StatusDot } from './ui';

const SECONDARY: { view: View; label: string; icon: typeof Kanban }[] = [
  { view: 'tasks', label: 'Tasks', icon: Kanban },
  { view: 'activity', label: 'Activity', icon: Activity },
  { view: 'map', label: 'Agent map', icon: Network },
];

const GROUPS: { id: string; label: string; match: (s: Session) => boolean }[] = [
  { id: 'attention', label: 'Needs attention', match: (s) => s.status === 'waiting' || s.status === 'error' },
  { id: 'running', label: 'Running', match: (s) => s.status === 'running' },
  { id: 'idle', label: 'Idle', match: (s) => s.status === 'idle' || s.status === 'interrupted' },
];

export function Sidebar() {
  const boot = useRelay((s) => s.boot);
  const project = useProject();
  const view = useRelay((s) => s.view);
  const sidebarOpen = useRelay((s) => s.sidebarOpen);
  const activeSessionId = useRelay((s) => (s.activeProjectId ? s.sessionByProject[s.activeProjectId] : undefined));
  const connection = useRelay((s) => s.connection);
  const creatingSession = useRelay((s) => s.creatingSession);
  const { setView, selectSession, selectProject, openDialog, createSession } = useRelay.getState();
  const now = useNow();

  const sessions = (boot?.sessions ?? []).filter((s) => s.projectId === project?.id);
  const tasks = (boot?.tasks ?? []).filter((t) => t.projectId === project?.id);
  const readyCount = tasks.filter((t) => t.status === 'ready').length;
  const pending = (boot?.approvals ?? []).filter((a) => a.status === 'pending');

  const connLabel = connection === 'online' ? 'Connected' : connection === 'connecting' ? 'Connecting…' : 'Disconnected';

  return (
    <aside className={cx('sidebar', sidebarOpen && 'is-open')} aria-label="Primary">
      <div className="sidebar__brand">
        <span className="brand-glyph"><RelayGlyph size={18} /></span>
        <span className="brand-name">Relay</span>
      </div>

      <div className="sidebar__project">
        <Menu
          width={248}
          trigger={(p) => (
            <button type="button" className="switcher" aria-label={`Project: ${project?.name ?? 'none'}. Switch project`} {...p}>
              <span className="switcher__icon"><FolderOpen size={14} /></span>
              <span className="switcher__text">
                <strong>{project?.name ?? 'No project'}</strong>
                <small>{project ? (project.isExample ? 'Example workspace' : project.path) : 'Open a project to begin'}</small>
              </span>
              <ChevronsUpDown size={14} aria-hidden="true" />
            </button>
          )}
        >
          <MenuLabel>Projects</MenuLabel>
          {(boot?.projects ?? []).map((p) => (
            <MenuItem key={p.id} selected={p.id === project?.id} onSelect={() => selectProject(p.id)} icon={p.id === project?.id ? <Check size={14} /> : <FolderOpen size={14} />} hint={p.isExample ? 'example' : undefined}>
              {p.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={<FolderPlus size={14} />} onSelect={() => openDialog({ kind: 'project' })}>Open project…</MenuItem>
        </Menu>
      </div>

      <nav className="nav" aria-label="Views">
        <button type="button" className={cx('nav__item', view === 'workspace' && 'is-active')} aria-current={view === 'workspace' ? 'page' : undefined} onClick={() => setView('workspace')}>
          <LayoutPanelLeft size={15} aria-hidden="true" /><span>Workspace</span>
          {pending.length > 0 ? <span className="nav__count nav__count--warn" title={`${pending.length} pending approvals`}>{pending.length}</span> : null}
        </button>
        <Menu width={190} trigger={(p) => <button type="button" className={cx('nav__item', view !== 'workspace' && 'is-active')} aria-label="More workspace views" {...p}><MoreHorizontal size={15} aria-hidden="true" /><span>More</span></button>}>
          <MenuLabel>Project views</MenuLabel>
          {SECONDARY.map(({ view: v, label, icon: Icon }) => <MenuItem key={v} selected={view === v} icon={<Icon size={14} />} onSelect={() => setView(v)}>{label}{v === 'tasks' && readyCount > 0 ? ` · ${readyCount} ready` : ''}</MenuItem>)}
        </Menu>
      </nav>

      <div className="sidebar__sessions">
        <div className="sidebar__section">
          <span>Sessions</span>
          <IconButton label="New session" onClick={() => void createSession()} disabled={!project || creatingSession} why={!project ? 'Open a project first' : undefined}><Plus size={14} /></IconButton>
        </div>
        <div className="session-scroll" role="list" aria-label="Sessions">
          {sessions.length === 0 ? (
            <div className="sidebar__empty">
              <p>No sessions in this project.</p>
              <Button size="sm" busy={creatingSession} onClick={() => void createSession()} disabled={!project || creatingSession}>
                <Plus size={13} /> New session
              </Button>
            </div>
          ) : (
            GROUPS.map((g) => {
              const items = sessions.filter(g.match).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
              if (!items.length) return null;
              return (
                <div key={g.id} className="sgroup" role="group" aria-label={g.label}>
                  {g.id !== 'idle' ? <div className="sgroup__label">{g.label} <span>{items.length}</span></div> : null}
                  {items.map((s) => (
                    <button
                      key={s.id} type="button" role="listitem" className={cx('sitem', s.id === activeSessionId && view === 'workspace' && 'is-active')}
                      onClick={() => selectSession(s.id)} aria-current={s.id === activeSessionId ? 'true' : undefined} title={`${s.name} · ${s.model}`}
                    >
                      <ProviderMark provider={s.provider} />
                      <span className="sitem__text">
                        <strong>{s.name}</strong>
                      </span>
                      {s.status === 'idle' ? <span className="sitem__age">{relativeTime(s.updatedAt, now)}</span> : <StatusDot status={s.status} label={false} />}
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="sidebar__foot">
        <button type="button" className={cx('conn', `conn--${connection}`)} onClick={() => useRelay.getState().reconnect()} title={connection === 'online' ? 'Live connection to the local Relay server' : 'Click to retry the connection now'}>
          {connection === 'offline' ? <WifiOff size={13} aria-hidden="true" /> : <Wifi size={13} aria-hidden="true" />}
          <span>{connLabel}</span>
        </button>
        <span className="spacer" />
        <IconButton label="Settings" active={view === 'settings'} onClick={() => useRelay.getState().openSettings()}><Settings size={15} /></IconButton>
      </div>
    </aside>
  );
}

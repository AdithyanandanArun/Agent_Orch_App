import { Activity, Check, ChevronsUpDown, FolderOpen, FolderPlus, Kanban, LayoutPanelLeft, Network, Plus, Settings, Wifi, WifiOff } from 'lucide-react';
import type { Session } from '@relay/contracts';
import { useRelay, useProject, type View } from '../store/store';
import { cx, relativeTime, useNow } from '../lib/format';
import { Badge, Button, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, ProviderMark, RelayGlyph, StatusDot, PROVIDER_NAME } from './ui';

const NAV: { view: View; label: string; icon: typeof Kanban }[] = [
  { view: 'workspace', label: 'Workspace', icon: LayoutPanelLeft },
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
  const { setView, selectSession, selectProject, openDialog } = useRelay.getState();
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
        <Badge tone="neutral" title="Version reported by the local server">{boot ? `v${boot.version}` : 'local'}</Badge>
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
        {NAV.map(({ view: v, label, icon: Icon }) => (
          <button key={v} type="button" className={cx('nav__item', view === v && 'is-active')} aria-current={view === v ? 'page' : undefined} onClick={() => setView(v)}>
            <Icon size={15} aria-hidden="true" />
            <span>{label}</span>
            {v === 'tasks' && readyCount > 0 ? <span className="nav__count" title={`${readyCount} ready tasks`}>{readyCount}</span> : null}
            {v === 'workspace' && pending.length > 0 ? <span className="nav__count nav__count--warn" title={`${pending.length} pending approvals`}>{pending.length}</span> : null}
          </button>
        ))}
      </nav>

      <div className="sidebar__sessions">
        <div className="sidebar__section">
          <span>Sessions</span>
          <IconButton label="New session" onClick={() => openDialog({ kind: 'session' })} disabled={!project} why="Open a project first"><Plus size={14} /></IconButton>
        </div>
        <div className="session-scroll" role="list" aria-label="Sessions">
          {sessions.length === 0 ? (
            <div className="sidebar__empty">
              <p>No sessions in this project.</p>
              <Button size="sm" onClick={() => openDialog({ kind: 'session' })} disabled={!project}>
                <Plus size={13} /> New session
              </Button>
            </div>
          ) : (
            GROUPS.map((g) => {
              const items = sessions.filter(g.match).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
              if (!items.length) return null;
              return (
                <div key={g.id} className="sgroup" role="group" aria-label={g.label}>
                  <div className="sgroup__label">{g.label} <span>{items.length}</span></div>
                  {items.map((s) => (
                    <button
                      key={s.id} type="button" role="listitem" className={cx('sitem', s.id === activeSessionId && view === 'workspace' && 'is-active')}
                      onClick={() => selectSession(s.id)} aria-current={s.id === activeSessionId ? 'true' : undefined}
                    >
                      <ProviderMark provider={s.provider} />
                      <span className="sitem__text">
                        <strong>{s.name}</strong>
                        <small>{PROVIDER_NAME[s.provider]} · {s.model} · {relativeTime(s.updatedAt, now)}</small>
                      </span>
                      <StatusDot status={s.status} label={false} />
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
        <span className="providers-mini" aria-label="Provider executables">
          {(boot?.providers ?? []).map((p) => (
            <span key={p.id} className={cx('pm', p.available ? 'is-ok' : 'is-off')} title={p.available ? `${p.name} configured${p.version ? ` (${p.version})` : ''}. Credentials are validated on each run.` : `${p.name} needs setup${p.reason ? `: ${p.reason}` : ''}`}>
              <i aria-hidden="true" /> {p.name}
            </span>
          ))}
        </span>
        <IconButton label="Settings" onClick={() => openDialog({ kind: 'settings' })}><Settings size={15} /></IconButton>
      </div>
    </aside>
  );
}

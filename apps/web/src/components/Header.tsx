import { ArrowLeft, Menu as MenuIcon, PanelRight, Pencil, SquareTerminal, Archive, MoreHorizontal, Square, ListPlus, UserPlus } from 'lucide-react';
import { useRelay, useActiveSession, useActiveGroup, useProject } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { Button, IconButton, Menu, MenuItem, MenuSeparator } from './ui';
import { useState } from 'react';
import { groupSessionStatus } from '../lib/groups';
import { stopGroup } from '../lib/groupActions';

const TITLES = { workspace: 'Workspace', tasks: 'Tasks', activity: 'Activity', map: 'Agent map', settings: 'Settings' } as const;

export function Header() {
  const view = useRelay((s) => s.view);
  const project = useProject();
  const session = useActiveSession();
  const group = useActiveGroup();
  const sessions = useRelay((s) => s.boot?.sessions ?? []);
  const connection = useRelay((s) => s.connection);
  const contextOpen = useRelay((s) => s.contextOpen);
  const terminalOpen = useRelay((s) => s.terminalOpen);
  const { openDialog, toggleContext, toggleTerminal, setSidebarOpen } = useRelay.getState();
  const [stopping, setStopping] = useState(false);

  const interrupt = async () => {
    if (!session) return;
    setStopping(true);
    try {
      if (group) {
        await stopGroup(group);
        return;
      }
      await api.interrupt(session.id);
      useRelay.getState().toast('info', `Interrupted ${session.name}`);
      void useRelay.getState().refreshNow();
    } catch (e) {
      useRelay.getState().toast('error', errorMessage(e));
    } finally {
      setStopping(false);
    }
  };

  if (view === 'settings') return <header className="header header--settings">
    <IconButton label="Open sidebar" className="header__burger" onClick={() => setSidebarOpen(true)}><MenuIcon size={16} /></IconButton>
    <Button variant="ghost" size="sm" onClick={() => useRelay.getState().closeSettings()}><ArrowLeft size={14} /> Back to workspace</Button>
  </header>;

  return (
    <header className="header">
      <IconButton label="Open sidebar" className="header__burger" onClick={() => setSidebarOpen(true)}><MenuIcon size={16} /></IconButton>
      <div className="crumbs" aria-label="Current view">
        <span className="crumbs__project">{project?.name ?? 'No project'}</span>
        <span className="crumbs__sep" aria-hidden="true">/</span>
        <span className="crumbs__current" title={session?.branch ?? undefined}>{view === 'workspace' ? session?.name ?? 'Workspace' : TITLES[view]}</span>
      </div>
      <div className="header__actions">
        {view === 'workspace' && session && (group ? ['running', 'waiting'].includes(groupSessionStatus(group, sessions)) : ['running', 'waiting'].includes(session.status)) ? (
          <Button size="sm" variant="danger" busy={stopping} onClick={interrupt}><Square size={11} fill="currentColor" /> {group ? 'Stop group' : 'Interrupt'}</Button>
        ) : null}
        {view === 'tasks' ? (
          <Button size="sm" onClick={() => openDialog({ kind: 'task' })} disabled={!project} why="Open a project first"><ListPlus size={14} /> New task</Button>
        ) : null}
        {view === 'workspace' ? (
          <>
            <Button size="sm" variant="secondary" disabled={!session || connection !== 'online'} why={!session ? 'Select a session first' : connection !== 'online' ? 'Reconnect to the server first' : undefined} onClick={() => session && openDialog({ kind: 'add-agent', sessionId: session.id })}><UserPlus size={14} /> Add agent</Button>
            <IconButton label={terminalOpen ? 'Hide terminal' : 'Show terminal'} active={terminalOpen} onClick={() => toggleTerminal()}><SquareTerminal size={16} /></IconButton>
            <IconButton label={contextOpen ? 'Hide context pane' : 'Show context pane'} active={contextOpen} onClick={() => toggleContext()}><PanelRight size={16} /></IconButton>
            <Menu
              align="end" width={200}
              trigger={(p) => <IconButton label="Session actions" disabled={!session} why="No session selected" {...p}><MoreHorizontal size={16} /></IconButton>}
            >
              <MenuItem icon={<Pencil size={14} />} onSelect={() => session && openDialog({ kind: 'rename', sessionId: session.id })}>Rename session</MenuItem>
              <MenuItem icon={<Square size={14} />} disabled={!session || (group ? !['running', 'waiting'].includes(groupSessionStatus(group, sessions)) : !['running', 'waiting'].includes(session.status))} why="No active run to stop" onSelect={interrupt}>{group ? 'Stop group' : 'Interrupt run'}</MenuItem>
              {!group ? <><MenuSeparator /><MenuItem danger icon={<Archive size={14} />} onSelect={() => session && openDialog({ kind: 'archive', sessionId: session.id })}>Archive session…</MenuItem></> : null}
            </Menu>
          </>
        ) : null}
      </div>
    </header>
  );
}

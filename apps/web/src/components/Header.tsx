import { Command, Menu as MenuIcon, PanelRight, Pencil, SquareTerminal, Archive, MoreHorizontal, Square, ListPlus } from 'lucide-react';
import { useRelay, useActiveSession, useProject } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { Button, IconButton, Menu, MenuItem, MenuSeparator, MOD, Kbd } from './ui';
import { useState } from 'react';

const TITLES = { workspace: 'Workspace', tasks: 'Tasks', activity: 'Activity', map: 'Agent map' } as const;

export function Header() {
  const view = useRelay((s) => s.view);
  const project = useProject();
  const session = useActiveSession();
  const contextOpen = useRelay((s) => s.contextOpen);
  const terminalOpen = useRelay((s) => s.terminalOpen);
  const creatingSession = useRelay((s) => s.creatingSession);
  const { openDialog, toggleContext, toggleTerminal, setSidebarOpen, createSession } = useRelay.getState();
  const [stopping, setStopping] = useState(false);

  const interrupt = async () => {
    if (!session) return;
    setStopping(true);
    try {
      await api.interrupt(session.id);
      useRelay.getState().toast('info', `Interrupted ${session.name}`);
      void useRelay.getState().refreshNow();
    } catch (e) {
      useRelay.getState().toast('error', errorMessage(e));
    } finally {
      setStopping(false);
    }
  };

  return (
    <header className="header">
      <IconButton label="Open sidebar" className="header__burger" onClick={() => setSidebarOpen(true)}><MenuIcon size={16} /></IconButton>
      <div className="crumbs" aria-label="Current view">
        <span className="crumbs__project" title={session?.branch ?? undefined}>{view === 'workspace' ? session?.name ?? project?.name ?? 'No project' : project?.name ?? 'No project'}</span>
        {view !== 'workspace' ? <span className="crumbs__current">{TITLES[view]}</span> : null}
      </div>
      <div className="header__actions">
        {view === 'workspace' && session?.status === 'running' ? (
          <Button size="sm" variant="danger" busy={stopping} onClick={interrupt}><Square size={11} fill="currentColor" /> Interrupt</Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => openDialog({ kind: 'palette' })} aria-label="Open command menu" className="cmdk-btn">
          <Command size={13} aria-hidden="true" /> <Kbd>{MOD}</Kbd><Kbd>K</Kbd>
        </Button>
        {view === 'tasks' ? (
          <Button size="sm" variant="primary" onClick={() => openDialog({ kind: 'task' })} disabled={!project} why="Open a project first"><ListPlus size={14} /> New task</Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void createSession()} busy={creatingSession} disabled={!project || creatingSession} why={!project ? 'Open a project first' : undefined}>New session</Button>
        )}
        {view === 'workspace' ? (
          <>
            <IconButton label={terminalOpen ? 'Hide terminal' : 'Show terminal'} active={terminalOpen} onClick={() => toggleTerminal()}><SquareTerminal size={16} /></IconButton>
            <IconButton label={contextOpen ? 'Hide context pane' : 'Show context pane'} active={contextOpen} onClick={() => toggleContext()}><PanelRight size={16} /></IconButton>
            <Menu
              align="end" width={200}
              trigger={(p) => <IconButton label="Session actions" disabled={!session} why="No session selected" {...p}><MoreHorizontal size={16} /></IconButton>}
            >
              <MenuItem icon={<Pencil size={14} />} onSelect={() => session && openDialog({ kind: 'rename', sessionId: session.id })}>Rename session</MenuItem>
              <MenuItem icon={<Square size={14} />} disabled={session?.status !== 'running'} why="Only running sessions can be interrupted" onSelect={interrupt}>Interrupt run</MenuItem>
              <MenuSeparator />
              <MenuItem danger icon={<Archive size={14} />} onSelect={() => session && openDialog({ kind: 'archive', sessionId: session.id })}>Archive session…</MenuItem>
            </Menu>
          </>
        ) : null}
      </div>
    </header>
  );
}

import { useState } from 'react';
import type { Project } from '@relay/contracts';
import { useRelay } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { Button, InlineError, Modal } from './ui';
import '../styles/project-removal.css';

export function RemoveProjectDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.removeProject(project.id);
      await useRelay.getState().refreshNow();
      const state = useRelay.getState();
      if (state.view === 'settings' && state.settingsProjectId === project.id) state.openSettings({ section: 'general' });
      state.toast(result.notices.length ? 'info' : 'success', result.notices[0] ?? 'Project removed from Relay. Your files are kept.');
      onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <Modal title={`Remove ${project.name}?`} description="Remove this project and its conversations from the workspace list."
    onClose={() => { if (!busy) onClose(); }}
    footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button variant="danger" busy={busy} disabled={busy} onClick={() => void remove()}>Remove project</Button></>}>
    <div className="project-removal">
      <p>Your project folder, files and worktrees stay on disk. Reopen this folder to restore its conversations and tasks.</p>
      <code>{project.path}</code>
      <p>Team scheduling will be paused. Stop running agents and close this project’s terminals first.</p>
      {error ? <InlineError>{error}</InlineError> : null}
    </div>
  </Modal>;
}

export function RemoveProjectButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const online = useRelay((state) => state.connection === 'online');
  return <>
    <Button size="sm" variant="ghost" disabled={!online} onClick={() => setOpen(true)}>Remove project…</Button>
    {open ? <RemoveProjectDialog project={project} onClose={() => setOpen(false)} /> : null}
  </>;
}

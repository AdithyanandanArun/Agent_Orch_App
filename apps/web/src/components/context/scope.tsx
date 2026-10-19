import { useRelay, useActiveSession, useProject } from '../../store/store';
import { Segmented } from '../ui';

export interface ScopeIds { projectId: string | null; sessionId: string | null; label: string; isolated: boolean }

/** Resolves which tree the Files / Changes / Terminal surfaces act on. */
export function useScopeIds(): ScopeIds {
  const project = useProject();
  const session = useActiveSession();
  const scope = useRelay((s) => s.scope);
  if (!project) return { projectId: null, sessionId: null, label: 'No project', isolated: false };
  if (scope === 'session' && session) {
    return { projectId: project.id, sessionId: session.id, label: session.isolated ? `${session.name} worktree` : `${session.name} (project folder)`, isolated: session.isolated };
  }
  return { projectId: project.id, sessionId: null, label: `${project.name} project folder`, isolated: false };
}

export function ScopeSwitch({ compact = false }: { compact?: boolean }) {
  const scope = useRelay((s) => s.scope);
  const session = useActiveSession();
  const ids = useScopeIds();
  return (
    <div className="scope">
      <Segmented
        label="File scope" value={scope === 'session' && !session ? 'project' : scope} onChange={(v) => useRelay.getState().setScope(v)}
        options={[
          { value: 'session', label: 'Session', disabled: !session, title: session ? `Files in ${session.name}'s ${session.isolated ? 'isolated worktree' : 'working folder'}` : 'Select a session to scope to its worktree' },
          { value: 'project', label: 'Project', title: 'The project folder itself' },
        ]}
      />
      {compact ? null : <span className="scope__label" title={ids.label}>{ids.label}</span>}
    </div>
  );
}

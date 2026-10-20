import { ExternalLink, FileText } from 'lucide-react';
import type { Session, SessionRun, Task, TaskOverride, TaskSource } from '@relay/contracts';
import { useEditor } from '../../store/editor';
import { useRelay } from '../../store/store';
import { Badge } from '../ui';
import { openExternal } from '../git/gitUtil';

export const SOURCE_LABEL: Record<TaskSource['kind'], string> = { repository: 'Repository', request: 'Request', provider: 'Provider plan', github: 'GitHub' };
const SOURCE_ORIGIN: Record<TaskSource['kind'], string> = {
  repository: 'Detected in the project files',
  request: 'Derived from a request in this workspace',
  provider: 'Reported in a provider’s task plan',
  github: 'Imported from GitHub',
};
const REPORTED: Record<NonNullable<TaskSource['reportedStatus']>, string> = { pending: 'pending', in_progress: 'in progress', completed: 'completed', blocked: 'blocked' };
const OVERRIDE_LABEL: Record<TaskOverride, string> = { title: 'title', description: 'description', acceptanceCriteria: 'acceptance criteria', status: 'status', sessionId: 'assigned session', dependsOn: 'dependencies' };

export const sourceLocation = (source: TaskSource): string | null => (source.path ? `${source.path}${source.line ? `:${source.line}` : ''}` : null);

/** Compact origin chips for a board card: where the task came from and anything that needs a human look. */
export function SourceBadges({ task }: { task: Task }) {
  const source = task.source;
  if (!source) return null;
  const where = sourceLocation(source);
  return (
    <>
      <Badge tone="neutral" title={where ?? source.url ?? `${SOURCE_ORIGIN[source.kind]} (${source.key})`}>{SOURCE_LABEL[source.kind]}</Badge>
      {source.missing ? <Badge tone="warn" title="This task is no longer found at its source.">Source missing</Badge> : null}
      {source.reportedStatus ? <Badge tone="info" title="Status reported by the source. Relay does not change the task status from this.">Reported {REPORTED[source.reportedStatus]}</Badge> : null}
      {source.overrides?.length ? <Badge tone="neutral" title={`Edited manually: ${source.overrides.map((o) => OVERRIDE_LABEL[o]).join(', ')}`}>Edited</Badge> : null}
    </>
  );
}

function openSourceFile(projectId: string, path: string): void {
  useEditor.getState().open(projectId, null, path);
  useRelay.getState().setView('workspace');
}

/** Evidence for an automatically tracked task, shown above the editable fields. Manual tasks show nothing. */
export function SourceDetails({ task, tasks, sessions, runs }: { task: Task; tasks: Task[]; sessions: Session[]; runs: SessionRun[] }) {
  const source = task.source;
  if (!source) return null;
  const where = sourceLocation(source);
  const parent = source.parentTaskId ? tasks.find((t) => t.id === source.parentTaskId) : undefined;
  const run = source.runId ? runs.find((r) => r.id === source.runId) : undefined;
  const runSession = run ? sessions.find((s) => s.id === run.sessionId) : undefined;
  return (
    <section className="source" aria-label="Task source">
      <header className="source__head">
        <strong>{SOURCE_LABEL[source.kind]}</strong>
        <span>{SOURCE_ORIGIN[source.kind]}</span>
      </header>
      {source.missing ? <p className="source__warn" role="status">No longer found at its source. The task stays on the board; check whether it still applies.</p> : null}
      <dl className="source__facts">
        {where ? (
          <><dt>File</dt><dd>
            <button type="button" className="link-btn source__link" disabled={source.missing} title={source.missing ? 'The source no longer exists' : 'Open in the editor'} onClick={() => openSourceFile(task.projectId, source.path!)}><FileText size={12} aria-hidden="true" /> {where}</button>
          </dd></>
        ) : null}
        {source.url ? <><dt>Link</dt><dd><button type="button" className="link-btn source__link" onClick={() => { if (!openExternal(source.url!)) useRelay.getState().toast('error', 'That link is not a web address.'); }}><ExternalLink size={12} aria-hidden="true" /> {source.url}</button></dd></> : null}
        {source.runId ? <><dt>Run</dt><dd>{run && runSession ? <button type="button" className="link-btn" onClick={() => useRelay.getState().selectSession(runSession.id)}>{runSession.name}</button> : null} <code>{source.runId}</code>{!run ? <span className="muted small"> · not in the recent run records</span> : null}</dd></> : null}
        {source.providerId ? <><dt>Provider ID</dt><dd><code>{source.providerId}</code></dd></> : null}
        {parent ? <><dt>Part of</dt><dd><button type="button" className="link-btn" onClick={() => useRelay.getState().selectTask(parent.id)}>{parent.title}</button><span className="muted small"> · grouping only, not a dependency</span></dd></> : source.parentTaskId ? <><dt>Part of</dt><dd><code>{source.parentTaskId}</code><span className="muted small"> · parent task not found</span></dd></> : null}
        {source.reportedStatus ? <><dt>Reported</dt><dd>{REPORTED[source.reportedStatus]}<span className="muted small"> · the board status below is separate; Relay never marks tasks Done on its own</span></dd></> : null}
        {source.overrides?.length ? <><dt>Edited by you</dt><dd>{source.overrides.map((o) => OVERRIDE_LABEL[o]).join(', ')}<span className="muted small"> · rescans do not replace these fields</span></dd></> : null}
        <dt>Evidence key</dt><dd><code>{source.key}</code></dd>
      </dl>
    </section>
  );
}

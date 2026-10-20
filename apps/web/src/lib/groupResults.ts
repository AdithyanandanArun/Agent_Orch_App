import type {
  GroupDelivery, GroupMember, GroupMessage, GroupRequest, GroupSnapshot, Message, Provider, RunChangedFile, Session, SessionRun, Task, TaskStatus,
} from '@relay/contracts';

/**
 * Pure projection of the LATEST human request in a group. Everything is scoped to that request's recorded
 * deliveries, assignments, runs and tasks; prose is never parsed to infer outcomes, tests or integration.
 */
export interface GroupResultInput {
  snapshot: GroupSnapshot; sessions: readonly Session[]; messages: readonly Message[]; runs: readonly SessionRun[]; tasks: readonly Task[];
}

export type GroupResultStatus =
  | 'pending' | 'in-progress' | 'paused' | 'failed' | 'stopped' | 'blocked' | 'follow-up' | 'finalizing' | 'unknown' | 'review' | 'accepted' | 'responded';
export type DeliveryKind = NonNullable<GroupDelivery['kind']>;

export interface ResultTask { id: string; title: string; status: TaskStatus | null; label: string }
export interface ResultReport {
  key: string; taskTitles: string[];
  /** Native final assistant text; null when none is recorded. */
  text: string | null; note: string | null;
}
export interface ResultChangedPath { path: string; status: RunChangedFile['status']; runs: number }
export interface ResultWorkspace {
  location: string | null; isolated: boolean | null; scope: string[]; paths: ResultChangedPath[]; notes: string[];
}
export interface ResultAgent {
  memberId: string; sessionId: string; handle: string; provider: Provider | null; removed: boolean; isLead: boolean;
  /** Worst-case turn state for this request, or null when no turn is recorded. Finished is a turn outcome only. */
  state: string | null;
  tasks: ResultTask[]; reports: ResultReport[]; problems: string[]; workspace: ResultWorkspace;
}
export type LeadReportState = 'report' | 'pending' | 'missing';
export interface ResultLead {
  memberId: string; sessionId: string; handle: string; provider: Provider | null; removed: boolean;
  state: string | null; report: ResultReport; reportState: LeadReportState;
}
export interface GroupResultModel {
  status: GroupResultStatus; title: string; summary: string;
  /** Pause reason or similar one-line context shown beside the summary. */
  detail: string | null;
  requestExcerpt: string; facts: string[];
  lead: ResultLead | null; agents: ResultAgent[];
  changedPathCount: number; workspaceCount: number; active: boolean; caveat: string;
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog', ready: 'Ready', running: 'Running', blocked: 'Blocked', review: 'Needs review', done: 'Accepted',
};
export const CHANGE_STATUS_LABEL: Record<RunChangedFile['status'], string> = { A: 'Added', M: 'Modified', D: 'Deleted', T: 'Type changed' };
const CAVEAT = 'Task status is recorded by Relay; checks and integration are described in the agent reports.';
const NO_REPORT = 'No final report recorded.';

const time = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const isActive = (delivery: GroupDelivery): boolean => delivery.status === 'queued' || delivery.status === 'running';
const unique = <T,>(items: readonly T[]): T[] => [...new Set(items)];

/** Short plain-text preview for line-clamped display; formatting characters only, no interpretation. */
export function reportPreview(text: string, max = 420): string {
  const flat = text.replace(/```[^\n]*\n?/g, ' ').replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s{0,3}>\s?/gm, '').replace(/[*`]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

function latestUserMessage(snapshot: GroupSnapshot): GroupMessage | null {
  let best: GroupMessage | null = null;
  for (const message of snapshot.messages) {
    if (message.kind !== 'user' || message.groupId !== snapshot.group.id) continue;
    if (!best || message.seq > best.seq || (message.seq === best.seq && time(message.createdAt) > time(best.createdAt))) best = message;
  }
  return best;
}

function requestFor(snapshot: GroupSnapshot, message: GroupMessage): GroupRequest | null {
  let best: GroupRequest | null = null;
  for (const request of snapshot.requests) {
    if (request.groupId !== snapshot.group.id || request.messageId !== message.id) continue;
    if (!best || time(request.createdAt) >= time(best.createdAt)) best = request;
  }
  return best;
}

/** Last ordinary assistant message of a completed run owned by the delivery's participant; nothing else qualifies. */
function nativeFinal(delivery: GroupDelivery, sessionId: string, runById: ReadonlyMap<string, SessionRun>, messages: readonly Message[]): string | null {
  if (delivery.status !== 'completed' || !delivery.runId) return null;
  const run = runById.get(delivery.runId);
  if (!run || run.status !== 'completed' || run.sessionId !== sessionId) return null;
  let best: { at: number; index: number; content: string } | null = null;
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || message.kind != null || message.runId !== run.id || message.sessionId !== sessionId) return;
    if (!message.content.trim()) return;
    const at = time(message.createdAt);
    if (!best || at > best.at || (at === best.at && index > best.index)) best = { at, index, content: message.content };
  });
  return (best as { content: string } | null)?.content ?? null;
}

function newestFirst(a: GroupDelivery, b: GroupDelivery): number {
  return time(b.updatedAt) - time(a.updatedAt) || b.hop - a.hop || time(b.createdAt) - time(a.createdAt);
}

function turnState(deliveries: readonly GroupDelivery[]): string | null {
  const has = (status: GroupDelivery['status']) => deliveries.some((delivery) => delivery.status === status);
  if (has('running')) return 'Working';
  if (has('queued')) return 'Queued';
  if (has('failed')) return 'Turn failed';
  if (has('interrupted')) return 'Interrupted';
  if (has('cancelled')) return 'Cancelled';
  if (has('completed')) return 'Turn finished';
  return null;
}

function boundedError(error: string): string {
  const flat = error.replace(/\s+/g, ' ').trim();
  return flat.length > 240 ? `${flat.slice(0, 240).trimEnd()}…` : flat;
}

/** Returns null when the group has no human request yet, so nothing earlier can be mistaken for a result. */
export function buildGroupResultModel({ snapshot, sessions, messages, runs, tasks }: GroupResultInput): GroupResultModel | null {
  const { group } = snapshot;
  const message = latestUserMessage(snapshot);
  if (!message) return null;
  const requestExcerpt = reportPreview(message.content, 180);
  const request = requestFor(snapshot, message);
  if (!request) {
    return {
      status: 'pending', title: 'Waiting to start', summary: 'This request has no recorded turns yet.', detail: null, requestExcerpt,
      facts: [], lead: null, agents: [], changedPathCount: 0, workspaceCount: 0, active: false, caveat: CAVEAT,
    };
  }

  const memberById = new Map(snapshot.members.map((member) => [member.id, member]));
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const runById = new Map(runs.map((run) => [run.id, run]));
  const deliveries = snapshot.deliveries.filter((delivery) => delivery.requestId === request.id && delivery.groupId === group.id);
  const assignments = snapshot.assignments.filter((assignment) => assignment.requestId === request.id && assignment.groupId === group.id);
  const assignedDeliveryIds = new Set(assignments.map((assignment) => assignment.deliveryId));
  const kindOf = (delivery: GroupDelivery): DeliveryKind =>
    delivery.kind ?? (assignedDeliveryIds.has(delivery.id) ? 'assignment' : delivery.messageId === request.messageId ? 'request' : 'message');

  const taskById = new Map<string, Task>();
  for (const task of tasks) if (task.projectId === group.projectId) taskById.set(task.id, task);
  const taskFor = (taskId: string): ResultTask => {
    const task = taskById.get(taskId);
    return task
      ? { id: task.id, title: task.title, status: task.status, label: TASK_STATUS_LABEL[task.status] }
      : { id: taskId, title: 'Task record unavailable', status: null, label: 'Unknown' };
  };
  const allTasks = unique(assignments.map((assignment) => assignment.taskId)).map(taskFor);

  const linkedRuns = unique(deliveries.flatMap((delivery) => (delivery.runId ? [delivery.runId] : [])))
    .flatMap((id) => runById.get(id) ?? [])
    .filter((run) => deliveries.some((delivery) => delivery.runId === run.id && memberById.get(delivery.memberId)?.sessionId === run.sessionId));
  const activeDeliveries = deliveries.filter(isActive);
  const runningRuns = linkedRuns.filter((run) => run.status === 'running');
  const activeTurns = Math.max(activeDeliveries.length, runningRuns.length);
  const active = activeTurns > 0;
  const queuedTurns = deliveries.filter((delivery) => delivery.status === 'queued').length;

  const plannerId = request.plannerMemberId;
  const participantIds = new Set<string>([plannerId]);
  for (const delivery of deliveries) participantIds.add(delivery.memberId);
  for (const assignment of assignments) { participantIds.add(assignment.fromMemberId); participantIds.add(assignment.toMemberId); }

  const workspaceKeys = new Set<string>();
  const workspaces = new Set<string>();
  const anyFailedRun = linkedRuns.some((run) => run.status === 'failed');
  const anyInterruptedRun = linkedRuns.some((run) => run.status === 'interrupted');

  const reportFor = (key: string, delivery: GroupDelivery, member: GroupMember, taskTitles: string[]): ResultReport => {
    if (isActive(delivery)) return { key, taskTitles, text: null, note: 'Report not available yet; the turn is still in progress.' };
    const text = nativeFinal(delivery, member.sessionId, runById, messages);
    return { key, taskTitles, text, note: text === null ? NO_REPORT : null };
  };

  const buildAgent = (member: GroupMember): ResultAgent => {
    const session = sessionById.get(member.sessionId);
    const isLead = member.id === plannerId;
    const own = deliveries.filter((delivery) => delivery.memberId === member.id);
    const toMe = assignments.filter((assignment) => assignment.toMemberId === member.id);
    const memberTasks = unique(toMe.map((assignment) => assignment.taskId)).map(taskFor);

    const reports: ResultReport[] = [];
    const assignmentDeliveries = own.filter((delivery) => kindOf(delivery) === 'assignment').sort((a, b) => time(a.createdAt) - time(b.createdAt));
    for (const delivery of assignmentDeliveries) {
      const titles = unique(assignments.filter((assignment) => assignment.deliveryId === delivery.id).map((assignment) => taskFor(assignment.taskId).title));
      reports.push(reportFor(`a:${delivery.id}`, delivery, member, titles));
    }
    if (!isLead && !assignmentDeliveries.length) {
      const latestRequest = own.filter((delivery) => kindOf(delivery) === 'request').sort(newestFirst)[0];
      if (latestRequest) reports.push(reportFor(`r:${latestRequest.id}`, latestRequest, member, []));
      else {
        const latestReply = own.filter((delivery) => kindOf(delivery) === 'message').sort(newestFirst)[0];
        if (latestReply) reports.push(reportFor(`m:${latestReply.id}`, latestReply, member, []));
      }
    }
    // Only completed reports and honest gaps are listed; superseded failures are not repeated here.
    const problems: string[] = [];
    for (const delivery of own) {
      if (delivery.status === 'failed') problems.push(delivery.error ? `Turn failed: ${boundedError(delivery.error)}` : 'Turn failed.');
      else if (delivery.status === 'interrupted') problems.push('Turn interrupted before finishing.');
      else if (delivery.status === 'cancelled') problems.push('Turn cancelled before finishing.');
    }
    const ownRunIds = unique(own.flatMap((delivery) => (delivery.runId ? [delivery.runId] : [])));
    const ownRuns = ownRunIds.flatMap((id) => runById.get(id) ?? []).filter((run) => run.sessionId === member.sessionId);
    if (!own.some((delivery) => delivery.status === 'failed') && ownRuns.some((run) => run.status === 'failed')) problems.push('A run failed.');
    if (!own.some((delivery) => delivery.status === 'interrupted' || delivery.status === 'cancelled') && ownRuns.some((run) => run.status === 'interrupted')) problems.push('A run was interrupted.');

    const paths = new Map<string, ResultChangedPath>();
    const notes: string[] = [];
    let unavailable = 0;
    let unrecorded = 0;
    let truncated = 0;
    const missingRuns = ownRunIds.length - ownRuns.length;
    for (const run of [...ownRuns].sort((a, b) => time(a.startedAt) - time(b.startedAt))) {
      const changes = run.changes;
      if (run.status === 'running') continue;
      if (!changes) { unrecorded++; continue; }
      if (changes.status !== 'available') { unavailable++; continue; }
      if (changes.truncated) truncated++;
      for (const notice of changes.notices) if (notice && !notes.includes(notice)) notes.push(notice);
      for (const file of changes.files) {
        const prior = paths.get(file.path);
        paths.set(file.path, { path: file.path, status: file.status, runs: (prior?.runs ?? 0) + 1 });
      }
    }
    if (truncated) notes.unshift(`${plural(truncated, 'run')} had a truncated file list; more paths may have changed.`);
    if (unavailable) notes.unshift(`Change summary unavailable for ${plural(unavailable, 'run')}.`);
    if (unrecorded) notes.unshift(`No change summary recorded for ${plural(unrecorded, 'run')}.`);
    if (missingRuns > 0) notes.unshift(`${plural(missingRuns, 'run record')} unavailable.`);
    const changed = [...paths.values()].sort((a, b) => a.path.localeCompare(b.path));
    const location = session?.worktreePath ?? null;
    if (changed.length) {
      workspaces.add(location ?? member.id);
      for (const entry of changed) workspaceKeys.add(`${location ?? member.id}\u0000${entry.path}`);
    }
    return {
      memberId: member.id, sessionId: member.sessionId, handle: member.handle, provider: session?.provider ?? null, removed: Boolean(member.removedAt), isLead,
      state: turnState(own), tasks: memberTasks, reports, problems: unique(problems),
      workspace: { location, isolated: session ? session.isolated : null, scope: unique(toMe.flatMap((assignment) => assignment.scope)), paths: changed, notes },
    };
  };

  const ordered = snapshot.members.filter((member) => participantIds.has(member.id));
  const built = ordered.map(buildAgent);
  // Every participant keeps a workspace row; the lead's native result is highlighted separately.
  const agents = built;

  let lead: ResultLead | null = null;
  const plannerMember = memberById.get(plannerId);
  if (plannerMember) {
    const plannerDeliveries = deliveries.filter((delivery) => delivery.memberId === plannerId);
    const results = plannerDeliveries.filter((delivery) => kindOf(delivery) === 'result').sort(newestFirst);
    const requests = plannerDeliveries.filter((delivery) => kindOf(delivery) === 'request').sort(newestFirst);
    let report: ResultReport = { key: 'lead', taskTitles: [], text: null, note: NO_REPORT };
    let reportState: LeadReportState = 'missing';
    const finish = (delivery: GroupDelivery) => {
      report = reportFor('lead', delivery, plannerMember, []);
      reportState = report.text !== null ? 'report' : isActive(delivery) ? 'pending' : 'missing';
    };
    if (results.length) {
      const pending = results.find(isActive);
      const done = results.find((delivery) => delivery.status === 'completed');
      if (pending) { report = { key: 'lead', taskTitles: [], text: null, note: 'Lead report in progress.' }; reportState = 'pending'; }
      else if (done) finish(done);
    } else if (assignments.length) {
      // The first answer predates the assignments; it is not the final report.
      const waiting = request.status !== 'completed' || active;
      report = { key: 'lead', taskTitles: [], text: null, note: waiting ? 'Lead report not available yet.' : 'No lead result report recorded.' };
      reportState = waiting ? 'pending' : 'missing';
    } else if (requests.length) {
      const target = requests.find(isActive) ?? requests.find((delivery) => delivery.status === 'completed');
      if (target) finish(target);
    } else {
      report = { key: 'lead', taskTitles: [], text: null, note: 'No lead turn recorded for this request.' };
    }
    lead = {
      memberId: plannerMember.id, sessionId: plannerMember.sessionId, handle: plannerMember.handle,
      provider: sessionById.get(plannerMember.sessionId)?.provider ?? null, removed: Boolean(plannerMember.removedAt),
      state: turnState(plannerDeliveries), report, reportState,
    };
  }

  const count = (status: TaskStatus) => allTasks.filter((task) => task.status === status).length;
  const blocked = count('blocked');
  const unfinished = count('backlog') + count('ready') + count('running');
  const inReview = count('review');
  const missingTasks = allTasks.filter((task) => task.status === null).length;
  const failed = deliveries.some((delivery) => delivery.status === 'failed') || anyFailedRun;
  const stopped = deliveries.some((delivery) => delivery.status === 'interrupted' || delivery.status === 'cancelled') || anyInterruptedRun;
  const paused = group.paused || request.status === 'paused';
  const pauseReason = group.pauseReason?.trim() || null;

  let status: GroupResultStatus;
  let title: string;
  let summary: string;
  let detail: string | null = null;
  if (paused && (request.status !== 'completed' || active)) {
    status = 'paused'; title = 'Paused';
    detail = pauseReason ? `Reason: ${pauseReason}` : 'No pause reason recorded.';
    const parts = [
      runningRuns.length || deliveries.some((delivery) => delivery.status === 'running') ? `${plural(Math.max(runningRuns.length, deliveries.filter((delivery) => delivery.status === 'running').length), 'turn')} still running` : null,
      queuedTurns ? `${plural(queuedTurns, 'queued turn')} held` : null,
    ].filter(Boolean);
    summary = parts.length ? `No new work starts while paused; ${parts.join(', ')}.` : 'No new work starts while paused. Results may be incomplete.';
  } else if (active) {
    status = 'in-progress'; title = 'In progress';
    summary = `${plural(activeTurns, 'turn')} running or queued. What follows is partial until they finish.`;
  } else if (failed) {
    status = 'failed'; title = 'A turn failed';
    summary = 'A request turn failed. See the agent details for the recorded error.';
  } else if (stopped) {
    status = 'stopped'; title = 'Stopped before finishing';
    summary = 'A request turn was interrupted or cancelled. Task statuses and reports are shown below.';
  } else if (blocked) {
    status = 'blocked'; title = 'Blocked';
    summary = `${plural(blocked, 'task')} reported as blocked.`;
  } else if (unfinished) {
    status = 'follow-up'; title = 'Follow-up needed';
    summary = `${plural(unfinished, 'assigned task')} still ${unfinished === 1 ? 'needs' : 'need'} follow-up.`;
  } else if (request.status === 'active') {
    status = 'finalizing'; title = 'Finalizing request';
    summary = 'All turns have ended, but the request is not recorded as completed yet.';
  } else if (missingTasks || (!deliveries.length && request.status === 'completed')) {
    status = 'unknown'; title = 'Outcome unavailable';
    summary = missingTasks ? 'Some assigned task records are unavailable, so their state is unknown.' : 'No turns are recorded for this completed request.';
  } else if (!deliveries.length) {
    status = 'pending'; title = 'Waiting to start'; summary = 'This request has no recorded turns yet.';
  } else {
    if (allTasks.length && allTasks.every((task) => task.status === 'done')) {
      status = 'accepted'; title = 'Tasks accepted'; summary = 'All assigned tasks are marked done.';
    } else if (allTasks.length) {
      status = 'review'; title = 'Ready for your review'; summary = 'Tasks require your acceptance; they are not accepted automatically.';
    } else {
      status = 'responded'; title = 'Team finished responding'; summary = 'No tasks were assigned to this request.';
    }
  }
  if (paused && request.status === 'completed' && !detail) detail = pauseReason ? `Group is paused · ${pauseReason}` : 'Group is paused.';

  const facts = [
    agents.length || lead ? plural(unique([...agents.map((agent) => agent.memberId), ...(lead ? [lead.memberId] : [])]).length, 'agent') : null,
    allTasks.length ? plural(allTasks.length, 'task') : null,
    inReview ? `${inReview} need review` : null,
    count('done') ? `${count('done')} accepted` : null,
  ].filter((fact): fact is string => Boolean(fact));

  return {
    status, title, summary, detail, requestExcerpt, facts, lead, agents,
    changedPathCount: workspaceKeys.size, workspaceCount: workspaces.size, active, caveat: CAVEAT,
  };
}

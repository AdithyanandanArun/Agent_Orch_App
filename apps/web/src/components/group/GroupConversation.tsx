import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, FolderPlus } from 'lucide-react';
import type { GroupDelivery, GroupSnapshot, Message, Session, SessionRun, ToolCall } from '@relay/contracts';
import { useRelay, useProject } from '../../store/store';
import { clockTime, cx } from '../../lib/format';
import { DELIVERY_LABEL, activeMembers } from '../../lib/groups';
import {
  buildTimeline, groupRuns, memberSessionIds, placeRuns, speakers, toolCallsByRun, type GroupItem, type NativeItem, type Speaker,
} from '../../lib/groupTimeline';
import { Markdown } from '../Markdown';
import { Button, EmptyState } from '../ui';
import { ApprovalCard, LegacyToolGroup, MessageRow, SpeakerLabel } from '../ConversationParts';
import { RunActivity } from '../RunActivity';
import { RunChanges } from '../RunChanges';
import { GitBar } from '../git/GitBar';
import { GroupBar } from './GroupBar';
import { GroupComposer } from './GroupComposer';

const NO_SESSIONS: Session[] = [];
const NO_MESSAGES: Message[] = [];
const NO_RUNS: SessionRun[] = [];
const NO_CALLS: ToolCall[] = [];

function DeliveryChips({ deliveries, label }: { deliveries: GroupDelivery[]; label: (memberId: string) => string }) {
  if (!deliveries.length) return null;
  return (
    <ul className="deliveries" aria-label="Delivery state">
      {deliveries.map((delivery) => (
        <li key={delivery.id} className={cx('delivery', `is-${delivery.status}`)} title={delivery.error ?? undefined}>
          <i aria-hidden="true" />{label(delivery.memberId)} · {DELIVERY_LABEL[delivery.status]}{delivery.hop > 0 ? ` · hop ${delivery.hop}` : ''}
        </li>
      ))}
    </ul>
  );
}

function Handles({ speakersList }: { speakersList: Speaker[] }) {
  return <>{speakersList.map((speaker, index) => <Fragment key={speaker.memberId}>{index ? ', ' : ''}<span className="handle">@{speaker.handle}</span></Fragment>)}</>;
}

function GroupMessageRow({ item, snapshot }: { item: GroupItem; snapshot: GroupSnapshot }) {
  const { message, sender, recipients, deliveries } = item;
  const tasks = useRelay((s) => s.boot?.tasks);
  const handleOf = (memberId: string) => `@${snapshot.members.find((member) => member.id === memberId)?.handle ?? 'unknown'}`;
  const time = message.createdAt ? <time className="msg__time" dateTime={message.createdAt} title={clockTime(message.createdAt)}>{clockTime(message.createdAt)}</time> : null;
  if (message.kind === 'user') {
    return (
      <article className="msg msg--user" aria-label="Your message">
        <div className="msg__bubble"><Markdown text={message.content} /></div>
        {recipients.length ? <div className="msg__to">To <Handles speakersList={recipients} /></div> : null}
        <DeliveryChips deliveries={deliveries} label={handleOf} />
        {time}
      </article>
    );
  }
  if (message.kind === 'status') {
    return (
      <div className="group-status" role="note">
        <i aria-hidden="true" />
        {sender ? <strong>@{sender.handle}</strong> : null}
        <span>{message.content}</span>
        {time}
      </div>
    );
  }
  if (message.kind === 'assignment' || message.kind === 'artifact') {
    const assignments = message.kind === 'assignment' ? snapshot.assignments.filter((assignment) => deliveries.some((delivery) => delivery.id === assignment.deliveryId)) : [];
    return (
      <section className="group-card" aria-label={message.kind === 'assignment' ? 'Assignment' : 'Artifact'}>
        <header>
          <span className="group-card__kind">{message.kind === 'assignment' ? 'Assignment' : 'Artifact'}</span>
          <span className="group-card__route">{sender ? `@${sender.handle}` : 'Group'}{recipients.length ? <> <ArrowRight size={11} aria-hidden="true" /> <Handles speakersList={recipients} /></> : null}</span>
        </header>
        <div className="group-card__body"><Markdown text={message.content} /></div>
        {assignments.map((assignment) => {
          const task = tasks?.find((candidate) => candidate.id === assignment.taskId);
          return (
            <div key={assignment.id} className="group-card__meta">
              {assignment.scope.length ? <ul aria-label="Edit scope">{assignment.scope.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : null}
              <button type="button" className="link-btn" onClick={() => { const store = useRelay.getState(); store.selectTask(assignment.taskId); store.setView('tasks'); }}>{task ? `Open task: ${task.title}` : 'Open task'}</button>
            </div>
          );
        })}
        <DeliveryChips deliveries={deliveries} label={handleOf} />
        {time}
      </section>
    );
  }
  return (
    <article className="msg msg--assistant" aria-label={sender ? `Message from @${sender.handle}` : 'Group message'}>
      <div className="msg__main">
        {sender ? <SpeakerLabel speaker={sender} trailing={recipients.length ? <span className="speaker__to"><ArrowRight size={11} aria-hidden="true" /> <Handles speakersList={recipients} /></span> : undefined} /> : null}
        <div className="msg__content"><Markdown text={message.content} /></div>
        <DeliveryChips deliveries={deliveries} label={handleOf} />
        {time}
      </div>
    </article>
  );
}

export function GroupConversation({ snapshot }: { snapshot: GroupSnapshot }) {
  const project = useProject();
  const sessions = useRelay((s) => s.boot?.sessions ?? NO_SESSIONS);
  const messages = useRelay((s) => s.boot?.messages ?? NO_MESSAGES);
  const streams = useRelay((s) => s.streams);
  const allRuns = useRelay((s) => s.boot?.runs ?? NO_RUNS);
  const allCalls = useRelay((s) => s.boot?.toolCalls ?? NO_CALLS);
  const approvals = useRelay((s) => s.boot?.approvals);
  const creating = useRelay((s) => s.creatingSession);
  const [membersOpen, setMembersOpen] = useState(false);
  const anchor = sessions.find((session) => session.id === snapshot.group.anchorSessionId);
  const members = useMemo(() => activeMembers(snapshot), [snapshot]);
  const { byMember, bySession } = useMemo(() => speakers(snapshot), [snapshot]);

  const items = useMemo(() => buildTimeline({ snapshot, sessions, messages, streams }), [snapshot, sessions, messages, streams]);
  const sessionIds = useMemo(() => memberSessionIds(snapshot), [snapshot]);
  const runs = useMemo(() => groupRuns(snapshot, allRuns), [snapshot, allRuns]);
  const placement = useMemo(() => placeRuns(items, runs), [items, runs]);
  const calls = useMemo(() => toolCallsByRun(allCalls, sessionIds), [allCalls, sessionIds]);
  const activeSessionIds = useMemo(() => new Set(members.map((member) => member.sessionId)), [members]);
  const pending = useMemo(() => (approvals ?? []).filter((approval) => approval.status === 'pending' && activeSessionIds.has(approval.sessionId)), [approvals, activeSessionIds]);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const contentSig = items.filter((item): item is NativeItem => item.type === 'native').map((item) => `${item.key}:${item.message.content.length}`).join('|');
  const activitySig = runs.map((run) => `${run.id}:${run.status}:${run.toolCount}:${run.changes?.status ?? 'unknown'}:${run.changes?.fileCount ?? ''}`).join('|');
  const sig = `${snapshot.group.id}|${items.length}|${contentSig}|${pending.length}|${activitySig}|${allCalls.length}|${snapshot.deliveries.map((d) => d.status).join('')}`;
  useEffect(() => { stick.current = true; setAway(false); }, [snapshot.group.id]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [sig]);

  if (!project || !anchor) {
    return (
      <EmptyState icon={<FolderPlus size={20} />} title="Group unavailable" action={<Button variant="primary" disabled={creating} onClick={() => void useRelay.getState().createSession()}>New session</Button>}>
        This group’s anchor session could not be found. Select another session from the sidebar.
      </EmptyState>
    );
  }

  const visible = items.some((item) => (item.type === 'group') || (item.type === 'native' && !item.hidden && (item.message.role === 'user' || item.message.role === 'assistant')));
  const rendered: ReactNode[] = [];
  items.forEach((item, index) => {
    if (item.type === 'group') { rendered.push(<GroupMessageRow key={item.key} item={item} snapshot={snapshot} />); return; }
    if (item.type === 'failure') {
      rendered.push(
        <div key={item.key} className="chat__error" role="alert">
          <strong>Delivery to {item.member ? `@${item.member.handle}` : 'a member'} failed</strong><span>{item.delivery.error}</span>
        </div>,
      );
      return;
    }
    const { message } = item;
    const body: ReactNode[] = [];
    if (!item.hidden) {
      if (message.role === 'tool') {
        const previous = items[index - 1];
        if (previous?.type === 'native' && previous.message.role === 'tool' && previous.sessionId === item.sessionId) return;
        const batch = [message];
        for (let next = index + 1; next < items.length; next++) {
          const candidate = items[next];
          if (candidate?.type !== 'native' || candidate.message.role !== 'tool' || candidate.sessionId !== item.sessionId) break;
          batch.push(candidate.message);
        }
        body.push(<LegacyToolGroup key={`${item.key}:tools`} messages={batch} />);
      } else {
        const session = sessions.find((candidate) => candidate.id === item.sessionId);
        const labelled = item.speaker && (message.role === 'assistant' || (message.role === 'user' && item.sessionId !== snapshot.group.anchorSessionId));
        body.push(<MessageRow key={`${item.key}:row`} m={message} provider={session?.provider ?? anchor.provider} speaker={labelled ? item.speaker : null} />);
      }
    }
    for (const run of placement.activityAfter.get(item.key) ?? []) {
      const who = bySession.get(run.sessionId);
      body.push(
        <div key={`run:${run.id}`} className="group-run">
          {who ? <span className="group-run__who">@{who.handle}</span> : null}
          <RunActivity run={run} initialCalls={calls.get(run.id) ?? NO_CALLS} />
        </div>,
      );
    }
    for (const run of (placement.changesAfter.get(item.key) ?? []).filter((candidate) => candidate.status !== 'running')) body.push(<RunChanges key={`changes:${run.id}`} runId={run.id} summary={run.changes} />);
    if (body.length) rendered.push(<Fragment key={item.key}>{body}</Fragment>);
  });

  const working = members.flatMap((member) => {
    const session = sessions.find((candidate) => candidate.id === member.sessionId);
    return session?.status === 'running' && !runs.some((run) => run.sessionId === session.id && run.status === 'running') ? [member] : [];
  });
  const failed = members.flatMap((member) => {
    const session = sessions.find((candidate) => candidate.id === member.sessionId);
    return session?.status === 'error' && session.error ? [{ member, error: session.error }] : [];
  });

  return (
    <div className="chat chat--group">
      <GroupBar snapshot={snapshot} membersOpen={membersOpen} setMembersOpen={setMembersOpen} />
      <div
        className="chat__scroll" ref={scroller} role="log" aria-live="polite" aria-label={`Group conversation: ${snapshot.group.title || anchor.name}`}
        onScroll={(event) => {
          const el = event.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          setAway(!near);
        }}
      >
        <div className="chat__inner">
          {!visible ? (
            <div className="chat__empty">
              <h3>Start the group conversation</h3>
              <p>Messages without an @mention follow this group’s routing. Mention <span className="handle">@{members[0]?.handle ?? 'agent'}</span> to reach one agent.</p>
            </div>
          ) : null}
          {rendered}
          {placement.unplaced.map((run) => {
            const who = bySession.get(run.sessionId);
            return (
              <Fragment key={run.id}>
                <div className="group-run">{who ? <span className="group-run__who">@{who.handle}</span> : null}<RunActivity run={run} initialCalls={calls.get(run.id) ?? NO_CALLS} /></div>
                {run.status !== 'running' ? <RunChanges runId={run.id} summary={run.changes} /> : null}
              </Fragment>
            );
          })}
          {working.map((member) => <div key={member.id} className="working" role="status"><span className="activity-shimmer">@{member.handle} is working…</span></div>)}
          {failed.map(({ member, error }) => <div key={member.id} className="chat__error" role="alert"><strong>@{member.handle} · session error</strong><span>{error}</span></div>)}
          {pending.map((approval) => <ApprovalCard key={approval.id} approval={approval} speaker={bySession.get(approval.sessionId) ?? byMember.get(approval.sessionId) ?? null} />)}
        </div>
      </div>
      {away ? (
        <button type="button" className="jump" onClick={() => { const el = scroller.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }}>
          <ArrowDown size={13} /> Latest
        </button>
      ) : null}
      <GroupComposer key={snapshot.group.id} snapshot={snapshot} anchor={anchor} onOpenMembers={() => setMembersOpen(true)} footer={<GitBar project={project} session={anchor} />} />
    </div>
  );
}


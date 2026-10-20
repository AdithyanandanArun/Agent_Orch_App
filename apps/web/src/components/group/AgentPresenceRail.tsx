import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Approval, GroupMember, GroupSnapshot, ProviderInfo, Session, SessionRun } from '@relay/contracts';
import { configSummary, ROLE_LABEL } from '../../lib/groups';
import { memberPresence } from '../../lib/groupPresence';
import { formatElapsed } from '../../lib/activity';
import { AgentIdentity } from './AgentIdentity';

function useElapsed(startedAt: string | null, active: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, active]);
  if (!active || !startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  return formatElapsed(Math.max(0, now - start));
}

function PresenceRow({
  snapshot, member, session, runs, approvals, connection, providers,
}: {
  snapshot: GroupSnapshot; member: GroupMember; session: Session | undefined; runs: readonly SessionRun[];
  approvals: readonly Approval[]; connection: 'online' | 'connecting' | 'offline'; providers: readonly ProviderInfo[];
}) {
  const presence = memberPresence({ snapshot, member, session, runs, approvals, connection });
  const elapsed = useElapsed(presence.startedAt, presence.working);
  const summary = session ? configSummary({ model: session.model, effort: session.effort, policy: session.policy, serviceTier: session.serviceTier ?? 'standard' }, providers, session.provider) : null;
  return (
    <li className={`agent-presence__row is-${presence.state}`}>
      <div className="agent-presence__identity" title={ROLE_LABEL[member.role]}>
        <AgentIdentity handle={member.handle} identityKey={member.sessionId} provider={session?.provider} />
        <span className="agent-presence__state" title={`${presence.label}${elapsed ? ` · ${elapsed}` : ''}`} aria-label={`${presence.label}${elapsed ? `, elapsed ${elapsed}` : ''}`}>
          <span className={presence.working ? 'activity-shimmer' : undefined}>{presence.label}</span>
          {elapsed ? <time className="agent-presence__elapsed" dateTime={presence.startedAt ?? undefined} aria-live="off">{elapsed}</time> : null}
        </span>
      </div>
      {summary && session ? <small className="agent-presence__model" title={`${summary.model} · ${summary.detail}`}>{summary.model} · {summary.detail.split(' · ')[0]}</small> : null}
      {presence.detail ? <small className="agent-presence__detail" title={presence.detail}>{presence.detail}</small> : null}
    </li>
  );
}

export function AgentPresenceRail({
  snapshot, members, sessions, runs, approvals, connection, providers, hidden = false,
}: {
  snapshot: GroupSnapshot; members: readonly GroupMember[]; sessions: readonly Session[]; runs: readonly SessionRun[];
  approvals: readonly Approval[]; connection: 'online' | 'connecting' | 'offline'; providers: readonly ProviderInfo[];
  hidden?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const listId = useId();
  const preference = useRef<boolean | null>(null);
  const [expanded, setExpanded] = useState(true);
  const presence = members.map((member) => memberPresence({
    snapshot, member, session: sessions.find((session) => session.id === member.sessionId), runs, approvals, connection,
  }));
  const workingCount = presence.filter((state) => state.working).length;
  const queuedCount = presence.reduce((total, state) => total + state.queuedCount, 0);
  const needsApproval = presence.some((state) => state.state === 'approval');
  const otherState = presence.find((state) => ['error', 'unavailable', 'paused', 'interrupted'].includes(state.state));
  const activity = needsApproval ? 'Needs approval'
    : workingCount ? `${workingCount} working${queuedCount ? ` · ${queuedCount} queued` : ''}`
      : queuedCount ? `${queuedCount} queued`
        : otherState?.label ?? (members.length ? 'All idle' : 'No agents');
  const caption = connection === 'connecting' ? 'Reconnecting' : connection === 'offline' ? 'Offline'
    : expanded ? members.length : activity;

  useLayoutEffect(() => {
    const container = panel.current?.parentElement;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const transcript = container.querySelector<HTMLElement>('.chat__scroll');
    const update = () => {
      // Follow the visible transcript, including when a growing composer consumes more height.
      const availableHeight = Math.max(0, (transcript?.clientHeight ?? container.clientHeight) - 24);
      panel.current?.style.setProperty('--agent-presence-max-height', `${Math.min(280, availableHeight)}px`);
    };
    const updateDefault = () => {
      const availableHeight = Math.max(0, (transcript?.clientHeight ?? container.clientHeight) - 24);
      if (preference.current === null) setExpanded(container.clientWidth >= 960 && availableHeight >= 240);
    };
    update();
    updateDefault();
    // Context pane width transitions must not switch the bubble's expansion midway through its fade.
    window.addEventListener('resize', updateDefault);
    const observer = new ResizeObserver(update);
    observer.observe(container);
    if (transcript) observer.observe(transcript);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateDefault);
    };
  }, []);

  const toggle = () => {
    preference.current = !expanded;
    setExpanded(!expanded);
  };

  return (
    <aside ref={panel} className={`agent-presence${expanded ? ' is-expanded' : ' is-collapsed'}${hidden ? ' is-hidden' : ''}`} aria-label="Agent presence" aria-hidden={hidden} inert={hidden}>
      <header className="agent-presence__head">
        <strong>Agents</strong>
        <span>{caption}</span>
        <button type="button" className="agent-presence__toggle" aria-label={expanded ? 'Collapse agent presence' : 'Expand agent presence'} aria-expanded={expanded} aria-controls={listId} onClick={toggle}>
          <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
      </header>
      <ul className="agent-presence__list" id={listId}>
        {members.map((member) => (
          <PresenceRow key={member.id} snapshot={snapshot} member={member} session={sessions.find((item) => item.id === member.sessionId)} runs={runs} approvals={approvals} connection={connection} providers={providers} />
        ))}
      </ul>
    </aside>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
      <div className="agent-presence__identity">
        <AgentIdentity handle={member.handle} identityKey={member.sessionId} provider={session?.provider} />
        <span className="agent-presence__role">{ROLE_LABEL[member.role]}</span>
      </div>
      {summary && session ? <small className="agent-presence__model" title={`${summary.model} · ${summary.detail}`}>{summary.model} · {summary.detail.split(' · ')[0]}</small> : null}
      <div className="agent-presence__state" aria-label={`${presence.label}${elapsed ? `, elapsed ${elapsed}` : ''}`}>
        <span className={presence.working ? 'activity-shimmer' : undefined}>{presence.label}</span>
        {elapsed ? <time className="agent-presence__elapsed" dateTime={presence.startedAt ?? undefined} aria-live="off">{elapsed}</time> : null}
      </div>
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
  const preference = useRef<boolean | null>(null);
  const [expanded, setExpanded] = useState(true);

  useLayoutEffect(() => {
    const container = panel.current?.parentElement;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      if (preference.current === null) setExpanded(container.clientWidth >= 640 && container.clientHeight >= 500);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const toggle = () => {
    preference.current = !expanded;
    setExpanded(!expanded);
  };

  return (
    <aside ref={panel} className={`agent-presence${expanded ? ' is-expanded' : ' is-collapsed'}${hidden ? ' is-hidden' : ''}`} aria-label="Agent presence" aria-hidden={hidden} inert={hidden}>
      <header className="agent-presence__head">
        <strong>Agents</strong>
        <span>{connection === 'online' ? members.length : connection === 'connecting' ? 'Reconnecting' : 'Offline'}</span>
        <button type="button" className="agent-presence__toggle" aria-label={expanded ? 'Collapse agent presence' : 'Expand agent presence'} aria-expanded={expanded} aria-controls="agent-presence-list" onClick={toggle}>
          <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
      </header>
      <ul className="agent-presence__list" id="agent-presence-list">
        {members.map((member) => (
          <PresenceRow key={member.id} snapshot={snapshot} member={member} session={sessions.find((item) => item.id === member.sessionId)} runs={runs} approvals={approvals} connection={connection} providers={providers} />
        ))}
      </ul>
    </aside>
  );
}

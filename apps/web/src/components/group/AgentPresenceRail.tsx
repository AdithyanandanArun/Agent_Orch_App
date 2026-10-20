import { useEffect, useState } from 'react';
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
  snapshot, members, sessions, runs, approvals, connection, providers,
}: {
  snapshot: GroupSnapshot; members: readonly GroupMember[]; sessions: readonly Session[]; runs: readonly SessionRun[];
  approvals: readonly Approval[]; connection: 'online' | 'connecting' | 'offline'; providers: readonly ProviderInfo[];
}) {
  return (
    <aside className="agent-presence" aria-label="Live agent presence">
      <header className="agent-presence__head"><strong>Agents</strong><span>{connection === 'online' ? members.length : connection === 'connecting' ? 'Reconnecting' : 'Offline'}</span></header>
      <ul className="agent-presence__list">
        {members.map((member) => (
          <PresenceRow key={member.id} snapshot={snapshot} member={member} session={sessions.find((item) => item.id === member.sessionId)} runs={runs} approvals={approvals} connection={connection} providers={providers} />
        ))}
      </ul>
    </aside>
  );
}

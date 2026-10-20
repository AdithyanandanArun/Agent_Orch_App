import { useRef, useState } from 'react';
import { Pause, Play, Square, Users } from 'lucide-react';
import type { GroupSnapshot } from '@mingle/contracts';
import { useMingle } from '../../store/store';
import { pauseGroup, resumeGroup, stopGroup } from '../../lib/groupActions';
import { MODE_LABEL, activeMembers, isBusy } from '../../lib/groups';
import { Button } from '../ui';
import { MembersPopover } from './MembersPopover';
import { AgentIdentity } from './AgentIdentity';

export function GroupBar({ snapshot, membersOpen, setMembersOpen }: { snapshot: GroupSnapshot; membersOpen: boolean; setMembersOpen: (open: boolean) => void }) {
  const sessions = useMingle((s) => s.boot?.sessions);
  const approvals = useMingle((s) => s.boot?.approvals);
  const connection = useMingle((s) => s.connection);
  const trigger = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<'pause' | 'stop' | null>(null);
  const { group } = snapshot;
  const members = activeMembers(snapshot);
  const online = connection === 'online';
  const live = members.map((member) => sessions?.find((session) => session.id === member.sessionId));
  const running = live.filter((session) => session?.status === 'running').length;
  const erroring = live.filter((session) => session?.status === 'error').length;
  const sessionIds = new Set(members.map((member) => member.sessionId));
  const pendingApprovals = (approvals ?? []).filter((approval) => approval.status === 'pending' && sessionIds.has(approval.sessionId)).length;
  const queued = snapshot.deliveries.filter((delivery) => delivery.status === 'queued').length;
  const anyBusy = live.some((session) => isBusy(session));
  const lead = members.find((member) => member.id === group.orchestratorMemberId);
  const request = [...snapshot.requests].reverse().find((item) => item.status === 'active' || item.status === 'paused');

  const facts = [
    running ? `${running} running` : null,
    pendingApprovals ? `${pendingApprovals} awaiting approval` : null,
    erroring ? `${erroring} with errors` : null,
    queued ? `${queued} queued` : null,
    request ? `turns ${request.turnsUsed}/${group.maxTurns}` : null,
    !anyBusy && !queued && !group.paused ? 'Idle' : null,
  ].filter(Boolean);

  return (
    <div className="group-bar" role="region" aria-label="Group conversation">
      <div className="group-bar__info">
        <strong>{MODE_LABEL[group.mode]}</strong>
        <span>{group.mode === 'cowork' ? `${members.length} peers` : lead ? <><AgentIdentity handle={lead.handle} identityKey={lead.sessionId} provider={live.find((session) => session?.id === lead.sessionId)?.provider} /> {group.mode === 'orchestrated' ? 'coordinates' : 'leads'}</> : `${members.length} agents`}</span>
        {group.paused ? <span className="group-bar__paused" title={group.pauseReason ?? undefined}>Paused{group.pauseReason ? ` · ${group.pauseReason}` : ''}</span> : null}
        {facts.length ? <span className="group-bar__facts" role="status">{facts.join(' · ')}</span> : null}
      </div>
      <div className="group-bar__actions">
        {group.paused
          ? <Button size="sm" disabled={!online || busy !== null} why="Reconnect to the server first." onClick={() => { setBusy('pause'); void resumeGroup(group.id).finally(() => setBusy(null)); }}><Play size={12} aria-hidden="true" /> Resume</Button>
          : <Button size="sm" busy={busy === 'pause'} disabled={!online || busy !== null} why="Reconnect to the server first." title="Stop starting new work. Runs in progress finish." onClick={() => { setBusy('pause'); void pauseGroup(group.id).finally(() => setBusy(null)); }}><Pause size={12} aria-hidden="true" /> Pause</Button>}
        <Button size="sm" variant="danger" busy={busy === 'stop'} disabled={!online || (!anyBusy && queued === 0) || busy !== null} why={anyBusy || queued ? 'Reconnect to the server first.' : 'Nothing is running or queued'} title="Pause the group and interrupt every running member." onClick={() => { setBusy('stop'); void stopGroup(snapshot).finally(() => setBusy(null)); }}><Square size={11} fill="currentColor" aria-hidden="true" /> Stop</Button>
        <button ref={trigger} type="button" className="btn btn--secondary btn--sm" aria-haspopup="dialog" aria-expanded={membersOpen} onClick={() => setMembersOpen(!membersOpen)}>
          <Users size={13} aria-hidden="true" /> Members · {members.length}
        </button>
      </div>
      <MembersPopover snapshot={snapshot} anchor={trigger} open={membersOpen} onClose={() => setMembersOpen(false)} />
    </div>
  );
}

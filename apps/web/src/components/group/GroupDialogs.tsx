import { useId, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { AgentConfiguration, GroupMode } from '@relay/contracts';
import { useRelay } from '../../store/store';
import { api, errorMessage, type SessionPatch } from '../../lib/api';
import { shortPath } from '../../lib/format';
import {
  MODE_LABEL, ROLE_LABEL, activeMembers, isBusy, memberHasActiveWork, routingSummary, sameConfig, sessionConfig,
} from '../../lib/groups';
import { Button, Field, InlineError, Modal } from '../ui';
import { SelectMenu } from '../SelectMenu';
import { ConfigFields } from './ConfigFields';
import { Roster, type RosterEntry } from './AddAgentDialog';

const MODES: GroupMode[] = ['cowork', 'orchestrated', 'current-leads'];

/** Edits one member's saved session settings, only while that member has no active or queued work. */
export function MemberSettingsDialog({ groupId, memberId }: { groupId: string; memberId: string }) {
  const close = useRelay.getState().closeDialog;
  const connection = useRelay((s) => s.connection);
  const snapshot = useRelay((s) => s.boot?.groups?.find((g) => g.group.id === groupId));
  const member = snapshot?.members.find((m) => m.id === memberId);
  const session = useRelay((s) => s.boot?.sessions.find((x) => x.id === member?.sessionId));
  const idBase = useId();
  const [config, setConfig] = useState<AgentConfiguration | null>(() => (session ? sessionConfig(session) : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!snapshot || !member || !session || !config) {
    return <Modal title="Member settings" onClose={close} width={460}><p className="field__hint">This member is no longer in the group.</p></Modal>;
  }
  const locked = memberHasActiveWork(snapshot, member, session);
  const baseline = sessionConfig(session);
  const dirty = !sameConfig(baseline, config);
  const why = connection !== 'online' ? 'Reconnect to the server first.' : locked ? 'Settings can change only while this member is idle with no queued work.' : !dirty ? 'No changes to save.' : undefined;

  const save = async () => {
    if (why) return;
    const patch: SessionPatch = {};
    if (config.provider !== baseline.provider) patch.provider = config.provider;
    if (config.model !== baseline.model) patch.model = config.model;
    if (config.effort !== baseline.effort) patch.effort = config.effort;
    if (config.policy !== baseline.policy) patch.policy = config.policy;
    if (config.serviceTier !== baseline.serviceTier) patch.serviceTier = config.serviceTier;
    setBusy(true);
    setError(null);
    try {
      await api.updateSession(session.id, patch);
      await useRelay.getState().refreshNow();
      useRelay.getState().toast('success', `Updated @${member.handle}.`);
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`@${member.handle} settings`} description={`${ROLE_LABEL[member.role]} · ${session.name}`} onClose={close} width={620}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" busy={busy} disabled={Boolean(why)} why={why} onClick={() => void save()}>Save settings</Button></>}>
      <div className="form">
        <p className="field__hint">These are the saved settings of this member’s own session. Changing model or effort keeps its conversation; the provider can change only before a provider conversation exists.</p>
        <ConfigFields idPrefix={idBase} legend={`@${member.handle} configuration`} value={config} onChange={setConfig} lockProvider={Boolean(session.providerSessionId)} disabled={locked} />
        <div className="gd-facts">
          <div><span>Workspace</span><strong>{session.isolated ? 'Isolated worktree' : 'Project folder'}</strong><small>{session.branch ? `${session.branch} · ` : ''}{shortPath(session.worktreePath, 4)}</small></div>
        </div>
        {locked ? <div className="inline-warn" role="note"><AlertTriangle size={14} aria-hidden="true" /><span>@{member.handle} is {isBusy(session) ? session.status : 'waiting on queued work'}. Stop it or wait for it to finish before changing settings.</span></div> : null}
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}

/** Explicit, idle-time mode transition with the resulting roster and routing, using the supported UpdateGroup fields only. */
export function GroupModeDialog({ groupId }: { groupId: string }) {
  const close = useRelay.getState().closeDialog;
  const connection = useRelay((s) => s.connection);
  const sessions = useRelay((s) => s.boot?.sessions);
  const providers = useRelay((s) => s.boot?.providers);
  const snapshot = useRelay((s) => s.boot?.groups?.find((g) => g.group.id === groupId));
  const idBase = useId();
  const members = useMemo(() => (snapshot ? activeMembers(snapshot) : []), [snapshot]);
  const [mode, setMode] = useState<GroupMode>(snapshot?.group.mode ?? 'cowork');
  const [lead, setLead] = useState<string>(() => snapshot?.group.orchestratorMemberId ?? members.find((m) => m.sessionId !== snapshot?.group.anchorSessionId)?.id ?? members[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limits, setLimits] = useState({ maxParallel: String(snapshot?.group.maxParallel ?? 2), maxTurns: String(snapshot?.group.maxTurns ?? 16), maxHops: String(snapshot?.group.maxHops ?? 6) });

  if (!snapshot || !providers || !sessions) return <Modal title="Change mode" onClose={close} width={460}><p className="field__hint">This group is no longer available.</p></Modal>;
  const group = snapshot.group;
  const needsLead = mode !== 'cowork';
  const anchorMember = members.find((member) => member.sessionId === group.anchorSessionId);
  const coordinators = members.filter((member) => member.sessionId !== group.anchorSessionId);
  const leadId = mode === 'current-leads' ? anchorMember?.id ?? null : mode === 'orchestrated' ? lead : null;
  const running = members.filter((m) => isBusy(sessions.find((s) => s.id === m.sessionId)));
  const runningDeliveries = snapshot.deliveries.filter((d) => d.status === 'running');
  const queued = snapshot.deliveries.filter((d) => d.status === 'queued');
  const unchanged = mode === group.mode && (!needsLead || leadId === group.orchestratorMemberId);
  const bounds = { maxParallel: { label: 'Simultaneous runs', min: 1, max: 6 }, maxTurns: { label: 'Automatic turns', min: 2, max: 80 }, maxHops: { label: 'Message hops', min: 1, max: 12 } } as const;
  type LimitKey = keyof typeof bounds;
  const limitKeys = Object.keys(bounds) as LimitKey[];
  const validLimit = (key: LimitKey) => limits[key].trim() !== '' && Number.isInteger(Number(limits[key])) && Number(limits[key]) >= bounds[key].min && Number(limits[key]) <= bounds[key].max;
  const limitsValid = limitKeys.every(validLimit);
  const limitsDirty = limitKeys.some((key) => Number(limits[key]) !== group[key]);
  const why = connection !== 'online' ? 'Reconnect to the server first.'
    : running.length || runningDeliveries.length ? 'Mode can change only while every member is idle. Wait for runs to finish or stop them.'
      : queued.length && !group.paused ? `${queued.length} queued ${queued.length === 1 ? 'delivery' : 'deliveries'} would be affected. Pause the group before changing its mode.`
        : !limitsValid ? 'Enter whole-number limits within the displayed ranges.'
          : needsLead && !leadId ? 'Choose which member coordinates.'
            : mode === 'orchestrated' && !coordinators.some((member) => member.id === leadId) ? 'Choose a coordinator other than the original session.'
              : unchanged && !limitsDirty ? 'No changes to save.' : undefined;

  const roster: RosterEntry[] = members.map((member) => {
    const session = sessions.find((s) => s.id === member.sessionId);
    return {
      key: member.id, handle: member.handle, role: !needsLead ? 'peer' : member.id === leadId ? 'orchestrator' : 'worker',
      note: member.role === (!needsLead ? 'peer' : member.id === leadId ? 'orchestrator' : 'worker') ? 'Unchanged' : `Was ${ROLE_LABEL[member.role].toLowerCase()}`,
      provider: session?.provider ?? 'claude', model: session?.model ?? '', effort: session?.effort ?? '', policy: session?.policy ?? 'supervised', serviceTier: session?.serviceTier ?? 'standard',
      workspace: session ? (session.isolated ? 'Isolated worktree' : 'Project folder') : 'Unknown workspace',
    };
  });
  const routing = routingSummary(mode, roster.map((entry) => ({ handle: entry.handle, role: entry.role })));

  const apply = async () => {
    if (why) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateGroup(group.id, {
        ...(!unchanged ? { mode, ...(leadId ? { orchestratorMemberId: leadId } : {}) } : {}),
        ...(limitsDirty ? { maxParallel: Number(limits.maxParallel), maxTurns: Number(limits.maxTurns), maxHops: Number(limits.maxHops) } : {}),
      });
      const store = useRelay.getState();
      store.applyGroup(updated);
      await store.refreshNow();
      store.toast('success', 'Group settings saved. Resume explicitly when you are ready to continue paused work.');
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Group settings" description="Review routing, participants and automatic work limits. Completed history is kept." onClose={close} width={760}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" busy={busy} disabled={Boolean(why)} why={why} onClick={() => void apply()}>Apply settings</Button></>}>
      <div className="group-dialog form">
        <fieldset className="gm-list">
          <legend className="gd-h">Mode</legend>
          {MODES.map((value, index) => (
            <label key={value} className="gm-option">
              <input type="radio" name={`${idBase}-mode`} value={value} checked={mode === value} data-autofocus={index === 0 ? '' : undefined} onChange={() => { setMode(value); if (value === 'orchestrated' && !coordinators.some((member) => member.id === lead)) setLead(coordinators[0]?.id ?? ''); }} />
              <span><strong>{MODE_LABEL[value]}</strong><small>{value === 'cowork' ? 'You direct equal peers. Unaddressed messages reach every active peer.' : value === 'current-leads' ? 'The original session becomes the orchestrator and retains its existing context and configuration.' : 'Choose an existing member other than the original session to coordinate. This change creates no new agent.'}</small></span>
            </label>
          ))}
        </fieldset>
        {mode === 'orchestrated' ? (
          <Field label={mode === 'orchestrated' ? 'Orchestrator' : 'Lead agent'} htmlFor={`${idBase}-lead`}
            hint="Choose one of the current members. A separate orchestrator can only be created when a single session is first converted.">
            <SelectMenu id={`${idBase}-lead`} label="Coordinating member" value={lead} onChange={setLead} options={coordinators.map((m) => ({ value: m.id, label: `@${m.handle}`, description: ROLE_LABEL[m.role] }))} />
          </Field>
        ) : null}
        <section aria-label="Roster after the change">
          <h3 className="gd-h">After the change</h3>
          <Roster entries={roster} providers={providers} />
          <p className="gd-routing" role="status">{routing}</p>
        </section>
        <section className="group-limits" aria-labelledby={`${idBase}-limits`}>
          <h3 className="gd-h" id={`${idBase}-limits`}>Automatic work limits</h3>
          <p className="field__hint">Limits apply to this group. Raising a reached limit does not restart work: review the queue, then choose Resume.</p>
          <div className="group-limit-grid">
            {limitKeys.map((key) => <Field key={key} label={bounds[key].label} htmlFor={`${idBase}-${key}`} hint={`${bounds[key].min}–${bounds[key].max}`} error={validLimit(key) ? null : 'Enter a whole number in this range.'}>
              <input id={`${idBase}-${key}`} className="input group-limit-field" type="number" min={bounds[key].min} max={bounds[key].max} step={1} inputMode="numeric" value={limits[key]} disabled={busy} aria-invalid={!validLimit(key)} onChange={(event) => setLimits((current) => ({ ...current, [key]: event.target.value }))} />
            </Field>)}
          </div>
        </section>
        {queued.length ? <div className="inline-warn" role="note"><AlertTriangle size={14} aria-hidden="true" /><span>{queued.length} queued {queued.length === 1 ? 'delivery stays' : 'deliveries stay'} with {queued.length === 1 ? 'its' : 'their'} original {queued.length === 1 ? 'recipient' : 'recipients'}; review {queued.length === 1 ? 'it' : 'them'} after the change before resuming.</span></div> : null}
        {why && !unchanged ? <p className="field__hint" role="status">{why}</p> : null}
        {error ? <InlineError>{error}</InlineError> : null}
      </div>
    </Modal>
  );
}


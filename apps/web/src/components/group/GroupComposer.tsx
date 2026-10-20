import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, AtSign, Square, UserPlus, X } from 'lucide-react';
import type { GroupSnapshot, Provider, Session } from '@relay/contracts';
import { useRelay } from '../../store/store';
import { api, errorMessage } from '../../lib/api';
import { cx } from '../../lib/format';
import { stopGroup } from '../../lib/groupActions';
import {
  MODE_LABEL, ROLE_LABEL, activeMembers, defaultRecipients, isBusy, maskNonActionable, providerAvailability, providerName, resolveMentions, retiredHandles, type MentionCandidate,
} from '../../lib/groups';
import { MOD } from '../ui';
import { Popover } from '../git/Popover';
import { UsagePanel } from '../UsagePanel';
import { AgentIdentity } from './AgentIdentity';

const COMMANDS = [
  { name: 'new', description: 'Create a new session' },
  { name: 'stop', description: 'Pause the group and interrupt running members' },
  { name: 'members', description: 'Open participants, status and settings' },
  { name: 'agent', description: 'Add another agent to this group' },
  { name: 'settings', description: 'Open Settings' },
  { name: 'model', description: 'Edit a member’s model in Members' },
  { name: 'effort', description: 'Edit a member’s effort in Members' },
  { name: 'permissions', description: 'Edit a member’s permissions in Members' },
  { name: 'tier', description: 'Edit a member’s service tier in Members' },
  { name: 'skills', description: 'Not available for group messages' },
  { name: 'usage', description: 'Show provider limits (add @handle for a member)' },
  { name: 'import', description: 'Import a local supported provider conversation' },
  { name: 'status', description: 'Show this group’s mode and members' },
  { name: 'diff', description: 'Open the Changes pane' },
  { name: 'help', description: 'List Relay commands' },
] as const;
const LOCAL_COMMAND = new RegExp(`^/(${COMMANDS.map((command) => command.name).join('|')})(?:\\s.*)?$`, 'i');
const MAX_RECIPIENTS = 8;

interface Suggestion { key: string; token: string; description: string; group: string; identityKey?: string; provider?: Provider }

/** The group conversation's composer: it resolves recipients itself and sends one message to the group endpoint. */
export function GroupComposer({ snapshot, anchor, onOpenMembers, footer }: { snapshot: GroupSnapshot; anchor: Session; onOpenMembers: () => void; footer?: ReactNode }) {
  const draft = useRelay((s) => s.drafts[anchor.id] ?? '');
  const connection = useRelay((s) => s.connection);
  const providers = useRelay((s) => s.boot?.providers);
  const sessions = useRelay((s) => s.boot?.sessions);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const pickerId = useId();
  const pendingId = useRef<{ key: string; id: string } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [usageSession, setUsageSession] = useState<Session | null>(null);

  const members = useMemo(() => activeMembers(snapshot), [snapshot]);
  const retired = useMemo(() => retiredHandles(snapshot), [snapshot]);
  const sessionOf = (sessionId: string) => sessions?.find((session) => session.id === sessionId);
  const candidates = useMemo<MentionCandidate[]>(
    () => members.flatMap((member) => {
      const provider = sessions?.find((session) => session.id === member.sessionId)?.provider;
      return provider ? [{ id: member.id, handle: member.handle, provider }] : [{ id: member.id, handle: member.handle }];
    }),
    [members, sessions],
  );
  const caretIndex = Math.min(caret, draft.length);
  const mentions = useMemo(() => resolveMentions(draft, candidates, retired), [draft, candidates, retired]);
  const pickedActive = picked.filter((id) => members.some((member) => member.id === id));
  const stalePicked = picked.filter((id) => !members.some((member) => member.id === id));
  const staleSelectionError = stalePicked.length ? 'A selected recipient was removed. Remove the unavailable recipient chip or clear selection before sending.' : null;
  const direct = members.filter((member) => pickedActive.includes(member.id) || mentions.ids.includes(member.id));
  const defaults = useMemo(() => defaultRecipients(snapshot), [snapshot]);
  const recipients = direct.length ? direct : defaults;
  const anyBusy = members.some((member) => isBusy(sessionOf(member.sessionId)));

  const empty = draft.trim().length === 0;
  const local = LOCAL_COMMAND.exec(draft.trim());
  const unavailable = recipients.map((member) => {
    const session = sessionOf(member.sessionId);
    const state = session && providers ? providerAvailability(providers, session.provider) : null;
    return state && !state.available ? `@${member.handle}: ${providerName(session!.provider)} needs setup — ${state.reason}` : null;
  }).find(Boolean) ?? null;
  const blocker = connection !== 'online' ? 'Disconnected from the Relay server — reconnect to send.'
    : recipients.length === 0 ? 'No agent is set to receive unaddressed messages. Mention an agent or choose a recipient.'
      : recipients.length > MAX_RECIPIENTS ? `A message can address at most ${MAX_RECIPIENTS} agents.`
        : unavailable;
  const problem = staleSelectionError ?? mentions.problems[0]?.message ?? null;
  const sendDisabled = sending || empty || (!local && (Boolean(blocker) || Boolean(problem)));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft]);

  const actionable = useMemo(() => maskNonActionable(draft), [draft]);
  const before = actionable.slice(0, caretIndex);
  const commandMatch = before.match(/(?:^|\s)(\/[^\s]*)$/);
  const mentionMatch = commandMatch ? null : before.match(/(?:^|[\s([{"'“‘,;:!?])@([A-Za-z0-9_-]*)$/);
  const skillTrigger = !commandMatch && !mentionMatch && /(?:^|\s)\$[^\s]*$/.test(before);
  const trigger = commandMatch?.[1] ?? (mentionMatch ? `@${mentionMatch[1]}` : '');
  const triggerStart = caretIndex - trigger.length;
  const suggestions: Suggestion[] = (() => {
    if (commandMatch) return COMMANDS.filter((command) => command.name.startsWith(trigger.slice(1).toLowerCase())).map((command) => ({ key: `c:${command.name}`, token: `/${command.name}`, description: command.description, group: 'Relay' }));
    if (mentionMatch) {
      const query = mentionMatch[1]!.toLowerCase();
      const matching = members.filter((member) => member.handle.toLowerCase().startsWith(query));
      const antigravity = members.filter((member) => sessionOf(member.sessionId)?.provider === 'antigravity');
      const isAntigravityAlias = Boolean(query && 'antigravity'.startsWith(query));
      const alias = isAntigravityAlias && antigravity.length === 1 ? [{
        key: `provider:antigravity:${antigravity[0]!.id}`, token: '@antigravity', description: `Antigravity agent · @${antigravity[0]!.handle}`, group: 'Providers', identityKey: antigravity[0]!.sessionId, provider: 'antigravity' as Provider,
      }] : [];
      const aliasChoices = isAntigravityAlias && antigravity.length > 1 ? antigravity : [];
      return [...alias, ...aliasChoices, ...matching].slice(0, 8).map((member) => {
        if ('token' in member) return member;
        const session = sessionOf(member.sessionId);
        return { key: `m:${member.id}`, token: `@${member.handle}`, description: `${ROLE_LABEL[member.role]}${session ? ` · ${providerName(session.provider)} ${session.model}` : ''}`, group: 'Agents', identityKey: member.sessionId, provider: session?.provider };
      });
    }
    return [];
  })();
  const open = focused && suggestions.length > 0 && trigger !== dismissed;
  useEffect(() => { setDismissed((current) => (current === trigger ? current : null)); setActive(0); }, [trigger]);
  useEffect(() => { document.getElementById(`${pickerId}-option-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, pickerId, open]);

  const setDraft = (text: string) => useRelay.getState().setDraft(anchor.id, text);
  const choose = (index: number) => {
    const item = suggestions[index];
    if (!item) return;
    const text = `${draft.slice(0, triggerStart)}${item.token} ${draft.slice(caretIndex)}`;
    const next = triggerStart + item.token.length + 1;
    setDraft(text);
    setCaret(next);
    setDismissed(null);
    requestAnimationFrame(() => { const input = ref.current; input?.focus(); input?.setSelectionRange(next, next); });
  };

  const runLocal = async (name: string): Promise<void> => {
    const store = useRelay.getState();
    switch (name) {
      case 'new': await store.createSession(); return;
      case 'stop': await stopGroup(snapshot); return;
      case 'settings': store.openSettings(); return;
      case 'members': case 'model': case 'effort': case 'permissions': case 'tier': onOpenMembers(); return;
      case 'agent': store.openDialog({ kind: 'add-agent', sessionId: anchor.id }); return;
      case 'import': store.openDialog({ kind: 'import' }); return;
      case 'diff': store.setContextTab('changes'); return;
      case 'skills': store.toast('info', 'Skills can’t be attached to group messages: the group send carries text only.'); return;
      case 'status': {
        const lead = members.find((member) => member.id === snapshot.group.orchestratorMemberId);
        store.toast('info', `${MODE_LABEL[snapshot.group.mode]} · ${members.map((member) => `@${member.handle}`).join(', ')}${lead ? ` · ${lead.handle} ${snapshot.group.mode === 'orchestrated' ? 'coordinates' : 'leads'}` : ''}${snapshot.group.paused ? ' · paused' : ''}`);
        return;
      }
      case 'help': store.toast('info', `Relay commands: ${COMMANDS.map((command) => `/${command.name}`).join(', ')}. Type @ to address an agent.`); return;
      case 'usage': {
        if (staleSelectionError) throw new Error(staleSelectionError);
        const resolved = resolveMentions(draft, candidates, retired);
        if (resolved.problems.length) throw new Error(resolved.problems[0]!.message);
        const targets = resolved.ids.length ? resolved.ids : pickedActive;
        if (targets.length > 1) throw new Error('Choose one @handle for /usage.');
        const target = targets.length === 1 ? members.find((member) => member.id === targets[0]) : null;
        const session = sessionOf(target?.sessionId ?? anchor.id) ?? anchor;
        setUsageSession(session);
        return;
      }
      default: return;
    }
  };

  const submit = async () => {
    if (sending || empty) return;
    if (local) {
      setSending(true);
      setError(null);
      try {
        await runLocal(local[1]!.toLowerCase());
        setDraft('');
        await useRelay.getState().refreshNow();
      } catch (cause) { setError(errorMessage(cause)); } finally { setSending(false); }
      return;
    }
    if (blocker || problem) return;
    // Resolve against the current roster again at submission; stale recipient chips never dispatch.
    const fresh = resolveMentions(draft, candidates, retired);
    if (fresh.problems.length) { setError(fresh.problems[0]!.message); return; }
    const targets = members.filter((member) => pickedActive.includes(member.id) || fresh.ids.includes(member.id));
    const ids = (targets.length ? targets : defaults).map((member) => member.id);
    const content = draft.trim();
    const key = `${targets.length ? 'direct' : 'default'}\u0000${content}\u0000${ids.join(',')}`;
    const clientMessageId = pendingId.current?.key === key ? pendingId.current.id : crypto.randomUUID();
    pendingId.current = { key, id: clientMessageId };
    setSending(true);
    setError(null);
    try {
      const updated = await api.sendGroupMessage(snapshot.group.id, { content, ...(targets.length ? { recipients: ids } : {}), clientMessageId });
      const store = useRelay.getState();
      store.applyGroup(updated);
      setDraft('');
      setPicked([]);
      pendingId.current = null;
      await store.refreshNow();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const stop = async () => {
    setStopping(true);
    try { await stopGroup(snapshot); } finally { setStopping(false); }
  };

  const togglePick = (memberId: string) => setPicked((current) => (current.includes(memberId) ? current.filter((id) => id !== memberId) : [...current, memberId]));
  const defaultLabel = snapshot.group.mode === 'cowork' ? 'default: all peers' : 'default: orchestrator';
  const note = error ?? problem ?? blocker;
  const noteIsError = Boolean(error ?? problem);

  return (
    <div className="composer-wrap">
      <div className={cx('composer composer--group', blocker && 'is-blocked')}>
        <div className="recips" role="group" aria-label="Recipients">
          <span className="recips__label">To</span>
          {stalePicked.map((id) => <span key={id} className="recips__chip is-stale" title="This recipient is no longer in the group">
            <AgentIdentity handle={snapshot.members.find((member) => member.id === id)?.handle ?? 'removed-agent'} identityKey={id} removed />
            <button type="button" aria-label="Remove unavailable recipient" onClick={() => togglePick(id)}><X size={10} aria-hidden="true" /></button>
          </span>)}
          {direct.length ? direct.map((member) => {
            const removable = pickedActive.includes(member.id);
            const mentioned = mentions.ids.includes(member.id);
            return (
              <span key={member.id} className={cx('recips__chip', mentioned && !removable && 'is-mention')} title={mentioned ? 'Mentioned in your message' : 'Selected recipient'}>
                <AgentIdentity handle={member.handle} identityKey={member.sessionId} provider={sessionOf(member.sessionId)?.provider} />
                {removable ? <button type="button" aria-label={`Remove @${member.handle} from recipients`} onClick={() => togglePick(member.id)}><X size={10} aria-hidden="true" /></button> : null}
              </span>
            );
          }) : defaults.length && !stalePicked.length ? <>
            {defaults.map((member) => <span key={member.id} className="recips__chip is-default"><AgentIdentity handle={member.handle} identityKey={member.sessionId} provider={sessionOf(member.sessionId)?.provider} /></span>)}
            <span className="recips__default">{defaultLabel}</span>
          </> : !stalePicked.length ? <span className="recips__default">no default recipient</span> : null}
          <button ref={pickerButton} type="button" className="recips__pick" aria-haspopup="dialog" aria-expanded={pickerOpen} onClick={() => setPickerOpen((value) => !value)}><AtSign size={12} aria-hidden="true" /> Choose</button>
          {picked.length ? <button type="button" className="recips__clear" onClick={() => setPicked([])}>Clear selection</button> : null}
        </div>
        <label htmlFor={`composer-${anchor.id}`} className="sr-only">Message the group</label>
        <textarea
          id={`composer-${anchor.id}`} ref={ref} className="composer__input" rows={1} value={draft}
          role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open}
          aria-controls={open ? pickerId : undefined} aria-activedescendant={open ? `${pickerId}-option-${active}` : undefined}
          placeholder="Message the group — use @handle to address one agent…"
          onChange={(event) => { setCaret(event.target.selectionStart ?? event.target.value.length); setDraft(event.target.value); }}
          onFocus={(event) => { setFocused(true); setCaret(event.currentTarget.selectionStart ?? 0); }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (open && !event.nativeEvent.isComposing) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => (i + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return; }
              if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { event.preventDefault(); choose(active); return; }
              if (event.key === 'Escape') { event.preventDefault(); setDismissed(trigger); return; }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
          }}
        />
        {open ? (
          <div className="composer-picker" id={pickerId} role="listbox" aria-label={commandMatch ? 'Commands' : 'Agents'}>
            {suggestions.map((item, index) => (
              <div key={item.key}>
                {index === 0 || suggestions[index - 1]?.group !== item.group ? <div className="composer-picker__group" role="presentation">{item.group}</div> : null}
                <div role="option" id={`${pickerId}-option-${index}`} aria-selected={index === active} className={cx('composer-picker__item', index === active && 'is-active')}
                  onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(index)}>
                  <span className="composer-picker__name">{item.identityKey ? <AgentIdentity handle={item.token.slice(1)} identityKey={item.identityKey} provider={item.provider} /> : item.token}</span><span className="composer-picker__description">{item.description}</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {focused && skillTrigger ? <div className="composer-picker-empty" role="status">Skills can’t be attached to group messages: the group send carries text only.</div> : null}
        <div className="composer__bar">
          <div className="composer__controls">
            <button type="button" className="composer__add-agent" onClick={() => useRelay.getState().openDialog({ kind: 'add-agent', sessionId: anchor.id })} disabled={connection !== 'online'}>
              <UserPlus size={13} aria-hidden="true" /><span>Add agent</span>
            </button>
          </div>
          <div className="composer__send">
            {anyBusy && !local ? (
              <button type="button" className="sendbtn sendbtn--stop" onClick={() => void stop()} disabled={stopping || connection !== 'online'} aria-label="Pause group and interrupt running members" title="Pause group and interrupt running members"><Square size={12} fill="currentColor" /></button>
            ) : null}
            <button type="button" className="sendbtn" onClick={() => void submit()} disabled={sendDisabled}
              aria-label={local?.[1]?.toLowerCase() === 'import' ? 'Import conversation' : local?.[1]?.toLowerCase() === 'usage' ? 'Open usage' : 'Send message'}
              title={sendDisabled ? (problem ?? blocker ?? (empty ? 'Write a message first' : 'Sending…')) : anyBusy ? `Send and queue for busy agents (${MOD}+Enter or Enter)` : `Send (${MOD}+Enter or Enter)`}>
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
      </div>
      <Popover anchor={pickerButton} open={pickerOpen} onClose={() => setPickerOpen(false)} label="Choose recipients" width={300} align="start" className="recips-pop">
        <fieldset className="recips-pop__list">
          <legend>Send to these agents</legend>
          {members.map((member) => {
            const session = sessionOf(member.sessionId);
            return (
              <label key={member.id} className="check">
                <input type="checkbox" checked={pickedActive.includes(member.id)} onChange={() => togglePick(member.id)} data-autofocus={member === members[0] ? '' : undefined} />
                <span><AgentIdentity handle={member.handle} identityKey={member.sessionId} provider={session?.provider} /><small>{ROLE_LABEL[member.role]}{session ? ` · ${providerName(session.provider)} · ${session.status}` : ''}</small></span>
              </label>
            );
          })}
        </fieldset>
        <div className="recips-pop__foot">
          <small>{stalePicked.length ? `${stalePicked.length} unavailable recipient${stalePicked.length === 1 ? '' : 's'} — clear before sending` : pickedActive.length ? `${pickedActive.length} selected` : `Nothing selected: ${defaultLabel}`}</small>
          <button type="button" className="link-btn" disabled={!picked.length} onClick={() => setPicked([])}>Clear selection</button>
        </div>
      </Popover>
      {footer}
      {note || snapshot.group.paused ? (
        <p className={cx('composer__note', noteIsError && 'is-error')} role={noteIsError ? 'alert' : 'status'}>
          {note ?? `Group is paused${snapshot.group.pauseReason ? `: ${snapshot.group.pauseReason}` : ''}. Resume it from the bar above to start queued work.`}
          {!noteIsError && blocker && unavailable ? <> <button type="button" className="link-btn" onClick={() => useRelay.getState().openDialog({ kind: 'settings' })}>Open Settings</button></> : null}
        </p>
      ) : null}
      {usageSession ? <UsagePanel key={usageSession.id} session={usageSession} onClose={() => { setUsageSession(null); window.requestAnimationFrame(() => ref.current?.focus()); }} /> : null}
    </div>
  );
}

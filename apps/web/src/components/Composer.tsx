import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import type { ProviderModel, Session } from '@relay/contracts';
import { useRelay } from '../store/store';
import { api, errorMessage, type ProviderCatalog, type SessionPatch } from '../lib/api';
import { MOD, PROVIDER_NAME } from './ui';
import { cx } from '../lib/format';
import { SelectMenu } from './SelectMenu';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasSkillMarker = (text: string, name: string) => new RegExp(`(?:^|\\s)\\$${escapeRegExp(name)}(?=\\s|$)`).test(text);
const removeSkillMarker = (text: string, name: string) => text.replace(new RegExp(`(^|\\s)\\$${escapeRegExp(name)}(?=\\s|$)`, 'g'), '$1').replace(/[ \t]{2,}/g, ' ');
const localCommandNames = ['new', 'stop', 'settings', 'model', 'effort', 'permissions', 'tier', 'skills', 'status', 'diff', 'help'];
const reservedCommands = new Set(localCommandNames);

export function Composer({ session }: { session: Session }) {
  const draft = useRelay((s) => s.drafts[session.id] ?? '');
  const connection = useRelay((s) => s.connection);
  const provider = useRelay((s) => s.boot?.providers.find((p) => p.id === session.provider));
  const providers = useRelay((s) => s.boot?.providers);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ kind: 'command' | 'skill'; start: number; query: string } | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const [caretPosition, setCaretPosition] = useState(0);
  const dismissedSuggestion = useRef<string | null>(null);
  const caret = useRef(0);
  const pickerId = useId();
  const [modelOpenRequest, setModelOpenRequest] = useState(0);
  const [policyOpenRequest, setPolicyOpenRequest] = useState(0);
  const [reasoningOpenRequest, setReasoningOpenRequest] = useState(0);
  const modelControl = useRef<HTMLButtonElement>(null);
  const reasoningControl = useRef<HTMLButtonElement>(null);
  const policyControl = useRef<HTMLButtonElement>(null);

  const catalogKey = `${session.id}:${session.provider}:${session.model}:${session.providerSessionId ?? ''}`;
  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null); setCatalogError(null);
    setSuggestion(null); setSelectedSkills([]); dismissedSuggestion.current = null;
    void api.sessionCatalog(session.id, controller.signal).then(setCatalog).catch((cause) => {
      if (!controller.signal.aborted) setCatalogError(errorMessage(cause));
    });
    return () => controller.abort();
  }, [catalogKey, connection]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft, session.id]);
  useEffect(() => { setError(null); }, [session.id]);

  const running = session.status === 'running' || session.status === 'waiting';
  const blocker =
    connection !== 'online' ? 'Disconnected from the Relay server — reconnect to send.'
      : running ? (session.status === 'waiting' ? 'Waiting for your approval above before the run can continue.' : 'This session is running. Wait for it to finish or interrupt it.')
        : provider && !provider.available ? `${PROVIDER_NAME[session.provider]} needs setup before you can send a message.`
          : null;
  const empty = draft.trim().length === 0;

  const submit = async () => {
    const local = /^\/(new|stop|settings|model|effort|permissions|tier|skills|status|diff|help)(?:\s.*)?$/i.exec(draft.trim());
    if ((blocker && !local) || empty || sending || updating) return;
    setSending(true);
    setError(null);
    let focusComposerAfter = true;
    try {
      if (local) {
        const action = local[1]!.toLowerCase();
        if (action === 'new') await useRelay.getState().createSession();
        if (action === 'stop') await api.interrupt(session.id);
        if (action === 'settings') useRelay.getState().openSettings();
        if (action === 'model') { focusComposerAfter = false; setModelOpenRequest((value) => value + 1); }
        if (action === 'effort' || action === 'tier') { focusComposerAfter = false; setReasoningOpenRequest((value) => value + 1); }
        if (action === 'permissions') { focusComposerAfter = false; setPolicyOpenRequest((value) => value + 1); }
        if (action === 'skills') {
          caret.current = 1; setCaretPosition(1);
          useRelay.getState().setDraft(session.id, '$');
        }
        if (action === 'diff') useRelay.getState().setContextTab('changes');
        if (action === 'status') {
          const currentTier = session.serviceTier ?? 'standard';
          const tier = currentTier === 'standard' ? 'Standard' : currentTier === 'priority' ? 'Fast' : currentTier;
          useRelay.getState().toast('info', `${PROVIDER_NAME[session.provider]} · ${session.model} · ${effortLabel(session.effort)} · ${tier}`);
        }
        if (action === 'help') {
          const providerCommands = Array.from(new Set((catalog?.commands ?? []).filter((item) => !reservedCommands.has(item.name.toLowerCase())).map((item) => `/${item.name}`)));
          const preview = providerCommands.slice(0, 5).join(', ');
          const remainder = providerCommands.length > 5 ? `, … ${providerCommands.length - 5} more` : '';
          useRelay.getState().toast('info', `Relay commands: /new, /stop, /settings, /model, /effort, /permissions, /tier, /skills, /status, /diff, /help${preview ? `. Other commands: ${preview}${remainder}. Type / to browse all.` : '.'}`);
        }
        if (action !== 'skills') useRelay.getState().setDraft(session.id, '');
        setSelectedSkills([]);
        await useRelay.getState().refreshNow();
        return;
      }
      const mentionedSkills = (catalog?.skills ?? []).filter((item) => item.enabled && hasSkillMarker(draft, item.name));
      const messageSkills: string[] = [];
      for (const skill of mentionedSkills) {
        const sameName = mentionedSkills.filter((item) => item.name === skill.name);
        const explicitlySelected = sameName.filter((item) => selectedSkills.includes(item.id));
        const candidates = explicitlySelected.length ? explicitlySelected : sameName;
        if (!explicitlySelected.length && candidates.length > 1) {
          throw new Error(`“$${skill.name}” matches multiple skills. Choose the intended skill from the picker.`);
        }
        for (const candidate of candidates) if (!messageSkills.includes(candidate.id)) messageSkills.push(candidate.id);
      }
      if (session.provider === 'claude' && messageSkills.length > 1) {
        throw new Error('Claude accepts one selected skill per message. Remove the extra skill reference.');
      }
      await api.sendMessage(session.id, draft.trim(), messageSkills);
      useRelay.getState().setDraft(session.id, '');
      setSelectedSkills([]);
      await useRelay.getState().refreshNow();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
      if (focusComposerAfter) ref.current?.focus();
    }
  };

  const stop = async () => {
    try {
      await api.interrupt(session.id);
      void useRelay.getState().refreshNow();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const configure = async (patch: SessionPatch) => {
    if (running || sending || updating || connection !== 'online') return;
    setUpdating(true);
    setError(null);
    try {
      const updated = await api.updateSession(session.id, patch);
      await useRelay.getState().refreshNow();
      useRelay.setState((s) => ({
        boot: s.boot ? { ...s.boot, sessions: s.boot.sessions.map((item) => item.id === updated.id && item.updatedAt <= updated.updatedAt ? updated : item) } : s.boot,
      }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUpdating(false);
    }
  };
  const disabled = running || sending || updating || connection !== 'online';
  const modelGroups = (providers ?? []).filter((p) => !session.providerSessionId || p.id === session.provider);
  const currentProvider = providers?.find((p) => p.id === session.provider);
  const modelData = (currentProvider?.models ?? []) as ProviderModel[];
  const currentModel = modelData.find((m) => m.id === session.model || m.aliases?.includes(session.model));
  const selectedModelId = currentModel?.id ?? session.model;
  const effortChoices = currentModel?.reasoningEfforts ?? (currentModel ? [
    { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
  ] : []);
  const tierChoices = [
    { id: 'standard', name: 'Standard', description: 'Standard service tier.' },
    ...(currentModel?.serviceTiers ?? []).filter((item) => item.id !== 'standard'),
  ];
  const effortLabel = (id: string) => {
    const known: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', 'extra-high': 'Extra High', max: 'Max', ultra: 'Ultra' };
    return known[id.toLowerCase()] ?? effortChoices.find((item) => item.id === id)?.label ?? id[0]?.toUpperCase() + id.slice(1);
  };
  const effortDefault = currentModel?.defaultReasoningEffort;
  const tierDefault = currentModel?.defaultServiceTier ?? 'standard';
  const tierName = (id: string, name: string) => id === 'standard' ? 'Standard' : id === 'priority' ? 'Fast' : name;
  const combinedOptions = [
    ...effortChoices.map((item) => ({
      value: `effort:${item.id}`,
      label: effortLabel(item.id),
      badge: item.id === effortDefault ? 'Default' : undefined,
      group: 'Reasoning effort',
    })),
    ...tierChoices.map((item) => ({
      value: `tier:${item.id}`,
      label: tierName(item.id, item.name),
      badge: item.id === tierDefault ? 'Default' : undefined,
      description: item.id !== 'standard' ? item.description : undefined,
      group: 'Service tier',
    })),
  ];
  const currentTier = session.serviceTier ?? 'standard';
  const hasCurrentEffort = effortChoices.some((item) => item.id === session.effort);
  const combinedValue = hasCurrentEffort
    ? `effort:${session.effort}` : `tier:${currentTier}`;
  const combinedSelectedValues = [
    ...(hasCurrentEffort ? [`effort:${session.effort}`] : []),
    `tier:${currentTier}`,
  ];
  const selectedTier = tierChoices.find((item) => item.id === currentTier);
  const combinedDisplay = hasCurrentEffort
    ? `${effortLabel(session.effort)}${currentTier === 'standard' ? '' : ` · ${selectedTier ? tierName(selectedTier.id, selectedTier.name) : currentTier}`}`
    : selectedTier ? tierName(selectedTier.id, selectedTier.name) : currentTier;
  const policyChoices = currentModel?.policies ?? currentProvider?.policies ?? [];
  const policyLabels: Record<string, [string, string]> = {
    supervised: ['Supervised', 'Ask before taking actions that change files or run commands.'],
    balanced: ['Auto-accept edits', 'Allow file edits while keeping command approvals.'],
    auto: ['Auto', 'Allow common actions automatically with safety checks.'],
    'full-access': ['Full access', 'Allow all actions without approval prompts.'],
  };
  const caretIndex = Math.min(caretPosition, draft.length);
  const beforeCaret = draft.slice(0, caretIndex);
  const match = beforeCaret.match(/(?:^|\s)(\/[^\s]*|\$[^\s]*)$/);
  const trigger = match?.[1] ?? '';
  const triggerStart = match ? caretIndex - trigger.length : 0;
  const suggestions = trigger.startsWith('/')
    ? [
      ...[
        { name: 'new', description: 'Create a new session', kind: 'local' as const, group: 'Relay' },
        { name: 'stop', description: 'Interrupt the current run', kind: 'local' as const, group: 'Relay' },
        { name: 'settings', description: 'Open Settings', kind: 'local' as const, group: 'Relay' },
        { name: 'model', description: 'Focus model selection', kind: 'local' as const, group: 'Relay' },
        { name: 'effort', description: 'Focus effort selection', kind: 'local' as const, group: 'Relay' },
        { name: 'permissions', description: 'Focus approval policy', kind: 'local' as const, group: 'Relay' },
        { name: 'tier', description: 'Focus service tier', kind: 'local' as const, group: 'Relay' },
        { name: 'skills', description: 'Choose skills for the next message', kind: 'local' as const, group: 'Relay' },
        { name: 'status', description: 'Show current provider and settings', kind: 'local' as const, group: 'Relay' },
        { name: 'diff', description: 'Open the Changes pane', kind: 'local' as const, group: 'Relay' },
        { name: 'help', description: 'List Relay commands', kind: 'local' as const, group: 'Relay' },
      ].filter((item) => item.name.startsWith(trigger.slice(1).toLowerCase())),
      ...(catalog?.commands ?? []).filter((item) => !reservedCommands.has(item.name.toLowerCase()) && item.name.toLowerCase().startsWith(trigger.slice(1).toLowerCase())).map((item) => ({ id: item.id, name: item.name, description: item.description, group: item.source[0]!.toUpperCase() + item.source.slice(1), kind: 'provider' as const, argumentHint: item.argumentHint })),
    ].map((item) => ({ ...item, key: `${item.kind}:${'id' in item ? item.id : item.name}`, token: `/${item.name}` }))
    : trigger.startsWith('$') && catalog
      ? catalog.skills.filter((item) => item.enabled && item.name.toLowerCase().startsWith(trigger.slice(1).toLowerCase())).map((item) => ({ name: item.name, description: item.description, group: item.source[0]!.toUpperCase() + item.source.slice(1), kind: 'skill' as const, token: `$${item.name}`, id: item.id, key: `skill:${item.id}` }))
      : [];
  useEffect(() => {
    if (trigger !== dismissedSuggestion.current) dismissedSuggestion.current = null;
    if (focused && suggestions.length && trigger && trigger !== dismissedSuggestion.current) {
      const kind = trigger.startsWith('/') ? 'command' : 'skill';
      if (suggestion?.start !== triggerStart || suggestion.kind !== kind || suggestion.query !== trigger) {
        setActiveSuggestion(0);
        setSuggestion({ kind, start: triggerStart, query: trigger });
      }
    } else setSuggestion(null);
  }, [draft, catalog, trigger, triggerStart, suggestions.length, suggestion, focused, caretPosition]);
  const chooseSuggestion = (index: number) => {
    const item = suggestions[index];
    if (!item) return;
    let prefix = draft.slice(0, triggerStart);
    let suffix = draft.slice(caretIndex);
    if (item.kind === 'skill' && session.provider === 'claude') {
      for (const id of selectedSkills) {
        const prior = catalog?.skills.find((skill) => skill.id === id);
        if (prior) { prefix = removeSkillMarker(prefix, prior.name); suffix = removeSkillMarker(suffix, prior.name); }
      }
    }
    const text = `${prefix}${item.token} ${suffix}`;
    const nextCaret = prefix.length + item.token.length + 1;
    useRelay.getState().setDraft(session.id, text);
    caret.current = nextCaret;
    setCaretPosition(nextCaret);
    setSuggestion(null);
    dismissedSuggestion.current = null;
    if (item.kind === 'skill' && 'id' in item) setSelectedSkills((current) => {
      const next = session.provider === 'claude' ? [item.id] : current.includes(item.id) ? current : [...current, item.id];
      if (session.provider === 'claude' && current.length && !current.includes(item.id)) useRelay.getState().toast('info', 'Claude supports one selected skill per message; the latest choice replaced the previous one.');
      return next;
    });
    requestAnimationFrame(() => { const input = ref.current; input?.focus(); input?.setSelectionRange(nextCaret, nextCaret); });
  };
  useEffect(() => {
    document.getElementById(`${pickerId}-option-${activeSuggestion}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeSuggestion, pickerId, suggestion]);
  const modelOptions = modelGroups.flatMap((p) => {
    return p.models.map((m) => ({ value: JSON.stringify([p.id, m.id]), label: m.name, group: p.name }));
  });

  return (
    <div className="composer-wrap">
      <div className={cx('composer', blocker && 'is-blocked')}>
        <label htmlFor={`composer-${session.id}`} className="sr-only">Message {session.name}</label>
        <textarea
          id={`composer-${session.id}`} ref={ref} className="composer__input" rows={1} value={draft}
          role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={Boolean(suggestion && suggestions.length)}
          aria-controls={suggestion && suggestions.length ? pickerId : undefined}
          aria-activedescendant={suggestion && suggestions.length ? `${pickerId}-option-${activeSuggestion}` : undefined}
          placeholder="Ask anything, or describe a task…"
          onChange={(e) => {
            const nextDraft = e.target.value;
            caret.current = e.target.selectionStart ?? nextDraft.length;
            setCaretPosition(caret.current);
            useRelay.getState().setDraft(session.id, nextDraft);
            setSelectedSkills((current) => current.filter((id) => {
              const skill = catalog?.skills.find((item) => item.id === id);
              return Boolean(skill && hasSkillMarker(nextDraft, skill.name));
            }));
          }}
          onFocus={(e) => { setFocused(true); caret.current = e.currentTarget.selectionStart ?? 0; setCaretPosition(caret.current); }}
          onSelect={(e) => { caret.current = e.currentTarget.selectionStart ?? 0; setCaretPosition(caret.current); }}
          onBlur={() => { setFocused(false); setSuggestion(null); }}
          onKeyDown={(e) => {
            if (suggestion && suggestions.length && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActiveSuggestion((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return; }
              if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); chooseSuggestion(activeSuggestion); return; }
              if (e.key === 'Escape') { e.preventDefault(); dismissedSuggestion.current = trigger; setSuggestion(null); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
          }}
        />
        {suggestion && suggestions.length ? <div className="composer-picker" id={pickerId} role="listbox" aria-label={suggestion.kind === 'skill' ? 'Skills' : 'Commands'}>
          {suggestions.map((item, index) => <div key={item.key}>
            {index === 0 || suggestions[index - 1]?.group !== item.group ? <div className="composer-picker__group" role="presentation">{item.group}</div> : null}
            <div role="option" id={`${pickerId}-option-${index}`} aria-selected={index === activeSuggestion} className={cx('composer-picker__item', index === activeSuggestion && 'is-active')} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActiveSuggestion(index)} onClick={() => chooseSuggestion(index)}>
              <span className="composer-picker__name">{item.token}{item.kind === 'provider' && item.argumentHint ? <small> {item.argumentHint}</small> : null}</span><span className="composer-picker__description">{item.description}</span>
            </div>
          </div>)}
        </div> : null}
        {focused && trigger.startsWith('$') && !suggestions.length && !catalogError ? <div className="composer-picker-empty" role="status">{!catalog ? 'Loading skills…' : catalog.skills.some((item) => item.enabled) ? 'No matching skills.' : 'No skills are available for this provider and session.'}</div> : null}
        <div className="composer__bar">
          <div className="composer__controls" aria-busy={updating}>
            <SelectMenu triggerRef={modelControl} openRequest={modelOpenRequest} className="composer__select composer__select--model" label="Model"
              value={JSON.stringify([session.provider, selectedModelId])} disabled={disabled || modelOptions.length === 0}
              options={modelOptions} placement="top"
              onChange={(value) => {
                const [provider, model] = JSON.parse(value) as [Session['provider'], string];
                void configure({ provider, model });
              }} />
            <SelectMenu triggerRef={reasoningControl} className="composer__select" label="Reasoning effort and service tier" value={combinedValue} selectedValues={combinedSelectedValues} displayValue={combinedDisplay} openRequest={reasoningOpenRequest} disabled={disabled}
              options={combinedOptions}
              onChange={(value) => { const [kind, option] = value.split(':'); if (kind === 'effort') void configure({ effort: option }); else if (kind === 'tier') void configure({ serviceTier: option }); }} placement="top" />
            <SelectMenu triggerRef={policyControl} openRequest={policyOpenRequest} className="composer__select composer__select--policy" label="Approval policy" value={session.policy} disabled={disabled || policyChoices.length === 0}
              options={policyChoices.map((value) => ({ value, label: policyLabels[value]?.[0] ?? value, description: policyLabels[value]?.[1] }))}
              onChange={(value) => void configure({ policy: value as Session['policy'] })} placement="top" />
          </div>
          <div className="composer__send">
            {running ? (
              <button type="button" className="sendbtn sendbtn--stop" onClick={stop} aria-label="Interrupt run" title="Interrupt run"><Square size={12} fill="currentColor" /></button>
            ) : (
              <button type="button" className="sendbtn" onClick={() => void submit()} disabled={Boolean(blocker) || empty || sending || updating} aria-label="Send message" title={blocker ?? (empty ? 'Write a message first' : `Send (${MOD}+Enter or Enter)`)}>
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      {blocker || error ? (
        <p className={cx('composer__note', error && 'is-error')} role={error ? 'alert' : 'status'}>{error ?? blocker}{!error && provider && !provider.available ? <> <button type="button" className="link-btn" onClick={() => useRelay.getState().openDialog({ kind: 'settings' })}>Open Settings</button></> : null}</p>
      ) : null}
      {catalogError && (trigger.startsWith('/') || trigger.startsWith('$')) ? <p className="composer__note" role="status">Command and skill suggestions unavailable: {catalogError}</p> : null}
      {catalog?.warnings.length && (suggestion || trigger.startsWith('/') || trigger.startsWith('$')) ? <details className="composer__catalog-note"><summary>{catalog.warnings.length} command or skill source{catalog.warnings.length === 1 ? '' : 's'} unavailable</summary><ul>{catalog.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul></details> : null}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import type { ProviderModel, Session } from '@relay/contracts';
import { useRelay } from '../store/store';
import { api, errorMessage, type ProviderCatalog, type SessionPatch } from '../lib/api';
import { MOD, PROVIDER_NAME } from './ui';
import { cx } from '../lib/format';
import { SelectMenu } from './SelectMenu';

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
  const dismissedSuggestion = useRef<string | null>(null);
  const modelControl = useRef<HTMLButtonElement>(null);
  const effortControl = useRef<HTMLButtonElement>(null);
  const policyControl = useRef<HTMLButtonElement>(null);
  const tierControl = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null); setCatalogError(null);
    void api.sessionCatalog(session.id, controller.signal).then(setCatalog).catch((cause) => {
      if (!controller.signal.aborted) setCatalogError(errorMessage(cause));
    });
    return () => controller.abort();
  }, [session.id]);

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
    const local = /^\/(new|stop|settings|model|effort|permissions|tier|help)(?:\s.*)?$/i.exec(draft.trim());
    if ((blocker && !local) || empty || sending || updating) return;
    setSending(true);
    setError(null);
    try {
      if (local) {
        const action = local[1]!.toLowerCase();
        if (action === 'new') await useRelay.getState().createSession();
        if (action === 'stop') await api.interrupt(session.id);
        if (action === 'settings') useRelay.getState().openSettings();
        if (action === 'model') modelControl.current?.focus();
        if (action === 'effort') effortControl.current?.focus();
        if (action === 'permissions') policyControl.current?.focus();
        if (action === 'tier') tierControl.current?.focus();
        if (action === 'help') {
          const providerCommands = catalog?.commands.map((item) => `/${item.name}`).join(', ');
          useRelay.getState().toast('info', `Commands: /new, /stop, /settings, /model, /effort, /permissions, /tier, /help${providerCommands ? `; provider: ${providerCommands}` : ''}.`);
        }
        useRelay.getState().setDraft(session.id, '');
        setSelectedSkills([]);
        await useRelay.getState().refreshNow();
        return;
      }
      await api.sendMessage(session.id, draft.trim(), selectedSkills);
      useRelay.getState().setDraft(session.id, '');
      setSelectedSkills([]);
      await useRelay.getState().refreshNow();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
      ref.current?.focus();
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
  const tierChoices = currentModel?.serviceTiers ?? [];
  const policyChoices = currentModel?.policies ?? currentProvider?.policies ?? [];
  const policyLabels: Record<string, [string, string]> = {
    supervised: ['Supervised', 'Ask before taking actions that change files or run commands.'],
    balanced: ['Auto-accept edits', 'Allow file edits while keeping command approvals.'],
    auto: ['Auto', 'Allow common actions automatically with safety checks.'],
    'full-access': ['Full access', 'Allow all actions without approval prompts.'],
  };
  const match = draft.match(/(?:^|\s)(\/[^\s]*|\$[^\s]*)$/);
  const trigger = match?.[1] ?? '';
  const triggerStart = match ? draft.length - trigger.length : 0;
  const suggestions = trigger.startsWith('/')
    ? [
      ...[
        { name: 'new', description: 'Create a new session', kind: 'local' as const },
        { name: 'stop', description: 'Interrupt the current run', kind: 'local' as const },
        { name: 'settings', description: 'Open Settings', kind: 'local' as const },
        { name: 'model', description: 'Focus model selection', kind: 'local' as const },
        { name: 'effort', description: 'Focus effort selection', kind: 'local' as const },
        { name: 'permissions', description: 'Focus approval policy', kind: 'local' as const },
        { name: 'tier', description: 'Focus service tier', kind: 'local' as const },
        { name: 'help', description: 'List Relay commands', kind: 'local' as const },
      ].filter((item) => item.name.startsWith(trigger.slice(1).toLowerCase())),
      ...(catalog?.commands ?? []).filter((item) => item.name.toLowerCase().startsWith(trigger.slice(1).toLowerCase())).map((item) => ({ name: item.name, description: item.description, kind: 'provider' as const, argumentHint: item.argumentHint })),
    ].map((item) => ({ ...item, token: `/${item.name}` }))
    : trigger.startsWith('$') && catalog
      ? catalog.skills.filter((item) => item.enabled && item.name.toLowerCase().startsWith(trigger.slice(1).toLowerCase())).map((item) => ({ name: item.name, description: item.description, kind: 'skill' as const, token: `$${item.name}`, id: item.id }))
      : [];
  useEffect(() => {
    if (trigger !== dismissedSuggestion.current) dismissedSuggestion.current = null;
    if (suggestions.length && trigger && trigger !== dismissedSuggestion.current) {
      const kind = trigger.startsWith('/') ? 'command' : 'skill';
      if (suggestion?.start !== triggerStart || suggestion.kind !== kind || suggestion.query !== trigger) {
        setActiveSuggestion(0);
        setSuggestion({ kind, start: triggerStart, query: trigger });
      }
    } else setSuggestion(null);
  }, [draft, catalog, trigger, triggerStart, suggestions.length, suggestion]);
  const chooseSuggestion = (index: number) => {
    const item = suggestions[index];
    if (!item) return;
    const text = draft.slice(0, triggerStart) + item.token + (item.kind === 'provider' && item.argumentHint ? ` ${item.argumentHint}` : ' ');
    useRelay.getState().setDraft(session.id, text);
    setSuggestion(null);
    dismissedSuggestion.current = null;
    if (item.kind === 'skill' && 'id' in item) setSelectedSkills((current) => {
      const next = session.provider === 'claude' ? [item.id] : current.includes(item.id) ? current : [...current, item.id];
      if (session.provider === 'claude' && current.length && !current.includes(item.id)) useRelay.getState().toast('info', 'Claude supports one selected skill per message; the latest choice replaced the previous one.');
      return next;
    });
    requestAnimationFrame(() => { const input = ref.current; input?.focus(); input?.setSelectionRange(text.length, text.length); });
  };
  const modelOptions = modelGroups.flatMap((p) => {
    return p.models.map((m) => ({ value: JSON.stringify([p.id, m.id]), label: m.name, group: p.name }));
  });

  return (
    <div className="composer-wrap">
      <div className={cx('composer', blocker && 'is-blocked')}>
        <label htmlFor={`composer-${session.id}`} className="sr-only">Message {session.name}</label>
        <textarea
          id={`composer-${session.id}`} ref={ref} className="composer__input" rows={1} value={draft}
          placeholder="Ask anything, or describe a task…"
          onChange={(e) => useRelay.getState().setDraft(session.id, e.target.value)}
          onKeyDown={(e) => {
            if (suggestion && suggestions.length && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActiveSuggestion((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return; }
              if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); chooseSuggestion(activeSuggestion); return; }
              if (e.key === 'Escape') { e.preventDefault(); dismissedSuggestion.current = trigger; setSuggestion(null); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
          }}
        />
        {suggestion && suggestions.length ? <div className="composer-picker" role="listbox" aria-label={suggestion.kind === 'skill' ? 'Skills' : 'Commands'}>
          {suggestions.slice(0, 10).map((item, index) => <button type="button" role="option" aria-selected={index === activeSuggestion} key={`${item.kind}:${item.token}`} className={cx('composer-picker__item', index === activeSuggestion && 'is-active')} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSuggestion(index)}>
            <span className="composer-picker__name">{item.token}{item.kind === 'provider' && item.argumentHint ? <small> {item.argumentHint}</small> : null}</span><span className="composer-picker__description">{item.description}</span>
          </button>)}
        </div> : null}
        <div className="composer__bar">
          <div className="composer__controls" aria-busy={updating}>
            <SelectMenu triggerRef={modelControl} className="composer__select composer__select--model" label="Model"
              value={JSON.stringify([session.provider, selectedModelId])} disabled={disabled || modelOptions.length === 0}
              options={modelOptions} placement="top"
              onChange={(value) => {
                const [provider, model] = JSON.parse(value) as [Session['provider'], string];
                void configure({ provider, model });
              }} />
            {effortChoices.length ? <SelectMenu triggerRef={effortControl} className="composer__select" label="Effort" value={session.effort} disabled={disabled}
              options={effortChoices.map((item) => ({ value: item.id, label: item.label, description: item.description }))}
              onChange={(value) => void configure({ effort: value as Session['effort'] })} placement="top" /> : null}
            <SelectMenu triggerRef={policyControl} className="composer__select composer__select--policy" label="Approval policy" value={session.policy} disabled={disabled || policyChoices.length === 0}
              options={policyChoices.map((value) => ({ value, label: policyLabels[value]?.[0] ?? value, description: policyLabels[value]?.[1] }))}
              onChange={(value) => void configure({ policy: value as Session['policy'] })} placement="top" />
            {currentModel?.serviceTiers?.length ? <SelectMenu triggerRef={tierControl} className="composer__select" label="Service tier" value={session.serviceTier ?? 'standard'} disabled={disabled}
              options={tierChoices.map((item) => ({ value: item.id, label: item.name, description: item.description }))}
              onChange={(value) => void configure({ serviceTier: value })} placement="top" /> : null}
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
      {catalogError ? <p className="composer__note" role="status">Command and skill suggestions unavailable: {catalogError}</p> : catalog?.warnings.map((warning, index) => <p className="composer__note" role="status" key={`${index}:${warning}`}>{warning}</p>)}
    </div>
  );
}

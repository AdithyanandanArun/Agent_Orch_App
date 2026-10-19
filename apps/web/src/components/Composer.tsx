import { useEffect, useRef, useState } from 'react';
import { ArrowUp, MoreHorizontal, Square } from 'lucide-react';
import type { Session } from '@relay/contracts';
import { useRelay } from '../store/store';
import { api, errorMessage, type SessionPatch } from '../lib/api';
import { MOD, PROVIDER_NAME } from './ui';
import { cx } from '../lib/format';

export function Composer({ session }: { session: Session }) {
  const draft = useRelay((s) => s.drafts[session.id] ?? '');
  const connection = useRelay((s) => s.connection);
  const provider = useRelay((s) => s.boot?.providers.find((p) => p.id === session.provider));
  const providers = useRelay((s) => s.boot?.providers);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (blocker || empty || sending || updating) return;
    setSending(true);
    setError(null);
    try {
      await api.sendMessage(session.id, draft.trim());
      useRelay.getState().setDraft(session.id, '');
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
  const controlsTitle = running ? 'Available after the current run finishes' : 'Applies to the next message';

  return (
    <div className="composer-wrap">
      <div className={cx('composer', blocker && 'is-blocked')}>
        <label htmlFor={`composer-${session.id}`} className="sr-only">Message {session.name}</label>
        <textarea
          id={`composer-${session.id}`} ref={ref} className="composer__input" rows={1} value={draft}
          placeholder="Ask anything, or describe a task…"
          onChange={(e) => useRelay.getState().setDraft(session.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
          }}
        />
        <div className="composer__bar">
          <div className="composer__controls" aria-busy={updating}>
            <select className="select composer__select composer__select--model" aria-label="Session model" title={controlsTitle}
              value={JSON.stringify([session.provider, session.model])} disabled={disabled}
              onChange={(e) => {
                const [provider, model] = JSON.parse(e.target.value) as [Session['provider'], string];
                void configure({ provider, model });
              }}>
              {modelGroups.map((p) => {
                const models = p.id === session.provider && !p.models.some((m) => m.id === session.model)
                  ? [{ id: session.model, name: session.model }, ...p.models] : p.models;
                return <optgroup key={p.id} label={p.name}>{models.map((m) => <option key={m.id} value={JSON.stringify([p.id, m.id])}>{m.name}</option>)}</optgroup>;
              })}
              {!modelGroups.some((p) => p.id === session.provider) ? <option value={JSON.stringify([session.provider, session.model])}>{session.model}</option> : null}
            </select>
            <select className="select composer__select" aria-label="Reasoning effort" title={controlsTitle} value={session.effort} disabled={disabled}
              onChange={(e) => void configure({ effort: e.target.value as Session['effort'] })}>
              <option value="low">Low effort</option><option value="medium">Medium effort</option><option value="high">High effort</option>
            </select>
            <details className="composer__details">
              <summary aria-label="Session options" title="Session options"><MoreHorizontal size={15} /></summary>
              <div className="composer__options">
                <label htmlFor={`policy-${session.id}`}>Approval policy</label>
                <select id={`policy-${session.id}`} className="select" value={session.policy} disabled={disabled}
                  onChange={(e) => void configure({ policy: e.target.value as Session['policy'] })}>
                  <option value="supervised">Supervised</option><option value="balanced">Balanced</option>
                </select>
              </div>
            </details>
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
    </div>
  );
}

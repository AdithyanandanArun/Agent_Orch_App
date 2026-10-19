import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Cpu, Gauge, ShieldCheck, Square } from 'lucide-react';
import type { Session } from '@relay/contracts';
import { useRelay } from '../store/store';
import { api, errorMessage } from '../lib/api';
import { MOD, Kbd, PROVIDER_NAME } from './ui';
import { cx } from '../lib/format';

export function Composer({ session }: { session: Session }) {
  const draft = useRelay((s) => s.drafts[session.id] ?? '');
  const connection = useRelay((s) => s.connection);
  const provider = useRelay((s) => s.boot?.providers.find((p) => p.id === session.provider));
  const ref = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft, session.id]);
  useEffect(() => setError(null), [session.id]);

  const running = session.status === 'running' || session.status === 'waiting';
  const blocker =
    connection !== 'online' ? 'Disconnected from the Relay server — reconnect to send.'
      : running ? (session.status === 'waiting' ? 'Waiting for your approval above before the run can continue.' : 'This session is running. Wait for it to finish or interrupt it.')
        : provider && !provider.available ? `${PROVIDER_NAME[session.provider]} needs setup before you can send a message.`
          : null;
  const empty = draft.trim().length === 0;

  const submit = async () => {
    if (blocker || empty || sending) return;
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

  return (
    <div className="composer-wrap">
      <div className={cx('composer', blocker && 'is-blocked')}>
        <label htmlFor={`composer-${session.id}`} className="sr-only">Message {session.name}</label>
        <textarea
          id={`composer-${session.id}`} ref={ref} className="composer__input" rows={1} value={draft}
          placeholder={`Message ${session.name}…`}
          onChange={(e) => useRelay.getState().setDraft(session.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
          }}
        />
        <div className="composer__bar">
          <div className="composer__meta">
            <span className="meta-chip" title="Provider and model are fixed when a session is created"><Cpu size={12} aria-hidden="true" />{PROVIDER_NAME[session.provider]} · {session.model}</span>
            <span className="meta-chip" title="Reasoning effort, set at session creation"><Gauge size={12} aria-hidden="true" />{session.effort}</span>
            <span className="meta-chip" title={session.policy === 'supervised' ? 'Supervised policy: tool use goes through approval requests' : 'Balanced policy'}><ShieldCheck size={12} aria-hidden="true" />{session.policy}</span>
          </div>
          <div className="composer__send">
            <span className="composer__hint"><Kbd>↵</Kbd> send · <Kbd>⇧</Kbd><Kbd>↵</Kbd> newline</span>
            {running ? (
              <button type="button" className="sendbtn sendbtn--stop" onClick={stop} aria-label="Interrupt run" title="Interrupt run"><Square size={12} fill="currentColor" /></button>
            ) : (
              <button type="button" className="sendbtn" onClick={() => void submit()} disabled={Boolean(blocker) || empty || sending} aria-label="Send message" title={blocker ?? (empty ? 'Write a message first' : `Send (${MOD}+Enter or Enter)`)}>
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

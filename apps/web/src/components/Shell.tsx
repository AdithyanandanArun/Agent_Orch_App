import { AlertTriangle, CheckCircle2, Info, RefreshCw, WifiOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMingle, type Toast } from '../store/store';
import { cx } from '../lib/format';
import { usePresence, usePresenceList } from '../lib/motion';
import { Button, MingleGlyph, Spinner } from './ui';

export function ConnectionBanner() {
  const connection = useMingle((s) => s.connection);
  const attempt = useMingle((s) => s.attempt);
  const nextRetryAt = useMingle((s) => s.nextRetryAt);
  const staleError = useMingle((s) => s.staleError);
  const [now, setNow] = useState(Date.now());
  const visible = !(connection === 'online' && !staleError) && !(connection === 'connecting' && !staleError && attempt === 0);
  const { present, closing } = usePresence(visible);
  const lastBanner = useRef<{ staleError: string | null; connection: string; attempt: number; secs: number } | null>(null);
  useEffect(() => {
    if (connection !== 'offline') return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [connection]);

  const secs = nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : 0;
  if (visible) lastBanner.current = { staleError, connection, attempt, secs };
  if (!present || !lastBanner.current) return null;
  const banner = visible ? { staleError, connection, attempt, secs } : lastBanner.current;
  return (
    <div className={cx('banner', 'banner--warn', closing && 'is-closing')} role="alert" aria-hidden={closing || undefined} inert={closing}>
      <WifiOff size={14} aria-hidden="true" />
      <div>
        {banner.connection === 'online' ? <><strong>Data may be out of date.</strong> {banner.staleError}</> : <>
          <strong>Disconnected from the Mingle server.</strong> {banner.connection === 'connecting' ? 'Reconnecting…' : `Retrying in ${banner.secs}s (attempt ${banner.attempt}).`} Showing the last known state; sending and running are paused.
        </>}
      </div>
      <Button size="sm" onClick={() => useMingle.getState().reconnect()}><RefreshCw size={12} /> Retry now</Button>
    </div>
  );
}

export function Toasts() {
  const toasts = useMingle((s) => s.toasts);
  const rows = usePresenceList<Toast>(toasts);
  return createPortal(
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {rows.map(({ item: t, closing }) => (
        <div key={t.id} className={cx('toast', `toast--${t.tone}`, closing && 'is-closing')} aria-hidden={closing || undefined} inert={closing}>
          {t.tone === 'error' ? <AlertTriangle size={15} className="toast__icon" /> : t.tone === 'success' ? <CheckCircle2 size={15} className="toast__icon" /> : <Info size={15} className="toast__icon" />}
          <p>{t.text}</p>
          <button type="button" className="ibtn" aria-label="Dismiss notification" onClick={() => useMingle.getState().dismissToast(t.id)}><X size={13} /></button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function StartupScreen() {
  const error = useMingle((s) => s.bootError);
  const attempt = useMingle((s) => s.attempt);
  return (
    <div className="startup" role={error ? 'alert' : 'status'}>
      <div className="startup__card">
        <span className="brand-glyph brand-glyph--lg"><MingleGlyph size={26} /></span>
        {error ? (
          <>
            <h1>Can’t reach the Mingle server</h1>
            <p>{error}</p>
            <p className="muted small">Start it with <code>pnpm dev</code> (API on 127.0.0.1:4310). Mingle keeps retrying{attempt > 0 ? ` — attempt ${attempt}` : ''}.</p>
            <Button variant="primary" onClick={() => useMingle.getState().reconnect()}><RefreshCw size={13} /> Retry now</Button>
          </>
        ) : (
          <>
            <h1>Starting Mingle</h1>
            <Spinner label="Loading workspace" />
          </>
        )}
      </div>
    </div>
  );
}

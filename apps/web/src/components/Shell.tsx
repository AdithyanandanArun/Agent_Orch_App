import { AlertTriangle, CheckCircle2, Info, RefreshCw, WifiOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRelay } from '../store/store';
import { Button, RelayGlyph, Spinner } from './ui';

export function ConnectionBanner() {
  const connection = useRelay((s) => s.connection);
  const attempt = useRelay((s) => s.attempt);
  const nextRetryAt = useRelay((s) => s.nextRetryAt);
  const staleError = useRelay((s) => s.staleError);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (connection !== 'offline') return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [connection]);

  if (connection === 'online' && !staleError) return null;
  if (connection === 'connecting' && !staleError && attempt === 0) return null;
  const secs = nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : 0;
  return (
    <div className="banner banner--warn" role="alert">
      <WifiOff size={14} aria-hidden="true" />
      <div>
        {connection === 'online' ? <><strong>Data may be out of date.</strong> {staleError}</> : <>
          <strong>Disconnected from the Relay server.</strong> {connection === 'connecting' ? 'Reconnecting…' : `Retrying in ${secs}s (attempt ${attempt}).`} Showing the last known state; sending and running are paused.
        </>}
      </div>
      <Button size="sm" onClick={() => useRelay.getState().reconnect()}><RefreshCw size={12} /> Retry now</Button>
    </div>
  );
}

export function Toasts() {
  const toasts = useRelay((s) => s.toasts);
  return createPortal(
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          {t.tone === 'error' ? <AlertTriangle size={15} className="toast__icon" /> : t.tone === 'success' ? <CheckCircle2 size={15} className="toast__icon" /> : <Info size={15} className="toast__icon" />}
          <p>{t.text}</p>
          <button type="button" className="ibtn" aria-label="Dismiss notification" onClick={() => useRelay.getState().dismissToast(t.id)}><X size={13} /></button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function StartupScreen() {
  const error = useRelay((s) => s.bootError);
  const attempt = useRelay((s) => s.attempt);
  return (
    <div className="startup" role={error ? 'alert' : 'status'}>
      <div className="startup__card">
        <span className="brand-glyph brand-glyph--lg"><RelayGlyph size={26} /></span>
        {error ? (
          <>
            <h1>Can’t reach the Relay server</h1>
            <p>{error}</p>
            <p className="muted small">Start it with <code>pnpm dev</code> (API on 127.0.0.1:4310). Relay keeps retrying{attempt > 0 ? ` — attempt ${attempt}` : ''}.</p>
            <Button variant="primary" onClick={() => useRelay.getState().reconnect()}><RefreshCw size={13} /> Retry now</Button>
          </>
        ) : (
          <>
            <h1>Starting Relay</h1>
            <Spinner label="Loading workspace" />
          </>
        )}
      </div>
    </div>
  );
}

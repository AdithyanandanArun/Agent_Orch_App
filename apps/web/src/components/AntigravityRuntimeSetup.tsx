import { useCallback, useEffect, useRef, useState } from 'react';
import type { AntigravityInstallState } from '@relay/contracts';
import { api, errorMessage } from '../lib/api';
import { Button, InlineError, Spinner } from './ui';

const POLL_MS = 1_500;

export function AntigravityRuntimeSetup({ onInstalled }: { onInstalled: () => Promise<void> }) {
  const [install, setInstall] = useState<AntigravityInstallState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestPending = useRef(false);
  const completionPending = useRef(false);
  const lastInstallState = useRef<AntigravityInstallState['state'] | null>(null);
  const pollController = useRef<AbortController | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (requestPending.current) return;
    requestPending.current = true;
    try {
      const next = await api.antigravityInstallState(signal);
      if (!signal?.aborted) { setInstall(next); setError(null); }
    } catch (cause) {
      if (!signal?.aborted) setError(errorMessage(cause));
    } finally {
      requestPending.current = false;
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refreshAfterInstall = useCallback(async () => {
    if (completionPending.current) return;
    completionPending.current = true;
    try {
      await api.refreshProviders();
      await onInstalled();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      completionPending.current = false;
    }
  }, [onInstalled]);

  useEffect(() => {
    if (install?.state !== 'installing') return;
    let active = true;
    const poll = window.setInterval(() => {
      if (!active || requestPending.current) return;
      const controller = new AbortController();
      pollController.current = controller;
      void load(controller.signal).finally(() => { if (pollController.current === controller) pollController.current = null; });
    }, POLL_MS);
    return () => { active = false; window.clearInterval(poll); pollController.current?.abort(); pollController.current = null; };
  }, [install?.state, load]);

  useEffect(() => {
    if (lastInstallState.current === 'installing' && install?.state === 'installed') void refreshAfterInstall();
    if (install) lastInstallState.current = install.state;
  }, [install, refreshAfterInstall]);

  const startInstall = async () => {
    if (!install?.supported || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.installAntigravityRuntime();
      setInstall(next);
      if (next.state === 'installed') await refreshAfterInstall();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const stateLabel = install?.state === 'not-installed' ? 'Not installed'
    : install?.state === 'installing' ? 'Installing'
      : install?.state === 'installed' ? 'Installed'
        : install?.state === 'error' ? 'Installation failed' : 'Checking runtime';

  return <section className="agy-runtime" aria-labelledby="agy-runtime-title">
    <div className="agy-runtime__head"><div><h3 id="agy-runtime-title">Antigravity runtime</h3><p>Install the managed ACP runtime used by Relay.</p></div>
      {install?.state === 'installing' ? <Spinner label="Installing Antigravity runtime" /> : null}
    </div>
    {loading && !install ? <p className="agy-runtime__meta">Checking installation status…</p> : null}
    {install ? <>
      <p className="agy-runtime__meta"><strong>{stateLabel}</strong>{install.version ? ` · ${install.version}` : ''}</p>
      {install.executable ? <code className="agy-runtime__path">{install.executable}</code> : null}
      {install.state === 'error' && install.error ? <p className="agy-runtime__error" role="alert">{install.error}</p> : null}
      {!install.supported ? <p className="agy-runtime__meta">Managed installation is not supported on this platform.</p> : null}
      {install.state === 'not-installed' || install.state === 'error' ? <Button size="sm" busy={busy} disabled={!install.supported || busy} onClick={() => void startInstall()}>{install.state === 'error' ? 'Retry installation' : 'Install Antigravity runtime'}</Button> : null}
      {install.state === 'installing' ? <p className="agy-runtime__meta" role="status">Installing locally. This may take a few minutes.</p> : null}
    </> : null}
    {error ? <InlineError onRetry={install?.state === 'installing' ? undefined : () => { setLoading(true); void load(); }}>{error}</InlineError> : null}
    {install?.state === 'installed' ? <p className="agy-runtime__meta">Runtime installation is separate from authentication.</p> : null}
  </section>;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AntigravityAuthState, AntigravityInstallState, ProviderInfo } from '@relay/contracts';
import { api, errorMessage } from '../lib/api';
import { Button, InlineError, Spinner } from './ui';

const POLL_MS = 1_500;
const IDLE_AUTH: AntigravityAuthState = { state: 'idle', error: null };

export function AntigravityRuntimeSetup({ providerInfo, onProviderChanged }: { providerInfo?: ProviderInfo; onProviderChanged: () => Promise<void> }) {
  const [install, setInstall] = useState<AntigravityInstallState | null>(null);
  const [auth, setAuth] = useState<AntigravityAuthState>(IDLE_AUTH);
  const [loading, setLoading] = useState(true);
  const [installBusy, setInstallBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installRequestId = useRef(0);
  const installRequestPending = useRef(false);
  const authRequestId = useRef(0);
  const authRequestPending = useRef(false);
  const completionPending = useRef(false);
  const authCompletionHandled = useRef(false);
  const installCompletionHandled = useRef(false);
  const authStateRef = useRef<AntigravityAuthState['state']>('idle');
  const installStateRef = useRef<AntigravityInstallState['state'] | null>(null);

  const loadInstall = useCallback(async (signal?: AbortSignal, force = false) => {
    if (!force && installRequestPending.current) return;
    const requestId = ++installRequestId.current;
    installRequestPending.current = true;
    try {
      const next = await api.antigravityInstallState(signal);
      if (requestId === installRequestId.current && !signal?.aborted) { setInstall(next); setError(null); }
    } catch (cause) {
      if (requestId === installRequestId.current && !signal?.aborted) setError(errorMessage(cause));
    } finally {
      if (requestId === installRequestId.current) {
        installRequestPending.current = false;
        if (!signal?.aborted) setLoading(false);
      }
    }
  }, []);

  const completeProviderChange = useCallback(async () => {
    if (completionPending.current) return;
    completionPending.current = true;
    try {
      await api.refreshProviders();
      await onProviderChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      completionPending.current = false;
    }
  }, [onProviderChanged]);

  const applyAuthState = useCallback((next: AntigravityAuthState, allowCompletion: boolean, immediatePost = false) => {
    const previous = authStateRef.current;
    authStateRef.current = next.state;
    setAuth(next);
    if (allowCompletion && next.state === 'authenticated' && (immediatePost || previous === 'authenticating') && !authCompletionHandled.current) {
      authCompletionHandled.current = true;
      void completeProviderChange();
    }
    if (next.state === 'error' && next.error) setError(next.error);
  }, [completeProviderChange]);

  const loadAuth = useCallback(async (signal?: AbortSignal, force = false) => {
    if (!force && authRequestPending.current) return;
    const requestId = ++authRequestId.current;
    authRequestPending.current = true;
    try {
      const next = await api.antigravityAuthState(signal);
      if (requestId === authRequestId.current && !signal?.aborted) applyAuthState(next, true);
    } catch (cause) {
      if (requestId === authRequestId.current && !signal?.aborted) setError(errorMessage(cause));
    } finally {
      if (requestId === authRequestId.current) authRequestPending.current = false;
    }
  }, [applyAuthState]);

  useEffect(() => {
    const installController = new AbortController();
    const authController = new AbortController();
    void loadInstall(installController.signal, true);
    void loadAuth(authController.signal, true);
    return () => { installController.abort(); authController.abort(); };
  }, [loadAuth, loadInstall]);

  useEffect(() => {
    if (install?.state !== 'installing') return;
    let active = true;
    let controller: AbortController | null = null;
    const timer = window.setInterval(() => {
      if (!active || installRequestPending.current) return;
      controller = new AbortController();
      void loadInstall(controller.signal);
    }, POLL_MS);
    return () => { active = false; window.clearInterval(timer); controller?.abort(); };
  }, [install?.state, loadInstall]);

  useEffect(() => {
    if (install?.state === 'installed' && installStateRef.current === 'installing' && !installCompletionHandled.current) {
      installCompletionHandled.current = true;
      void completeProviderChange();
    }
    if (install) installStateRef.current = install.state;
  }, [install, completeProviderChange]);

  useEffect(() => {
    if (auth.state !== 'authenticating') return;
    let active = true;
    let controller: AbortController | null = null;
    const timer = window.setInterval(() => {
      if (!active || authRequestPending.current) return;
      controller = new AbortController();
      void loadAuth(controller.signal);
    }, POLL_MS);
    return () => { active = false; window.clearInterval(timer); controller?.abort(); };
  }, [auth.state, loadAuth]);

  const startInstall = async () => {
    if (!install?.supported || installBusy || authBusy) return;
    setInstallBusy(true);
    setError(null);
    installCompletionHandled.current = false;
    try {
      const next = await api.installAntigravityRuntime();
      setInstall(next);
      if (next.state === 'installed' && !installCompletionHandled.current) {
        installCompletionHandled.current = true;
        await completeProviderChange();
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setInstallBusy(false);
    }
  };

  const startSignIn = async () => {
    if (authBusy || installBusy) return;
    authRequestId.current++;
    authRequestPending.current = false;
    setAuthBusy(true);
    setError(null);
    authCompletionHandled.current = false;
    try {
      const next = await api.startAntigravityAuth();
      applyAuthState(next, true, true);
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      applyAuthState({ state: 'error', error: message }, false);
    } finally {
      setAuthBusy(false);
    }
  };

  const cancelSignIn = async () => {
    if (authBusy) return;
    authRequestId.current++;
    authRequestPending.current = false;
    setAuthBusy(true);
    setError(null);
    try {
      applyAuthState(await api.cancelAntigravityAuth(), false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAuthBusy(false);
    }
  };

  const stateLabel = install?.state === 'not-installed' ? 'Not installed'
    : install?.state === 'installing' ? 'Installing'
      : install?.state === 'installed' ? 'Installed'
        : install?.state === 'error' ? 'Installation failed' : 'Checking runtime';
  const canSignIn = Boolean(providerInfo?.executable || install?.state === 'installed');
  const blocked = installBusy || authBusy || auth.state === 'authenticating';

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
      {install.state === 'not-installed' || install.state === 'error' ? <Button size="sm" busy={installBusy} disabled={!install.supported || blocked} onClick={() => void startInstall()}>{install.state === 'error' ? 'Retry installation' : 'Install Antigravity runtime'}</Button> : null}
      {install.state === 'installing' ? <p className="agy-runtime__meta" role="status">Installing locally. This may take a few minutes.</p> : null}
    </> : null}
    {canSignIn ? <div className="agy-runtime__auth">
      {auth.state === 'authenticated' ? <p className="agy-runtime__meta" role="status">Google sign-in completed. Relay uses the models and capabilities reported by Antigravity.</p>
        : auth.state === 'authenticating' ? <><p className="agy-runtime__meta" role="status">Continue in your browser to sign in with Google.</p><Button size="sm" disabled={installBusy || authBusy} busy={authBusy} onClick={() => void cancelSignIn()}>Cancel sign-in</Button></>
          : <Button size="sm" disabled={blocked} busy={authBusy} onClick={() => void startSignIn()}>Sign in with Google</Button>}
      {auth.state === 'error' && auth.error ? <p className="agy-runtime__error" role="alert">{auth.error}</p> : null}
      {auth.state === 'idle' ? <p className="agy-runtime__meta">No active sign-in flow is reported. Antigravity may still have a cached account.</p> : null}
    </div> : null}
    {error ? <InlineError onRetry={install?.state === 'installing' || auth.state === 'authenticating' ? undefined : () => { setLoading(true); void loadInstall(); void loadAuth(); }}>{error}</InlineError> : null}
    {install?.state === 'installed' ? <p className="agy-runtime__meta">Runtime installation is separate from authentication.</p> : null}
  </section>;
}

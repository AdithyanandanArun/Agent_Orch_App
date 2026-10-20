import type { AntigravityAuthState, AppSettings } from '@relay/contracts';
import { authenticateAntigravity, probeAuthenticatedAntigravity } from './providers/antigravity/auth.js';
import { errorMessage, redactSecrets, truncate } from './util.ts';
import { openGoogleAuthorization } from './providers/antigravity/auth-browser.js';

interface AuthJob {
  executable: string; controller: AbortController; status: AntigravityAuthState; settled?: Promise<void>;
}
const jobs = new Map<string, AuthJob>();

function authError(error: unknown): string {
  const message = redactSecrets(errorMessage(error)).replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
    try { const url = new URL(value); url.search = ''; url.hash = ''; url.username = ''; url.password = ''; return url.toString(); }
    catch { return '[authorization URL omitted]'; }
  });
  return truncate(message, 500);
}

export function antigravityAuthState(dataDir: string, settings: AppSettings): AntigravityAuthState {
  const job = jobs.get(dataDir);
  if (!job || job.executable !== (settings.antigravityExecutable ?? '')) return { state: 'idle', error: null };
  return { ...job.status };
}

/** Explicit sign-in or metadata refresh only. Google owns the browser flow and credentials. */
export function startAntigravityAuth(dataDir: string, settings: AppSettings, onAuthenticated: () => void, options: { refresh?: boolean } = {}): AntigravityAuthState {
  const previous = jobs.get(dataDir);
  const executable = settings.antigravityExecutable ?? '';
  if (previous?.status.state === 'authenticating' && previous.executable === executable) return { ...previous.status };
  previous?.controller.abort();
  const job: AuthJob = { executable, controller: new AbortController(), status: { state: 'authenticating', phase: options.refresh ? 'loading-models' : 'starting', error: null } };
  jobs.set(dataDir, job);
  const discover = options.refresh ? probeAuthenticatedAntigravity : authenticateAntigravity;
  job.settled = discover(settings, { signal: job.controller.signal, onProgress: (progress) => {
    if (jobs.get(dataDir) !== job || job.controller.signal.aborted || job.status.state !== 'authenticating') return;
    const previousUrl = job.status.authorizationUrl;
    job.status = { state: 'authenticating', error: null, ...progress };
    const url = progress.authorizationUrl;
    if (!options.refresh && url && url !== previousUrl) void openGoogleAuthorization(url, job.controller.signal).catch(() => {
      if (jobs.get(dataDir) === job && !job.controller.signal.aborted && job.status.authorizationUrl === url) {
        job.status.browserError = 'The default browser could not be opened. Use Open Google sign-in below.';
      }
    });
  } }).then((provider) => {
    if (jobs.get(dataDir) !== job || job.controller.signal.aborted) return;
    if (!provider.available) throw new Error(provider.reason ?? 'Antigravity sign-in did not complete.');
    job.status = { state: 'authenticated', error: null };
    onAuthenticated();
  }).catch((error: unknown) => {
    if (jobs.get(dataDir) !== job || job.controller.signal.aborted) return;
    job.status = { state: 'error', error: authError(error) };
  });
  return { ...job.status };
}

export async function closeAntigravityAuth(dataDir: string): Promise<void> {
  cancelAntigravityAuth(dataDir);
  await jobs.get(dataDir)?.settled;
}

export function cancelAntigravityAuth(dataDir: string): AntigravityAuthState {
  const job = jobs.get(dataDir);
  if (job?.status.state === 'authenticating') {
    job.controller.abort();
    job.status = { state: 'idle', error: null };
  }
  return job ? { ...job.status } : { state: 'idle', error: null };
}

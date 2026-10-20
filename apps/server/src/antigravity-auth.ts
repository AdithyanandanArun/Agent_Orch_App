import type { AntigravityAuthState, AppSettings } from '@relay/contracts';
import { authenticateAntigravity } from './providers/index.ts';
import { errorMessage, redactSecrets, truncate } from './util.ts';

interface AuthJob {
  executable: string; controller: AbortController; status: AntigravityAuthState; settled?: Promise<void>;
}
const jobs = new Map<string, AuthJob>();

function authError(error: unknown): string {
  const message = redactSecrets(errorMessage(error)).replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
    try { const url = new URL(value); url.search = ''; url.hash = ''; return url.toString(); }
    catch { return '[authorization URL omitted]'; }
  });
  return truncate(message, 500);
}

export function antigravityAuthState(dataDir: string, settings: AppSettings): AntigravityAuthState {
  const job = jobs.get(dataDir);
  if (!job || job.executable !== (settings.antigravityExecutable ?? '')) return { state: 'idle', error: null };
  return { ...job.status };
}

/** Only explicit user sign-in calls this. Google owns the browser flow and credentials. */
export function startAntigravityAuth(dataDir: string, settings: AppSettings, onAuthenticated: () => void): AntigravityAuthState {
  const previous = jobs.get(dataDir);
  const executable = settings.antigravityExecutable ?? '';
  if (previous?.status.state === 'authenticating' && previous.executable === executable) return { ...previous.status };
  previous?.controller.abort();
  const job: AuthJob = { executable, controller: new AbortController(), status: { state: 'authenticating', error: null } };
  jobs.set(dataDir, job);
  job.settled = authenticateAntigravity(settings, { signal: job.controller.signal }).then((provider) => {
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

import { run, type RunResult } from './exec.ts';
import { failureSummary } from './scrub.ts';

export type GhFailureKind = 'missing' | 'auth' | 'rate-limit' | 'not-found' | 'forbidden' | 'unprocessable' | 'timeout' | 'cancelled' | 'other';
export interface GhFailure { kind: GhFailureKind; status: number | null; message: string }
export type GhResult<T> = { ok: true; data: T } | { ok: false; failure: GhFailure };

const HOST = 'github.com';

function ghEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GH_REPO;
  Object.assign(env, { GH_HOST: HOST, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', CLICOLOR: '0', GH_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' });
  return env;
}

export function ghRun(args: string[], options: { cwd?: string; timeoutMs?: number; maxBuffer?: number; signal?: AbortSignal }): Promise<RunResult> {
  return run('gh', args, { cwd: options.cwd, env: ghEnv(), timeoutMs: options.timeoutMs ?? 20_000, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024, signal: options.signal, detached: true });
}

/** Maps a failed gh invocation to an honest, scrubbed explanation. */
export function classify(result: RunResult): GhFailure {
  if (result.spawnError) {
    return result.spawnError.code === 'ENOENT'
      ? { kind: 'missing', status: null, message: 'The GitHub CLI (gh) is not installed or is not on PATH.' }
      : { kind: 'other', status: null, message: `The GitHub CLI could not be started: ${failureSummary(result.spawnError.message)}` };
  }
  if (result.aborted) return { kind: 'cancelled', status: null, message: 'The GitHub request was cancelled.' };
  if (result.timedOut) return { kind: 'timeout', status: null, message: 'GitHub did not answer in time.' };
  const text = `${result.stderr}\n${result.stdout}`;
  const status = Number(/\(HTTP (\d{3})\)/.exec(text)?.[1] ?? /HTTP (\d{3})/.exec(text)?.[1]) || null;
  if (/gh auth login|not logged in|authentication required|requires authentication|bad credentials|GH_TOKEN|HTTP 401/i.test(text) || status === 401) {
    return { kind: 'auth', status, message: 'The GitHub CLI is not signed in. Run `gh auth login` in a terminal.' };
  }
  if (/rate limit|secondary rate|abuse detection/i.test(text) || status === 429) return { kind: 'rate-limit', status, message: 'GitHub rate limit reached. Try again in a few minutes.' };
  if (status === 403) return { kind: 'forbidden', status, message: 'The GitHub CLI login cannot read this resource (HTTP 403).' };
  if (status === 404) return { kind: 'not-found', status, message: 'GitHub could not find this repository or resource, or the login has no access (HTTP 404).' };
  if (status === 422) return { kind: 'unprocessable', status, message: failureSummary(result.stderr || result.stdout) || 'GitHub rejected the request (HTTP 422).' };
  return { kind: 'other', status, message: `The GitHub CLI failed: ${failureSummary(result.stderr || result.stdout)}` };
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const isRepositorySlug = (value: string) => REPO.test(value);

/** GET against the GitHub REST API through the signed-in gh CLI. The endpoint must be built from validated parts. */
export async function ghApi(endpoint: string, signal?: AbortSignal): Promise<GhResult<unknown>> {
  const result = await ghRun(['api', '--hostname', HOST, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint], { signal });
  if (result.code !== 0 || result.spawnError) return { ok: false, failure: classify(result) };
  try {
    return { ok: true, data: JSON.parse(result.stdout) as unknown };
  } catch {
    return { ok: false, failure: { kind: 'other', status: null, message: 'GitHub returned a response Mingle could not read.' } };
  }
}

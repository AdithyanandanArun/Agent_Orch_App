import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import type { AppSettings, ProviderInfo } from '@relay/contracts';
import { CODEX_CLIENT_INFO } from './codex/adapter.js';
import { JsonRpcConnection, RpcError } from './codex/rpc.js';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS } from './claude/messages.js';
import { TextTail, cleanEnv, errorMessage, isRecord, truncate } from './common.js';
import { bundledClaudeCandidates, resolveExecutable, type ResolvedExecutable } from './discovery.js';
import { shutdownChild, settlesWithin, type ChildLike, type ProbeFn } from './process.js';

export const CODEX_DEFAULT_MODEL = 'gpt-6.1-sol';
const CODEX_DEFAULT_MODEL_ENTRY = { id: CODEX_DEFAULT_MODEL, name: 'GPT-6.1 Sol' };

export interface DetectDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  probe?: ProbeFn;
  spawn?: (file: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildLike;
  /** Overall deadline for the Codex app-server probe. */
  codexProbeTimeoutMs?: number;
}

function skippedNote(executable: ResolvedExecutable, label: string): string | null {
  if (executable.skipped.length === 0) return null;
  const skipped = executable.skipped.map((entry) => `${entry.path} (${entry.reason})`).join('; ');
  return `Using ${executable.path}; skipped ${skipped}.`.replace(/^/, `${label}: `);
}

// ---- Claude ----------------------------------------------------------------------------------------------------

export async function detectClaude(settings: AppSettings, deps: DetectDeps = {}): Promise<ProviderInfo> {
  const env = deps.env ?? process.env;
  const base: ProviderInfo = { id: 'claude', name: 'Claude', available: false, version: null, executable: null, reason: null, models: CLAUDE_MODELS };
  const resolved = await resolveExecutable({ name: 'claude', override: settings.claudeExecutable, env, home: deps.home, probe: deps.probe, extraCandidates: bundledClaudeCandidates() });
  if (!resolved.ok) return { ...base, reason: resolved.reason };
  const { executable } = resolved;
  const info = { ...base, version: executable.version, executable: executable.path };
  if (!env.ANTHROPIC_API_KEY?.trim()) {
    return { ...info, reason: `Claude Code ${executable.version} is installed at ${executable.path}, but ANTHROPIC_API_KEY is not set in the Relay server environment. Relay uses API-key authentication only and does not use claude.ai subscription login.` };
  }
  const note = skippedNote(executable, 'Claude');
  return {
    ...info,
    available: true,
    reason: ['ANTHROPIC_API_KEY is set; the key is not validated until a session runs.', note].filter(Boolean).join(' '),
  };
}

// ---- Codex -----------------------------------------------------------------------------------------------------

interface CodexProbe {
  account: 'none' | 'present' | 'unknown';
  accountType: string | null;
  models: { id: string; name: string }[] | null;
  error: string | null;
}

/** Starts a short-lived app-server and asks only for local state (account/read, model/list); no inference is requested. */
export async function probeCodexAppServer(executable: string, deps: DetectDeps = {}): Promise<CodexProbe> {
  const env = cleanEnv(deps.env ?? process.env, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']);
  const timeoutMs = deps.codexProbeTimeoutMs ?? 20_000;
  const stderr = new TextTail();
  const result: CodexProbe = { account: 'unknown', accountType: null, models: null, error: null };
  const spawnFn = deps.spawn ?? ((file, args, options) => spawn(file, args, options) as unknown as ChildLike);
  let child: ChildLike;
  try {
    child = spawnFn(executable, ['app-server'], { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  } catch (error) {
    return { ...result, error: errorMessage(error) };
  }
  child.stderr?.on('data', (chunk: string | Buffer) => stderr.push(chunk.toString()));
  const conn = new JsonRpcConnection(child, {
    onNotification: () => undefined,
    onRequest: async (method) => { throw new RpcError(-32601, `Relay probe does not support ${method}`); },
    formatClose: (info) => `app-server ${info.error ? `could not start (${info.error.message})` : `exited with ${info.signal ?? `code ${info.exitCode}`}`}${stderr.isEmpty ? '' : `: ${stderr.summary(300)}`}`,
  });
  const deadline = Date.now() + timeoutMs;
  const left = (): number => Math.max(1_000, deadline - Date.now());
  try {
    await conn.request('initialize', { clientInfo: { ...CODEX_CLIENT_INFO }, capabilities: { experimentalApi: false } }, left());
    conn.notify('initialized', {});
    try {
      const account = await conn.request('account/read', { refreshToken: false }, left());
      if (isRecord(account)) {
        if (isRecord(account.account)) {
          result.account = 'present';
          result.accountType = typeof account.account.type === 'string' ? account.account.type : null;
        } else {
          result.account = account.requiresOpenaiAuth === false ? 'present' : 'none';
        }
      }
    } catch (error) {
      result.error = `account/read failed: ${errorMessage(error)}`;
    }
    try {
      const models: { id: string; name: string }[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const response: unknown = await conn.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, left());
        if (!isRecord(response) || !Array.isArray(response.data)) break;
        for (const entry of response.data) {
          if (!isRecord(entry) || entry.hidden === true) continue;
          const id = typeof entry.model === 'string' ? entry.model : typeof entry.id === 'string' ? entry.id : null;
          if (id) models.push({ id, name: typeof entry.displayName === 'string' ? entry.displayName : id });
        }
        cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
        if (!cursor) break;
      }
      result.models = models;
    } catch (error) {
      result.error = [result.error, `model/list failed: ${errorMessage(error)}`].filter(Boolean).join('; ');
    }
  } catch (error) {
    result.error = errorMessage(error);
  } finally {
    await shutdownChild(child, { closed: conn.closed, group: process.platform !== 'win32', graceMs: 1_000, termMs: 2_000, killMs: 1_000 });
    await settlesWithin(conn.closed, 100);
  }
  return result;
}

export async function detectCodex(settings: AppSettings, deps: DetectDeps = {}): Promise<ProviderInfo> {
  const env = deps.env ?? process.env;
  const base: ProviderInfo = { id: 'codex', name: 'Codex', available: false, version: null, executable: null, reason: null, models: [] };
  const resolved = await resolveExecutable({ name: 'codex', override: settings.codexExecutable, env, home: deps.home, probe: deps.probe });
  if (!resolved.ok) return { ...base, reason: resolved.reason };
  const { executable } = resolved;
  const info = { ...base, version: executable.version, executable: executable.path };
  const probe = await probeCodexAppServer(executable.path, deps);
  const models = probe.models && probe.models.length > 0 ? probe.models : [CODEX_DEFAULT_MODEL_ENTRY];
  const note = skippedNote(executable, 'Codex');
  if (probe.account === 'none') {
    return { ...info, models, reason: `Codex ${executable.version} is installed at ${executable.path} but no Codex login was found. Run \`codex login\` in a terminal, then refresh.` };
  }
  if (probe.models === null && probe.account === 'unknown') {
    return { ...info, models, reason: `Codex ${executable.version} is installed at ${executable.path}, but its app-server did not respond: ${truncate(probe.error ?? 'unknown error', 400)}` };
  }
  const authText = probe.account === 'present'
    ? `Codex account detected${probe.accountType ? ` (${probe.accountType})` : ''}; the login is not validated until a session runs.`
    : 'Could not verify whether Codex is logged in.';
  const modelText = probe.models === null ? 'Model list unavailable; showing the default model only.' : null;
  return { ...info, available: true, models, reason: [authText, modelText, probe.error && probe.models !== null ? truncate(probe.error, 300) : null, note].filter(Boolean).join(' ') };
}

// ---- Public entry ----------------------------------------------------------------------------------------------

const inFlight = new Map<string, Promise<ProviderInfo[]>>();

/** Reports real availability. Concurrent calls with identical settings share one probe. */
export function detectProviders(settings: AppSettings, deps: DetectDeps = {}): Promise<ProviderInfo[]> {
  const key = JSON.stringify([settings.claudeExecutable, settings.codexExecutable, deps.env === undefined ? 'process' : 'custom']);
  const pending = inFlight.get(key);
  if (pending && !deps.probe && !deps.spawn) return pending;
  const run = Promise.all([detectCodex(settings, deps), detectClaude(settings, deps)]).then(([codex, claude]) => [codex, claude]);
  if (!deps.probe && !deps.spawn) {
    inFlight.set(key, run);
    void run.finally(() => inFlight.delete(key)).catch(() => undefined);
  }
  return run;
}

export { CLAUDE_DEFAULT_MODEL };

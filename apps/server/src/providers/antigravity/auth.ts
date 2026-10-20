import { tmpdir } from 'node:os';
import type { AppSettings, ProviderInfo } from '@relay/contracts';
import { isRecord, redactSecrets, truncate } from '../common.js';
import { closeAntigravity, markAntigravityAuthenticated, resolveAntigravity, startAntigravity } from './runtime.js';
import { parseAntigravityMetadata } from './metadata.js';
import { rememberAntigravityMetadata } from './runtime.js';

const AUTH_TIMEOUT = 5 * 60_000;
const SESSION_TIMEOUT = 90_000;
function toInfo(exe: string, version: string, response: unknown): ProviderInfo {
  const parsed = parseAntigravityMetadata(version, response);
  return { id: 'antigravity', name: 'Google Antigravity', available: true, version, executable: exe, reason: 'Google sign-in completed; account access is checked again when a run starts.', models: parsed.models, policies: ['supervised', 'balanced', 'full-access'] };
}
async function refresh(settings: AppSettings, authenticate: boolean, signal?: AbortSignal): Promise<ProviderInfo> {
  const found = await resolveAntigravity(settings);
  if (!found.ok) return { id: 'antigravity', name: 'Google Antigravity', available: false, version: null, executable: null, reason: found.reason, models: [] };
  let runtime: Awaited<ReturnType<typeof startAntigravity>> | undefined;
  let commands: unknown[] = [];
  try {
    if (signal?.aborted) throw Object.assign(new Error('Antigravity authentication was canceled.'), { name: 'AbortError' });
    runtime = await startAntigravity(found.executable.path, found.executable.companion, {
      cwd: tmpdir(), timeoutMs: 12_000,
      notification: (_method, params) => {
        const data = isRecord(params) ? params : {}; const update = isRecord(data.update) ? data.update : {};
        if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) commands = update.availableCommands;
      },
    });
    if (authenticate) await runtime.conn.request('authenticate', { methodId: 'oauth-personal' }, AUTH_TIMEOUT);
    if (signal?.aborted) throw Object.assign(new Error('Antigravity authentication was canceled.'), { name: 'AbortError' });
    const response: unknown = await runtime.conn.request('session/new', { cwd: tmpdir(), mcpServers: [] }, SESSION_TIMEOUT);
    if (!isRecord(response) || typeof response.sessionId !== 'string') throw new Error('Antigravity ACP did not return a metadata session.');
    markAntigravityAuthenticated(found.executable.path, process.env);
    const info = toInfo(found.executable.path, runtime.version, response);
    const parsed = parseAntigravityMetadata(runtime.version, response);
    if (commands.length) parsed.commands = parseAntigravityMetadata(runtime.version, { availableCommands: commands }).commands;
    rememberAntigravityMetadata(found.executable.path, process.env, parsed);
    return info;
  } catch (error) {
    return { id: 'antigravity', name: 'Google Antigravity', available: false, version: runtime?.version ?? null, executable: found.executable.path,
      reason: `Antigravity ${authenticate ? 'sign-in' : 'metadata refresh'} failed: ${truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 350)}`,
      models: [] };
  } finally { if (runtime) await closeAntigravity(runtime); }
}
/** Explicit Settings action: ACP authenticate opens Google's own sign-in flow. Relay stores no credentials. */
export function authenticateAntigravity(settings: AppSettings, options: { signal?: AbortSignal } = {}): Promise<ProviderInfo> { return refresh(settings, true, options.signal); }
/** Explicit metadata refresh only. This can re-trigger native authentication if Google's session expired. */
export function probeAuthenticatedAntigravity(settings: AppSettings, options: { signal?: AbortSignal } = {}): Promise<ProviderInfo> { return refresh(settings, false, options.signal); }

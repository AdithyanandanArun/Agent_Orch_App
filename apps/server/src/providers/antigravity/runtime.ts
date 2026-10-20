import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn, type SpawnOptions } from 'node:child_process';
import type { AppSettings, ProviderInfo, ProviderModel, Policy } from '@relay/contracts';
import { cleanEnv, errorMessage, isRecord, redactSecrets, truncate } from '../common.js';
import { shutdownChild, type ChildLike } from '../process.js';
import { AcpConnection, AcpRpcError, ACP_METHOD_NOT_FOUND } from './rpc.js';

export const ANTIGRAVITY_POLICIES: Policy[] = ['supervised', 'balanced', 'full-access'];
export const ANTIGRAVITY_DEFAULT: ProviderModel = { id: 'default', name: 'Antigravity default', reasoningEfforts: [{ id: 'none', label: 'Native default' }], defaultReasoningEffort: 'none', policies: ANTIGRAVITY_POLICIES };
const REMOVE_ENV = ['RELAY_BROWSER_MCP_TOKEN', 'RELAY_TEAM_MCP_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];
const spawnDefault = (file: string, args: string[], options: SpawnOptions): ChildLike => spawn(file, args, options) as unknown as ChildLike;
export interface AntigravityExecutable { path: string; companion: string }
export type AntigravityResolve = { ok: true; executable: AntigravityExecutable } | { ok: false; reason: string };
function expandHome(path: string, home: string): string { return path === '~' ? home : path.startsWith('~/') || path.startsWith('~\\') ? join(home, path.slice(2)) : path; }
async function executable(path: string): Promise<boolean> { try { return (await stat(path)).isFile() && (await access(path, constants.X_OK), true); } catch { return false; } }
function names(): { acp: string; harness: string } { return process.platform === 'win32' ? { acp: 'agy_acp_server.exe', harness: 'localharness_external.exe' } : { acp: 'agy_acp_server.par', harness: 'localharness_external' }; }
async function verifyPair(path: string): Promise<AntigravityExecutable | null> {
  if (!(await executable(path))) return null;
  const companion = join(dirname(path), names().harness);
  if (!(await executable(companion))) return null;
  return { path, companion };
}
export async function resolveAntigravity(settings: AppSettings, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<AntigravityResolve> {
  const override = settings.antigravityExecutable?.trim();
  if (override) {
    const expanded = expandHome(override, home);
    const path = /[\\/]/.test(expanded) ? resolve(expanded) : (env.PATH ?? '').split(delimiter).filter(isAbsolute).map((dir) => join(dir, expanded)).find((p) => p.endsWith(names().acp) || p === expanded);
    if (!path) return { ok: false, reason: `Configured Antigravity ACP executable "${truncate(override, 200)}" was not found.` };
    const pair = await verifyPair(path);
    return pair ? { ok: true, executable: pair } : { ok: false, reason: `Configured Antigravity executable ${path} or its required ${names().harness} companion is missing or not executable.` };
  }
  const candidates = (env.PATH ?? '').split(delimiter).filter(isAbsolute).map((dir) => join(dir, names().acp));
  candidates.push(join(home, '.local', 'bin', names().acp));
  for (const path of [...new Set(candidates)]) { const pair = await verifyPair(path); if (pair) return { ok: true, executable: pair }; }
  return { ok: false, reason: `Antigravity ACP was not found on PATH or ~/.local/bin. Install it explicitly in Settings, including its ${names().harness} companion.` };
}

export interface AntigravityMetadata { version: string; models: ProviderModel[]; commands: { id: string; name: string; description: string; argumentHint?: string; source: 'provider'; kind: 'prompt' }[]; choices: unknown }
const metadata = new Map<string, AntigravityMetadata>();
const authVerified = new Set<string>();
const keyOf = (exe: string, env: NodeJS.ProcessEnv): string => JSON.stringify([exe, process.platform, env.ANTIGRAVITY_HARNESS_PATH ?? 'sibling']);
export function cachedAntigravityMetadata(exe: string, env: NodeJS.ProcessEnv = process.env): AntigravityMetadata | undefined { return metadata.get(keyOf(exe, env)); }
export function rememberAntigravityMetadata(exe: string, env: NodeJS.ProcessEnv, value: AntigravityMetadata): void { metadata.set(keyOf(exe, env), value); }
export function markAntigravityAuthenticated(exe: string, env: NodeJS.ProcessEnv): void { authVerified.add(keyOf(exe, env)); }
export function isAntigravityAuthenticated(exe: string, env: NodeJS.ProcessEnv = process.env): boolean { return authVerified.has(keyOf(exe, env)); }
export function antigravityInfo(executablePath: string | null, version: string | null, models: ProviderModel[], available: boolean, reason: string | null): ProviderInfo {
  return { id: 'antigravity', name: 'Google Antigravity', available, version, executable: executablePath, reason, models, policies: ANTIGRAVITY_POLICIES };
}
export function antigravityChildEnv(env: NodeJS.ProcessEnv, companion: string): Record<string, string> {
  return cleanEnv(env, REMOVE_ENV, { ANTIGRAVITY_HARNESS_PATH: companion });
}

export interface AntigravityRuntime { child: ChildLike; conn: AcpConnection; stderr: string[]; version: string; capabilities: Record<string, unknown> }
export async function startAntigravity(path: string, companion: string, options: { env?: NodeJS.ProcessEnv; spawn?: typeof spawnDefault; timeoutMs?: number; cwd?: string; notification?: (method: string, params: unknown) => void; request?: (method: string, params: unknown) => Promise<unknown> } = {}): Promise<AntigravityRuntime> {
  const env = options.env ?? process.env; const spawnFn = options.spawn ?? spawnDefault;
  const child = spawnFn(path, [], { cwd: options.cwd ?? process.cwd(), env: antigravityChildEnv(env, companion), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  const stderr: string[] = []; child.stderr?.on('data', (chunk: string | Buffer) => { stderr.push(chunk.toString()); if (stderr.join('').length > 20_000) stderr.splice(0, stderr.length - 1); });
  const conn = new AcpConnection(child, {
    notification: (method, params) => options.notification?.(method, params),
    request: async (method, params) => {
      if (options.request) return options.request(method, params);
      throw new AcpRpcError(ACP_METHOD_NOT_FOUND, `Relay does not support ACP client request ${method}.`);
    },
    closeMessage: (info) => `Antigravity ACP ${info.error ? `could not start (${(info.error as NodeJS.ErrnoException).code ?? info.error.message})` : `exited unexpectedly (${info.signal ?? `code ${info.exitCode}`})`}${stderr.length ? `: ${truncate(redactSecrets(stderr.join('')), 500)}` : ''}.`,
  });
  try {
    const init: unknown = await conn.request('initialize', { protocolVersion: 1, clientInfo: { name: 'relay', version: '0.1.0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, options.timeoutMs ?? 12_000);
    if (!isRecord(init) || !isRecord(init.agentInfo) || typeof init.agentInfo.version !== 'string' || !isRecord(init.agentCapabilities)) throw new Error('Antigravity ACP returned an invalid initialize response.');
    return { child, conn, stderr, version: init.agentInfo.version, capabilities: init.agentCapabilities };
  } catch (error) {
    await shutdownChild(child, { closed: conn.closed, group: process.platform !== 'win32', graceMs: 0, termMs: 700, killMs: 700 });
    throw error;
  }
}

export function closeAntigravity(runtime: AntigravityRuntime): Promise<unknown> {
  return shutdownChild(runtime.child, { closed: runtime.conn.closed, group: process.platform !== 'win32', graceMs: 700, termMs: 1_200, killMs: 1_000 });
}
export function safeAntigravityError(error: unknown): string { return truncate(redactSecrets(errorMessage(error)), 400); }

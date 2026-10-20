import { tmpdir } from 'node:os';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AntigravityAuthState, AppSettings, ProviderInfo, ProviderModel } from '@relay/contracts';
import { abortError, isRecord } from '../common.js';
import { closeAntigravity, markAntigravityAuthenticated, rememberAntigravityMetadata, resolveAntigravity, safeAntigravityError, startAntigravity, type AntigravityRuntime } from './runtime.js';
import { choices, configuration, object, parseAntigravityMetadata } from './metadata.js';

const AUTH_TIMEOUT = 5 * 60_000;
interface AuthOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Pick<AntigravityAuthState, 'phase' | 'authorizationUrl'>) => void;
}
async function refresh(settings: AppSettings, authenticate: boolean, options: AuthOptions = {}): Promise<ProviderInfo> {
  const { signal } = options;
  const found = await resolveAntigravity(settings);
  if (!found.ok) return { id: 'antigravity', name: 'Google Antigravity', available: false, version: null, executable: null, reason: found.reason, models: [] };
  const timeout = new AbortController();
  const duration = authenticate ? AUTH_TIMEOUT : 90_000;
  const deadline = Date.now() + duration;
  const timer = setTimeout(() => timeout.abort(), duration); timer.unref();
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const remaining = (max: number): number => Math.max(1, Math.min(max, deadline - Date.now()));
  let runtime: AntigravityRuntime | undefined;
  let workspace: string | undefined;
  let sessionId: string | null = null;
  let commands: unknown[] = [];
  let commandsArrived!: () => void;
  const commandsReady = new Promise<void>((resolve) => { commandsArrived = resolve; });
  let loginRequired = false;
  let commandTimer: NodeJS.Timeout | undefined;
  try {
    if (combined.aborted) throw abortError();
    workspace = await mkdtemp(join(tmpdir(), 'relay-antigravity-metadata-'));
    if (process.platform !== 'win32') await chmod(workspace, 0o700);
    runtime = await startAntigravity(found.executable.path, found.executable.companion, { cwd: workspace, timeoutMs: remaining(12_000), signal: combined,
      onAuthorizationUrl: (authorizationUrl: string) => {
        if (authenticate) options.onProgress?.({ phase: 'waiting-for-browser', authorizationUrl });
        else { loginRequired = true; timeout.abort(); }
      },
      notification: (method, params) => {
        const data = object(params); const update = object(data.update);
        if (method === 'session/update' && (!sessionId || data.sessionId === sessionId) && update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) { commands = update.availableCommands.slice(0, 100); commandsArrived(); }
      },
    });
    if (authenticate) await runtime.conn.request('authenticate', { methodId: 'oauth-personal' }, remaining(AUTH_TIMEOUT));
    if (combined.aborted) throw abortError();
    options.onProgress?.({ phase: 'loading-models' });
    const response: unknown = await runtime.conn.request('session/new', { cwd: workspace, mcpServers: [] }, remaining(60_000));
    if (!isRecord(response) || typeof response.sessionId !== 'string' || !response.sessionId) throw new Error('Antigravity did not return an authenticated metadata session.');
    sessionId = response.sessionId;
    // Google deliberately schedules this notification after the session/new response is drained.
    // Wait for the actual catalog without submitting a discovery prompt or relying on model loops for timing.
    await Promise.race([commandsReady, runtime.conn.closed, new Promise<void>((resolve) => { commandTimer = setTimeout(resolve, remaining(1500)); commandTimer.unref(); })]);
    clearTimeout(commandTimer);
    const initialModel = configuration(response, 'model')?.currentValue;
    const models = new Map<string, ProviderModel>();
    let parsed = parseAntigravityMetadata(runtime.version, response, commands);
    for (const model of parsed.models) models.set(model.id, model);
    // Native selectors expose reasoning choices for one model at a time. Measure each bounded choice without a prompt.
    for (const choice of choices(configuration(response, 'model')?.options).slice(0, 40)) {
      if (combined.aborted) throw abortError();
      const next = choice.value === initialModel ? response : await runtime.conn.request('session/set_config_option', { sessionId, configId: String(configuration(response, 'model')?.id ?? 'model'), value: choice.value }, remaining(15_000));
      const measured = parseAntigravityMetadata(runtime.version, next, commands);
      const model = measured.models.find((item) => item.id === choice.value);
      if (model) models.set(model.id, model);
    }
    if (typeof initialModel === 'string' && choices(configuration(response, 'model')?.options).length > 1) await runtime.conn.request('session/set_config_option', { sessionId, configId: String(configuration(response, 'model')?.id ?? 'model'), value: initialModel }, remaining(15_000));
    if (combined.aborted) throw abortError();
    parsed = { ...parsed, models: [...models.values()], commands: parseAntigravityMetadata(runtime.version, response, commands).commands };
    rememberAntigravityMetadata(found.executable.path, process.env, parsed);
    markAntigravityAuthenticated(found.executable.path);
    return { id: 'antigravity', name: 'Google Antigravity', available: true, version: runtime.version, executable: found.executable.path,
      reason: `${authenticate ? 'Google sign-in completed' : 'Authenticated model metadata refreshed'}; no model prompt was submitted. Account access and quota are checked again when a run starts.`, models: parsed.models,
      policies: [...new Set(parsed.models.flatMap((model) => model.policies ?? []))] };
  } catch (error) {
    const reason = loginRequired ? 'Google sign-in is required. Use Sign in with Google in Settings; catalog refresh does not open a browser.'
      : combined.aborted ? signal?.aborted ? 'Antigravity setup was canceled.' : `Antigravity ${authenticate ? 'sign-in reached its five-minute' : 'catalog refresh reached its 90-second'} limit. Try again in Settings.` : `Antigravity ${authenticate ? 'sign-in' : 'metadata refresh'} failed: ${safeAntigravityError(error)}`;
    return { id: 'antigravity', name: 'Google Antigravity', available: false, version: runtime?.version ?? null, executable: found.executable.path, reason, models: [] };
  } finally {
    clearTimeout(timer);
    clearTimeout(commandTimer);
    // Preserve the directory if native shutdown fails; an active child may still be using it.
    if (runtime) await closeAntigravity(runtime);
    if (workspace && runtime) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
/** Explicit Settings action: Google owns authentication; Relay launches its native link on the host. */
export function authenticateAntigravity(settings: AppSettings, options: AuthOptions = {}): Promise<ProviderInfo> { return refresh(settings, true, options); }
/** Metadata only: expired native credentials return a sign-in requirement without opening a browser. */
export function probeAuthenticatedAntigravity(settings: AppSettings, options: AuthOptions = {}): Promise<ProviderInfo> { return refresh(settings, false, options); }

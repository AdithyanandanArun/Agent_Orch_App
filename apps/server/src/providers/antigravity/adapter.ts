import { spawn, type SpawnOptions } from 'node:child_process';
import type { AdapterEvent, AgentAdapter, RunOptions } from '@relay/contracts';
import { ProviderError, abortError, isRecord, redactSecrets, truncate } from '../common.js';
import { nativePlanSteps } from '../plans.js';
import { shutdownChild, type ChildLike } from '../process.js';
import { resolveAntigravity, startAntigravity, type AntigravityRuntime } from './runtime.js';
import { AcpRpcError, ACP_METHOD_NOT_FOUND } from './rpc.js';
import { cachedAntigravityMetadata, rememberAntigravityMetadata } from './runtime.js';
import { parseAntigravityMetadata } from './metadata.js';

type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildLike;
export interface AntigravityAdapterDeps { env?: NodeJS.ProcessEnv; spawn?: SpawnFn; timeoutMs?: number }
const defaultSpawn: SpawnFn = (file, args, options) => spawn(file, args, options) as unknown as ChildLike;
const TIMEOUT = { initialize: 12_000, session: 90_000, prompt: 24 * 60 * 60 * 1000, cancel: 4_000 };
const nativeModes: Record<string, string> = { supervised: 'default', balanced: 'auto_edit', 'full-access': 'yolo' };
const SUPPORTED_MODES = new Set(Object.values(nativeModes));
const TEAM_TOOLS = new Set(['team_members', 'team_inbox', 'team_assign', 'team_message', 'team_artifact', 'team_status']);

function obj(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function str(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function safeToolName(value: string): string { return value.replace(/[^\w.-]/g, '_').slice(0, 100) || 'tool'; }
function toolCategory(kind: unknown): 'command' | 'browser' | 'search' | 'file' | 'agent' | 'other' {
  switch (kind) {
    case 'execute': return 'command';
    case 'read': case 'edit': case 'delete': case 'move': return 'file';
    case 'search': return 'search';
    case 'fetch': return 'browser';
    case 'think': return 'agent';
    default: return 'other';
  }
}

export function createAntigravityAdapter(deps: AntigravityAdapterDeps = {}): AgentAdapter {
  const env = deps.env ?? process.env;
  return { async run(options) {
    if (options.signal.aborted) throw abortError();
    if (options.session.serviceTier && options.session.serviceTier !== 'standard') throw new ProviderError(`Antigravity does not expose Relay service tier "${truncate(options.session.serviceTier, 60)}".`, { code: 'unsupported_service_tier' });
    const enabledSkills = (options.skills ?? []).filter((skill) => skill.enabled);
    if (enabledSkills.length) throw new ProviderError('Antigravity ACP does not support Relay-selected skills; disable them before running.', { code: 'unsupported_skills' });
    if (options.browserMcp) options.onEvent({ type: 'info', content: 'Relay browser MCP is not connected to Antigravity ACP; browser tools may be unavailable.' });
    const resolved = await resolveAntigravity(options.settings, env);
    if (!resolved.ok) throw new ProviderError(resolved.reason, { code: 'executable_unavailable' });
    if (options.signal.aborted) throw abortError();
    const spawnFn = deps.spawn ?? defaultSpawn;
    const run = new AntigravityRun(options, resolved.executable.path, env);
    const runtime = await startAntigravity(resolved.executable.path, resolved.executable.companion, {
      env, spawn: spawnFn, cwd: options.session.worktreePath, timeoutMs: deps.timeoutMs ?? TIMEOUT.initialize,
      notification: (method, params) => run.onNotification(method, params),
      request: (method, params) => run.onRequest(method, params),
    });
    run.attach(runtime);
    await run.execute();
  } };
}

class AntigravityRun {
  private sessionId: string | null = null;
  private abortHandler: (() => void) | undefined;
  private doneResolve!: () => void;
  private readonly done = new Promise<void>((resolve) => { this.doneResolve = resolve; });
  private failure: Error | null = null;
  private phase: 'setup' | 'prompt' | 'done' = 'setup';
  private readonly toolSeen = new Set<string>();
  private readonly activeToolIds = new Map<string, string>();
  private selectedModel: string | null = null;
  private emittedSession = false;
  private canceled = false;
  private abortResolve!: () => void;
  private readonly aborted = new Promise<void>((resolve) => { this.abortResolve = resolve; });
  private runtime!: AntigravityRuntime;
  constructor(private readonly options: RunOptions, private readonly executable: string, private readonly env: NodeJS.ProcessEnv) {}
  attach(runtime: AntigravityRuntime): void { this.runtime = runtime; }
  private emit(event: AdapterEvent): void { try { this.options.onEvent(event); } catch { /* provider protocol must outlive UI callbacks */ } }
  private info(content: string): void { this.emit({ type: 'info', content: truncate(redactSecrets(content), 800) }); }
  async execute(): Promise<void> {
    const { conn, capabilities } = this.runtime;
    const mcpCapabilities = obj(capabilities.mcpCapabilities);
    if (this.options.teamMcp && mcpCapabilities.http !== true) throw new ProviderError('Antigravity ACP did not advertise HTTP MCP support; Relay team coordination was not started.', { code: 'mcp_unsupported' });
    this.options.signal.addEventListener('abort', this.abortHandler = () => { void this.cancel(); }, { once: true });
    try {
      const mcpServers = this.mcpServers();
      const meta = { antigravity: { eagerMcpServers: mcpServers.map((server) => server.name), mcpMaxOutputBytes: 64_000 } };
      let selection: unknown;
      const existing = this.options.session.providerSessionId;
      if (existing) {
        if (obj(capabilities.sessionCapabilities).resume) {
          selection = await conn.request('session/resume', { sessionId: existing, cwd: this.options.session.worktreePath, mcpServers, _meta: meta }, TIMEOUT.session);
        } else if (capabilities.loadSession === true) {
          selection = await conn.request('session/load', { sessionId: existing, cwd: this.options.session.worktreePath, mcpServers, _meta: meta }, TIMEOUT.session);
          // Suppress historic events emitted synchronously during load; only live prompt events are shown.
        } else throw new ProviderError('Antigravity ACP cannot resume this native conversation; Relay will not create a replacement thread.', { code: 'resume_unsupported' });
        this.sessionId = existing;
      } else {
        selection = await conn.request('session/new', { cwd: this.options.session.worktreePath, mcpServers, _meta: meta }, TIMEOUT.session);
        if (!isRecord(selection) || typeof selection.sessionId !== 'string' || !selection.sessionId) throw new ProviderError('Antigravity ACP did not return a native session id.', { code: 'protocol_error' });
        this.sessionId = selection.sessionId;
      }
      if (this.options.session.providerSessionId && this.sessionId !== this.options.session.providerSessionId) throw new ProviderError('Antigravity returned a different native conversation id; refusing to switch threads.', { code: 'resume_failed' });
      this.emit({ type: 'session', providerSessionId: this.sessionId }); this.emittedSession = true;
      if (this.options.signal.aborted) throw abortError();
      await this.applySelection(selection);
      const parsed = parseAntigravityMetadata(this.runtime.version, selection);
      const previous = cachedAntigravityMetadata(this.executable, this.env);
      if (!parsed.commands.length && previous) parsed.commands = previous.commands;
      rememberAntigravityMetadata(this.executable, this.env, parsed);
      this.phase = 'prompt';
      const promptRequest = conn.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: this.options.prompt }] }, TIMEOUT.prompt);
      await Promise.race([promptRequest, this.done]);
      await this.done;
      if (this.failure) throw this.failure;
      if (this.options.signal.aborted) throw abortError();
    } catch (error) {
      if (this.options.signal.aborted) throw abortError();
      throw error instanceof ProviderError ? error : new ProviderError(`Antigravity ACP run failed: ${truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 500)}`, { code: 'run_failed', cause: error });
    } finally {
      this.options.signal.removeEventListener('abort', this.abortHandler!);
      this.phase = 'done';
      await shutdownChild(this.runtime.child, { closed: this.runtime.conn.closed, group: process.platform !== 'win32', graceMs: 700, termMs: 1_200, killMs: 1_000 });
    }
  }
  private mcpServers(): Record<string, unknown>[] {
    const servers: Record<string, unknown>[] = [];
    if (this.options.teamMcp) servers.push({ type: 'http', name: 'relay_team', url: this.options.teamMcp.url, headers: [{ name: 'Authorization', value: `Bearer ${this.options.teamMcp.token}` }] });
    // Browser bridge schema is not in the verified ACP boundary, so do not forward it.
    return servers;
  }
  private async applySelection(value: unknown): Promise<void> {
    const record = obj(value);
    const configOptions = Array.isArray(record.configOptions) ? record.configOptions : [];
    let activeOptions = configOptions;
    const modelOption = activeOptions.find((entry) => obj(entry).id === 'model');
    if (this.options.session.model !== 'default') {
      if (!isRecord(modelOption) || !Array.isArray(modelOption.options) || !modelOption.options.some((option) => obj(option).value === this.options.session.model)) throw new ProviderError(`Antigravity does not advertise model "${truncate(this.options.session.model, 100)}" for this session.`, { code: 'unsupported_model' });
      this.selectedModel = this.options.session.model;
      const changed = await this.setConfig('model', this.options.session.model);
      if (Array.isArray(obj(changed).configOptions)) activeOptions = obj(changed).configOptions as unknown[];
    }
    const modeOption = activeOptions.find((entry) => obj(entry).id === 'mode');
    const mode = nativeModes[this.options.session.policy];
    if (!SUPPORTED_MODES.has(mode)) throw new ProviderError(`Antigravity policy "${this.options.session.policy}" is unsupported.`, { code: 'unsupported_policy' });
    if (isRecord(modeOption) && Array.isArray(modeOption.options) && modeOption.options.some((option) => obj(option).value === mode)) await this.setConfig('mode', mode);
    else this.info(`Antigravity did not advertise the ${mode} permission mode; its native mode remains in effect.`);
    if (this.options.session.effort !== 'none') {
      const effortOption = activeOptions.find((entry) => obj(entry).id === 'thinking_level');
      if (!isRecord(effortOption) || !Array.isArray(effortOption.options) || !effortOption.options.some((option) => obj(option).value === this.options.session.effort)) throw new ProviderError(`Antigravity does not advertise reasoning effort "${this.options.session.effort}" for this model.`, { code: 'unsupported_effort' });
      await this.setConfig('thinking_level', this.options.session.effort);
    }
  }
  private async setConfig(configId: string, value: string): Promise<unknown> {
    if (!this.sessionId) return {};
    return this.runtime.conn.request('session/set_config_option', { sessionId: this.sessionId, configId, value }, TIMEOUT.session);
  }
  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    if (this.sessionId && this.phase === 'prompt') { try { this.runtime.conn.notify('session/cancel', { sessionId: this.sessionId }); } catch { /* run cleanup stops the child */ } }
    this.doneResolve();
  }
  private async cancel(): Promise<void> {
    if (this.canceled) return; this.canceled = true;
    this.abortResolve();
    if (this.sessionId) { try { this.runtime.conn.notify('session/cancel', { sessionId: this.sessionId }); } catch { /* shutdown handles it */ } }
    if (this.phase === 'prompt') { const timer = setTimeout(() => this.doneResolve(), TIMEOUT.cancel); timer.unref?.(); }
    else this.doneResolve();
  }
  async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'fs/read_text_file' || method === 'fs/write_text_file' || method === 'terminal/create' || method === 'terminal/output' || method === 'terminal/wait_for_exit' || method === 'terminal/kill' || method === 'terminal/release') throw new AcpRpcError(ACP_METHOD_NOT_FOUND, `Relay does not provide ${method}.`);
    if (method !== 'session/request_permission') throw new AcpRpcError(ACP_METHOD_NOT_FOUND, `Relay does not support ACP client request ${method}.`);
    const req = obj(params); const sessionId = str(req.sessionId); const toolCall = obj(req.toolCall); const id = str(toolCall.toolCallId);
    const options = Array.isArray(req.options) ? req.options.map(obj) : [];
    const allow = options.find((o) => o.kind === 'allow_once'); const reject = options.find((o) => o.kind === 'reject_once');
    const choice = async (allowIt: boolean) => ({ outcome: { outcome: 'selected', optionId: (allowIt ? allow : reject)?.optionId ?? (allowIt ? 'allow_once' : 'reject_once') } });
    if (!this.sessionId || sessionId !== this.sessionId || this.options.signal.aborted || !allow || !reject) return choice(false);
    const name = safeToolName(str(toolCall.title, 'Antigravity tool'));
    const rawInput = obj(toolCall.rawInput);
    const mcp = obj(obj(toolCall.fieldMeta).mcp);
    const trustedTeamTool = this.options.teamMcp !== undefined && mcp.server === 'relay_team' && typeof mcp.tool === 'string' && TEAM_TOOLS.has(mcp.tool);
    const supervised = this.options.session.policy !== 'full-access';
    let permitted = false;
    try { permitted = trustedTeamTool || !supervised ? true : await Promise.race([this.options.requestApproval({ tool: name, description: name, input: rawInput }), this.aborted.then(() => false)]); }
    catch { permitted = false; }
    const result = await choice(permitted);
    if (id) this.finishTool(id, name, permitted ? 'completed' : 'failed', '', rawInput);
    return result;
  }
  private finishTool(id: string, name: string, status: 'running'|'completed'|'failed'|'interrupted', output: string, input: unknown, category: ReturnType<typeof toolCategory> = 'other'): void {
    const providerId = id;
    this.emit({ type: 'tool.activity', activity: { id: providerId, name, category, status, summary: name, input: truncate(JSON.stringify(input ?? {}), 8_000), output: truncate(output, 20_000) } });
  }
  onNotification(method: string, params: unknown): void {
    const data = obj(params); const update = obj(data.update); const kind = str(update.sessionUpdate);
    if (this.phase === 'setup' && kind !== 'available_commands_update') return;
    if (kind === 'agent_message_chunk') {
      const content = obj(update.content); if (typeof content.text === 'string' && this.phase === 'prompt') this.emit({ type: 'text', text: content.text });
    } else if (kind === 'agent_thought_chunk' && typeof obj(update.content).text === 'string') {
      // Reasoning remains provider-private.
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = str(update.toolCallId); const title = str(update.title, 'Antigravity tool'); if (!id) return;
      const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : update.status === 'pending' ? 'running' : 'running';
      const raw = update.rawInput ?? update.rawOutput ?? {};
      this.activeToolIds.set(id, title);
      const output = update.rawOutput ?? {};
      const serverName = str(obj(obj(update.fieldMeta).mcp).server);
      const mcpTool = str(obj(obj(update.fieldMeta).mcp).tool);
      this.finishTool(id, title, status, typeof output === 'string' ? output : JSON.stringify(output), raw,
        serverName === 'relay_team' && TEAM_TOOLS.has(mcpTool) ? 'agent' : toolCategory(update.kind));
    } else if (kind === 'current_mode_update') {
      const mode = str(update.currentModeId); if (mode === 'yolo' && this.options.session.policy !== 'full-access') this.info('Antigravity native mode changed to YOLO during the run; administrative controls may still restrict tools.');
    } else if (kind === 'available_commands_update') {
      // Catalog module consumes the latest provider-reported command set via cache hook.
      this.commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      const current = parseAntigravityMetadata(this.runtime.version, { availableCommands: this.commands });
      const previous = cachedAntigravityMetadata(this.executable, this.env);
      rememberAntigravityMetadata(this.executable, this.env, { ...(previous ?? current), version: this.runtime.version, commands: current.commands });
    } else if (kind === 'usage_update') {
      this.info('Antigravity reported native context-window usage; Relay does not expose this as per-run input/output token totals.');
    } else if (kind === 'plan') {
      const steps = nativePlanSteps(update.entries, 'title'); if (steps) this.emit({ type: 'task.plan', planId: str(update.planId, 'antigravity-plan'), steps });
    } else if (kind === 'config_option_update') {
      const updated = Array.isArray(update.configOptions) ? update.configOptions : [];
      const modelOption = updated.map(obj).find((entry) => entry.id === 'model');
      const current = str(modelOption?.currentValue);
      if (this.selectedModel && current && current !== this.selectedModel) this.fail(new ProviderError(`Antigravity changed the requested model to "${truncate(current, 100)}"; the turn is being canceled.`, { code: 'model_changed' }));
    } else if (kind === 'prompt_completed') {
      this.phase = 'done'; if (update.stopReason === 'error') this.fail(new ProviderError('Antigravity reported a prompt error.', { code: 'prompt_failed' })); else this.doneResolve();
    }
  }
  private commands: unknown[] = [];
}

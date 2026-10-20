import type { AdapterEvent, AgentAdapter, Policy, RunOptions, ToolActivity, ToolCategory } from '@relay/contracts';
import { ProviderError, abortError, isRecord, truncate } from '../common.js';
import { nativePlanSteps } from '../plans.js';
import { AcpRpcError, ACP_INVALID_PARAMS, ACP_METHOD_NOT_FOUND } from './rpc.js';
import {
  NATIVE_EFFORT, NATIVE_VARIANT_DEFAULT, OPENCODE_DEFAULT_MODEL, OPENCODE_POLICIES, choices, configuration, currentValue, nativeEfforts, object, parseNativeCommands,
} from './metadata.js';
import {
  SESSION_ID, closeOpencode, environmentSecrets, opencodeEnvironment, resolveOpencode, safeOpencodeError, safeOpencodeText, startOpencode,
  type OpencodeRuntime, type OpencodeSpawn,
} from './runtime.js';

export interface OpencodeAdapterDeps { env?: NodeJS.ProcessEnv; spawn?: OpencodeSpawn; timeoutMs?: number }
const SESSION_TIMEOUT = 90_000;
const PROMPT_TIMEOUT = 24 * 60 * 60_000;
const CANCEL_DRAIN_MS = 4_000;
const BROWSER_PREFIX = 'relay_browser_';
const TEAM_PREFIX = 'relay_team_';
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const json = (value: unknown, max = 20_000): string => { try { return truncate(typeof value === 'string' ? value : JSON.stringify(value) ?? '', max); } catch { return ''; } };

/**
 * OpenCode's default agent allows every tool without asking, so Relay's permission modes are expressed as OpenCode permission
 * rules supplied through the child's environment for this run only (no config file is written). Later rules win. Reading ordinary
 * files, searching and updating the task list never prompt; secrets-shaped `.env` files, shell, web and every other tool ask in
 * Supervised, and file edits are additionally allowed in Auto-accept edits. Interactive question and plan-mode tools are denied
 * because ACP has no channel for answering them. Full access allows everything.
 */
export function permissionRules(policy: Policy, relay: { browser: boolean; team: boolean }): Record<string, unknown> | null {
  if (!OPENCODE_POLICIES.includes(policy)) return null;
  const denied = { question: 'deny', plan_enter: 'deny', plan_exit: 'deny' };
  const rules: Record<string, unknown> = policy === 'full-access'
    ? { '*': 'allow', ...denied }
    : {
      '*': 'ask',
      read: { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' },
      glob: 'allow', grep: 'allow', list: 'allow', lsp: 'allow', todowrite: 'allow', skill: 'allow', ...denied,
      edit: policy === 'balanced' ? 'allow' : 'ask',
    };
  // Relay's own gateways enforce their own approvals and tab ownership; asking again here would double-prompt.
  if (relay.browser) rules[`${BROWSER_PREFIX}*`] = 'allow';
  if (relay.team) rules[`${TEAM_PREFIX}*`] = 'allow';
  return rules;
}

export function createOpencodeAdapter(deps: OpencodeAdapterDeps = {}): AgentAdapter {
  return { async run(options) {
    if (options.signal.aborted) throw abortError();
    if (options.session.serviceTier && options.session.serviceTier !== 'standard') throw new ProviderError('OpenCode does not expose Relay service tiers. Choose Standard.', { code: 'unsupported_service_tier' });
    if ((options.skills ?? []).length) throw new ProviderError('Relay-selected skills are unavailable for OpenCode. Its native skills appear as slash commands.', { code: 'unsupported_skills' });
    if (!OPENCODE_POLICIES.includes(options.session.policy)) throw new ProviderError('OpenCode supports Supervised, Auto-accept edits and Full access. Auto is unavailable.', { code: 'unsupported_policy' });
    const env = deps.env ?? process.env;
    const resolved = await resolveOpencode(options.settings, env);
    if (!resolved.ok) throw new ProviderError(resolved.reason, { code: 'executable_unavailable' });
    await new OpencodeRun(options, env, resolved.executable.path, deps).execute();
  } };
}

class OpencodeRun {
  private runtime?: OpencodeRuntime;
  private sessionId: string | null = null;
  private phase: 'setup' | 'prompt' | 'done' = 'setup';
  private selected: unknown;
  private expectedModel: string | null = null;
  /** Native variant that was explicitly applied (`default` for Native default); null when the model has no effort selector. */
  private expectedEffort: string | null = null;
  private commands: ReturnType<typeof parseNativeCommands> = [];
  private promptPromise: Promise<unknown> | null = null;
  private readonly tools = new Map<string, ToolActivity>();
  private readonly cancellation = new AbortController();
  private readonly signal: AbortSignal;
  private rejectInterrupted!: (error: Error) => void;
  private readonly interrupted = new Promise<never>((_resolve, reject) => { this.rejectInterrupted = reject; });
  private violation: Error | null = null;
  private readonly secrets: (string | undefined)[];
  private readonly onAbort = (): void => { this.cancelNative(); this.rejectInterrupted(abortError()); };

  constructor(private readonly options: RunOptions, private readonly env: NodeJS.ProcessEnv, private readonly executable: string, private readonly deps: OpencodeAdapterDeps) {
    this.signal = AbortSignal.any([options.signal, this.cancellation.signal]);
    this.interrupted.catch(() => undefined);
    this.secrets = [options.browserMcp?.token, options.teamMcp?.token, ...environmentSecrets(env)];
  }
  private emit(event: AdapterEvent): void {
    const scrub = (value: unknown): unknown => typeof value === 'string' ? safeOpencodeText(value, this.secrets)
      : Array.isArray(value) ? value.map(scrub)
        : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry)])) : value;
    try { this.options.onEvent(scrub(event) as AdapterEvent); } catch { /* A host listener cannot break the provider protocol. */ }
  }
  private info(content: string): void { this.emit({ type: 'info', content: truncate(content, 1200) }); }
  private race<T>(promise: Promise<T>): Promise<T> { return Promise.race([promise, this.interrupted]); }
  private cancelNative(): void {
    if (!this.runtime || !this.sessionId || this.phase === 'done') return;
    try { this.runtime.conn.notify('session/cancel', { sessionId: this.sessionId }); } catch { /* Process cleanup remains authoritative. */ }
  }
  private fail(message: string, code: string): void {
    if (this.violation || this.phase === 'done') return;
    this.violation = new ProviderError(message, { code });
    this.cancelNative();
    this.rejectInterrupted(this.violation);
    this.cancellation.abort();
  }

  async execute(): Promise<void> {
    const { session, browserMcp, teamMcp } = this.options;
    this.options.signal.addEventListener('abort', this.onAbort, { once: true });
    try {
      if (this.signal.aborted) throw abortError();
      const rules = permissionRules(session.policy, { browser: Boolean(browserMcp), team: Boolean(teamMcp) });
      const childEnv = opencodeEnvironment(this.env, rules ?? undefined);
      // The generated server password must never reach persisted tool output, even if a tool prints its environment.
      this.secrets.push(...environmentSecrets(childEnv));
      this.runtime = await startOpencode(this.executable, {
        env: childEnv, cwd: session.worktreePath, timeoutMs: this.deps.timeoutMs ?? 20_000, signal: this.signal,
        ...(this.deps.spawn ? { spawn: this.deps.spawn } : {}), secrets: this.secrets,
        notification: (method, params) => this.onNotification(method, params), request: (method, params) => this.onRequest(method, params),
      });
      const { conn, capabilities } = this.runtime;
      const connections = [browserMcp && { name: 'relay_browser', ...browserMcp }, teamMcp && { name: 'relay_team', ...teamMcp }]
        .filter((value): value is { name: string; url: string; token: string } => Boolean(value));
      if (connections.length && object(capabilities.mcpCapabilities).http !== true) {
        throw new ProviderError('The selected OpenCode runtime did not advertise HTTP MCP support. Relay browser and team tools cannot be connected; no prompt was sent.', { code: 'mcp_unsupported' });
      }
      // Per-session ACP registration keeps the capability in this child's memory only; nothing is written to OpenCode configuration.
      const mcpServers = connections.map((connection) => ({ type: 'http', name: connection.name, url: connection.url, headers: [{ name: 'Authorization', value: `Bearer ${connection.token}` }] }));
      const params = { cwd: session.worktreePath, mcpServers };
      const existing = session.providerSessionId;
      if (existing) {
        if (!SESSION_ID.test(existing)) throw new ProviderError('The stored conversation ID is not a valid OpenCode session ID. Relay will not start a replacement conversation.', { code: 'resume_failed' });
        this.sessionId = existing;
        const method = object(capabilities.sessionCapabilities).resume ? 'session/resume' : capabilities.loadSession === true ? 'session/load' : null;
        if (!method) throw new ProviderError('This OpenCode runtime cannot resume the selected native conversation. Relay will not create a replacement.', { code: 'resume_unsupported' });
        try { this.selected = await this.race(conn.request(method, { ...params, sessionId: existing }, SESSION_TIMEOUT)); }
        catch (error) {
          if (error instanceof ProviderError || this.signal.aborted) throw error;
          throw new ProviderError(`OpenCode could not resume conversation ${truncate(existing, 80)} (${safeOpencodeError(error, this.secrets, 200)}). It may have been deleted or belong to a different OpenCode data directory. Relay will not start a replacement conversation.`, { code: 'resume_failed', cause: error });
        }
        const returned = object(this.selected).sessionId;
        if (returned !== undefined && returned !== existing) throw new ProviderError('OpenCode returned a different conversation ID. The run was stopped.', { code: 'resume_failed' });
      } else {
        this.selected = await this.race(conn.request('session/new', params, SESSION_TIMEOUT));
        const id = object(this.selected).sessionId;
        if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new ProviderError('OpenCode did not return a valid native conversation ID.', { code: 'protocol_error' });
        this.sessionId = id;
      }
      if (this.signal.aborted) throw abortError();
      this.emit({ type: 'session', providerSessionId: this.sessionId! });
      await this.applySelection();
      if (session.model === OPENCODE_DEFAULT_MODEL) this.info(`OpenCode selected its native default model: ${this.expectedModel}.`);
      const mode = currentValue(this.selected, 'mode');
      if (mode && mode !== 'build') this.info(`OpenCode is using its "${mode}" agent mode from your OpenCode configuration.`);
      if (this.options.settings.autoCompactPercent != null) this.info('Relay’s automatic compaction threshold is not exposed by OpenCode ACP. OpenCode’s native compaction remains in effect.');
      this.announceSlashCommand();
      this.phase = 'prompt';
      const prompt = conn.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: this.options.prompt }] }, PROMPT_TIMEOUT);
      prompt.catch(() => undefined);
      this.promptPromise = prompt;
      const response: unknown = await this.race(prompt);
      if (this.violation) throw this.violation;
      if (this.signal.aborted) throw abortError();
      this.reportUsage(response);
      const reason = object(response).stopReason;
      if (reason === 'cancelled') throw new ProviderError('OpenCode canceled the turn without a Relay interruption.', { code: 'turn_interrupted' });
      if (reason === 'max_tokens' || reason === 'max_turn_requests') throw new ProviderError(`OpenCode stopped at its ${reason === 'max_tokens' ? 'token' : 'turn'} limit. Partial output was retained.`, { code: 'turn_limit' });
      if (reason !== 'end_turn' && reason !== 'refusal') throw new ProviderError('OpenCode returned an unrecognized completion state.', { code: 'protocol_error' });
    } catch (error) {
      if (this.violation) throw this.violation;
      if (this.options.signal.aborted) {
        // Give OpenCode a moment to stop its own tool processes cleanly; the process group is terminated regardless below.
        if (this.promptPromise) await Promise.race([this.promptPromise.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, CANCEL_DRAIN_MS).unref())]);
        throw abortError();
      }
      const detail = safeOpencodeError(error, this.secrets);
      const authShaped = error instanceof AcpRpcError && error.code === -32000 || /unauthori[sz]ed|\b401\b|api[ _-]?key|authenticat|not logged in|no credentials/i.test(detail);
      throw new ProviderError(`OpenCode ACP: ${detail}${authShaped ? ' Check the provider sign-in with `opencode providers login` in a terminal; OpenCode owns its credentials and Relay does not manage them.' : ''}`, {
        code: error instanceof ProviderError ? error.code : authShaped ? 'authentication_required' : 'opencode_failed', cause: error,
      });
    } finally {
      const finishing = this.phase;
      this.phase = 'done';
      this.options.signal.removeEventListener('abort', this.onAbort);
      if (this.runtime) {
        if (finishing === 'prompt' && this.sessionId && !this.signal.aborted) {
          await this.runtime.conn.request('session/close', { sessionId: this.sessionId }, 3_000).catch(() => undefined);
        }
        await closeOpencode(this.runtime);
      }
    }
  }

  private async setConfig(id: string, value: string): Promise<void> {
    if (this.signal.aborted) throw abortError();
    const response = await this.race(this.runtime!.conn.request('session/set_config_option', { sessionId: this.sessionId, configId: id, value }, SESSION_TIMEOUT));
    if (!Array.isArray(object(response).configOptions)) throw new ProviderError('OpenCode did not confirm its effective configuration.', { code: 'protocol_error' });
    this.selected = { ...object(this.selected), ...object(response) };
  }

  /** Applies the session's model and effort through native config selectors and verifies each one before any prompt is sent. */
  private async applySelection(): Promise<void> {
    const wanted = this.options.session;
    if (wanted.model !== OPENCODE_DEFAULT_MODEL) {
      const model = configuration(this.selected, 'model');
      if (!model || !choices(model.options).some((choice) => choice.value === wanted.model)) {
        throw new ProviderError(`OpenCode does not offer model "${truncate(wanted.model, 150)}" in this folder. Choose another model or Refresh providers in Settings; no fallback model was used.`, { code: 'unsupported_model' });
      }
      if (currentValue(this.selected, 'model') !== wanted.model) await this.setConfig(String(model.id), wanted.model);
      if (currentValue(this.selected, 'model') !== wanted.model) throw new ProviderError('OpenCode did not select the requested model. No prompt was sent.', { code: 'unsupported_model' });
    }
    this.expectedModel = currentValue(this.selected, 'model');
    if (!this.expectedModel) throw new ProviderError('OpenCode did not report its effective model. No prompt was sent.', { code: 'protocol_error' });
    const effort = configuration(this.selected, 'effort');
    if (wanted.effort === NATIVE_EFFORT) {
      // OpenCode reports its first variant as "current" even when none is selected, so the native default is always applied explicitly.
      if (effort && choices(effort.options).some((choice) => choice.value === NATIVE_VARIANT_DEFAULT)) {
        await this.setConfig(String(effort.id), NATIVE_VARIANT_DEFAULT);
        if (currentValue(this.selected, 'effort') !== NATIVE_VARIANT_DEFAULT) throw new ProviderError('OpenCode did not restore the native default reasoning variant. No prompt was sent.', { code: 'unsupported_effort' });
        this.expectedEffort = NATIVE_VARIANT_DEFAULT;
      }
    } else {
      const target = nativeEfforts(this.selected).find((item) => item.id === wanted.effort);
      if (!effort || !target) throw new ProviderError(`OpenCode does not offer reasoning effort "${wanted.effort}" for ${this.expectedModel}. Choose Native default or Refresh providers in Settings.`, { code: 'unsupported_effort' });
      await this.setConfig(String(effort.id), target.native);
      if (currentValue(this.selected, 'effort') !== target.native) throw new ProviderError('OpenCode did not confirm the requested reasoning effort. No prompt was sent.', { code: 'unsupported_effort' });
      this.expectedEffort = target.native;
    }
    if (currentValue(this.selected, 'model') !== this.expectedModel) throw new ProviderError('OpenCode changed the selected model while applying configuration. No prompt was sent.', { code: 'model_substitution' });
  }

  private announceSlashCommand(): void {
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_.:-]*)(?:\s|$)/.exec(this.options.prompt.trimStart());
    if (!match) return;
    if (this.commands.some((command) => command.name === match[1])) this.info(`Running OpenCode command /${match[1]}.`);
    else if (this.commands.length) this.info(`/${match[1]} is not a command OpenCode advertises over ACP, so it is sent to the model as ordinary text.`);
  }

  private reportUsage(response: unknown): void {
    const usage = object(object(response).usage);
    const input = usage.inputTokens;
    const output = usage.outputTokens;
    if (typeof input === 'number' && typeof output === 'number' && Number.isFinite(input) && Number.isFinite(output)) {
      this.emit({ type: 'usage', inputTokens: input, outputTokens: output, costUsd: null });
    }
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== 'session/request_permission') throw new AcpRpcError(ACP_METHOD_NOT_FOUND, `Relay does not provide ACP client method ${method}.`);
    const data = object(params);
    const call = object(data.toolCall);
    const cancelled = { outcome: { outcome: 'cancelled' } };
    if (this.phase !== 'prompt' || this.signal.aborted) return cancelled;
    if (data.sessionId !== this.sessionId) throw new AcpRpcError(ACP_INVALID_PARAMS, 'This permission request belongs to another session.');
    const options = Array.isArray(data.options) ? data.options.map(object) : [];
    const allow = options.find((option) => option.kind === 'allow_once' && typeof option.optionId === 'string');
    const reject = options.find((option) => option.kind === 'reject_once' && typeof option.optionId === 'string');
    if (!reject) return cancelled;
    const name = text(call.name) ?? '';
    const trusted = Boolean((this.options.browserMcp && name.startsWith(BROWSER_PREFIX)) || (this.options.teamMcp && name.startsWith(TEAM_PREFIX)));
    let approved = trusted;
    if (!approved && allow) {
      const title = text(call.title) ?? name ?? 'OpenCode tool';
      const locations = Array.isArray(call.locations) ? call.locations.flatMap((entry) => text(object(entry).path) ? [String(object(entry).path)] : []).slice(0, 10) : [];
      try {
        approved = await Promise.race([
          this.options.requestApproval({ tool: truncate(name || text(call.kind) || 'OpenCode tool', 200), description: truncate(title, 1000), input: { ...object(call.rawInput), ...(locations.length ? { locations } : {}) } }),
          this.interrupted.catch(() => false),
        ]);
      } catch { approved = false; }
    }
    if (this.signal.aborted) return cancelled;
    // Never grant a durable native "always" rule, and never infer tool completion from an approval decision.
    return { outcome: { outcome: 'selected', optionId: approved && allow ? allow.optionId : reject.optionId } };
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || this.phase === 'done') return;
    const data = object(params);
    const update = object(data.update);
    if (this.sessionId && data.sessionId !== this.sessionId) return;
    const kind = update.sessionUpdate;
    if (kind === 'available_commands_update' && Array.isArray(update.availableCommands)) { this.commands = parseNativeCommands(update.availableCommands); return; }
    if (this.phase !== 'prompt' || this.signal.aborted) return; // In particular, suppress native history replay while loading.
    if (kind === 'agent_message_chunk' && object(update.content).type === 'text' && typeof object(update.content).text === 'string') this.emit({ type: 'text', text: String(object(update.content).text) });
    else if (kind === 'tool_call' || kind === 'tool_call_update') this.tool(update);
    else if (kind === 'plan') {
      const steps = nativePlanSteps(update.entries, 'content');
      if (steps) this.emit({ type: 'task.plan', planId: 'opencode-plan', replace: true, steps });
    } else if (kind === 'config_option_update') {
      const model = currentValue({ configOptions: update.configOptions }, 'model');
      if (model && model !== this.expectedModel) this.fail('OpenCode changed the selected model during the run. Relay stopped the turn rather than accepting an automatic substitution.', 'model_substitution');
      else if (this.expectedEffort && currentValue({ configOptions: update.configOptions }, 'effort') !== this.expectedEffort) {
        this.fail('OpenCode changed the selected reasoning effort during the run. Relay stopped the turn rather than continuing with a different variant.', 'effort_substitution');
      }
    }
    // Reasoning chunks are provider-private. usage_update.used is context size, not token usage.
  }

  private tool(update: Record<string, unknown>): void {
    const id = text(update.toolCallId);
    if (!id || id.length > 200) return;
    const prior = this.tools.get(id);
    const title = text(update.title) ?? prior?.summary ?? 'OpenCode tool';
    const nativeName = text(update.name) ?? prior?.name ?? title;
    const input = update.rawInput;
    const raw = object(input);
    const output = object(update.rawOutput);
    const metadata = object(output.metadata);
    let category: ToolCategory = prior?.category ?? 'other';
    if (nativeName.startsWith(TEAM_PREFIX)) category = 'agent';
    else if (nativeName.startsWith(BROWSER_PREFIX)) category = 'browser';
    else if (update.kind === 'execute') category = 'command';
    else if (update.kind === 'search' || update.kind === 'fetch') category = 'search';
    else if (['read', 'edit', 'delete', 'move'].includes(String(update.kind))) category = 'file';
    else if (update.kind === 'think') category = 'agent';
    const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : update.status === 'pending' || update.status === 'in_progress' ? 'running' : prior?.status ?? 'running';
    const activity: ToolActivity = { ...prior, id, name: nativeName, category, status, summary: truncate(title, 1000) };
    if (input !== undefined) activity.input = json(input, 8000);
    const content = Array.isArray(update.content)
      ? update.content.flatMap((entry) => { const value = object(object(entry).content); return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []; }).join('\n')
      : '';
    const result = content || text(output.output) || text(metadata.output) || text(output.error);
    if (result) activity.output = truncate(result, 20_000);
    const command = text(raw.command) ?? text(raw.cmd);
    const cwd = text(raw.cwd) ?? text(raw.workdir);
    const exitCode = metadata.exit ?? metadata.exitCode ?? output.exitCode ?? output.exit;
    if (command && category === 'command') activity.command = truncate(command, 4000);
    if (cwd) activity.cwd = truncate(cwd, 4096);
    if (typeof exitCode === 'number' && Number.isFinite(exitCode)) activity.exitCode = exitCode;
    this.tools.set(id, activity);
    this.emit({ type: 'tool.activity', activity });
  }
}

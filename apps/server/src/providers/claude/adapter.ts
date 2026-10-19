import type { AgentAdapter, AppSettings, RunOptions } from '@relay/contracts';
import type { Options, PermissionResult, Query } from '@anthropic-ai/claude-agent-sdk';
import { ProviderError, TextTail, abortError, cleanEnv, errorMessage, isAbortError, redactSecrets } from '../common.js';
import { bundledClaudeCandidates, resolveExecutableCached, type ResolveResult } from '../discovery.js';
import { ClaudeMessageMapper, claudePermissionMode, describeToolUse, previewInput } from './messages.js';

export type QueryFn = (params: { prompt: string; options: Options }) => Query | AsyncGenerator<unknown, void>;

export interface ClaudeAdapterDeps {
  query?: QueryFn;
  env?: NodeJS.ProcessEnv;
  resolveExecutable?: (settings: AppSettings, env: NodeJS.ProcessEnv) => Promise<ResolveResult>;
}

/** Credentials that would let Claude Code authenticate some way other than the API key Relay requires. */
export const CLAUDE_STRIPPED_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'];

export function resolveClaudeExecutable(settings: AppSettings, env: NodeJS.ProcessEnv): Promise<ResolveResult> {
  return resolveExecutableCached({ name: 'claude', override: settings.claudeExecutable, env, extraCandidates: bundledClaudeCandidates() });
}

async function loadSdkQuery(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as QueryFn;
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): AgentAdapter {
  const env = deps.env ?? process.env;
  const resolveBinary = deps.resolveExecutable ?? resolveClaudeExecutable;
  return {
    async run(run: RunOptions): Promise<void> {
      const { session, prompt, signal, onEvent, requestApproval, settings } = run;
      if (signal.aborted) throw abortError();
      const apiKey = env.ANTHROPIC_API_KEY?.trim();
      if (!apiKey) {
        throw new ProviderError('ANTHROPIC_API_KEY is not set in the Relay server environment. Relay runs Claude with API-key authentication only and does not use claude.ai subscription login.', { code: 'missing_api_key' });
      }
      const resolved = await resolveBinary(settings, env);
      if (!resolved.ok) throw new ProviderError(resolved.reason, { code: 'executable_unavailable' });
      if (signal.aborted) throw abortError();

      const stderr = new TextTail();
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });

      // Never allow a tool call to proceed on an approval that has not been answered, and never past an abort.
      const canUseTool = async (toolName: string, input: Record<string, unknown>, context: { signal: AbortSignal; title?: string }): Promise<PermissionResult> => {
        if (signal.aborted || context.signal.aborted) return { behavior: 'deny', message: 'The run was interrupted.', interrupt: true };
        if (toolName === 'AskUserQuestion') {
          return { behavior: 'deny', message: 'Interactive questions are not available in this environment. Continue with your best judgement and note any assumptions in your reply.' };
        }
        const aborted = new Promise<false>((resolve) => {
          const done = (): void => resolve(false);
          if (context.signal.aborted || signal.aborted) done();
          context.signal.addEventListener('abort', done, { once: true });
          signal.addEventListener('abort', done, { once: true });
        });
        let approved = false;
        try {
          approved = (await Promise.race([
            requestApproval({ tool: toolName, description: describeToolUse(toolName, input, context.title), input: previewInput(input) }),
            aborted,
          ])) === true;
        } catch {
          approved = false; // fail closed
        }
        if (signal.aborted) return { behavior: 'deny', message: 'The run was interrupted.', interrupt: true };
        return approved
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'The user denied this tool call. Do not retry it; continue without it or explain what is blocked.' };
      };

      const options: Options = {
        cwd: session.worktreePath,
        model: session.model,
        effort: session.effort,
        permissionMode: claudePermissionMode(session.policy),
        canUseTool,
        includePartialMessages: true,
        abortController: controller,
        pathToClaudeCodeExecutable: resolved.executable.path,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'],
        settings: { disableAllHooks: true },
        env: { ...cleanEnv(env, CLAUDE_STRIPPED_ENV), ANTHROPIC_API_KEY: apiKey, CLAUDE_AGENT_SDK_CLIENT_APP: 'relay/0.1.0' },
        stderr: (data: string) => stderr.push(data),
        ...(session.providerSessionId ? { resume: session.providerSessionId } : {}),
      };

      const mapper = new ClaudeMessageMapper(session.model, (event) => {
        try { onEvent(event); } catch { /* host listener errors must not break the stream */ }
      });
      let stream: Query | AsyncGenerator<unknown, void> | undefined;
      try {
        const query = deps.query ?? (await loadSdkQuery());
        stream = query({ prompt, options });
        for await (const message of stream) {
          mapper.handle(message);
          if (signal.aborted) break;
        }
        if (signal.aborted) throw abortError();
        if (!mapper.finished) {
          const detail = stderr.summary(1_200, [apiKey]);
          throw new ProviderError(`Claude Code ended without a result.${detail ? ` stderr: ${detail}` : ''}`, { code: 'no_result' });
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw abortError();
        if (error instanceof ProviderError) throw error;
        const detail = stderr.summary(1_200, [apiKey]);
        throw new ProviderError(`${redactSecrets(errorMessage(error), [apiKey])}${detail ? ` — stderr: ${detail}` : ''}`, { code: 'claude_failed', cause: error });
      } finally {
        signal.removeEventListener('abort', onAbort);
        try { (stream as Query | undefined)?.close?.(); } catch { /* process already closed */ }
      }
    },
  };
}

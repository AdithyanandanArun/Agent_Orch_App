import type { AdapterEvent, AgentAdapter, AppSettings, RunOptions } from '@relay/contracts';
import type { Options, PermissionResult, Query } from '@anthropic-ai/claude-agent-sdk';
import { ProviderError, TextTail, abortError, errorMessage, isAbortError, isRecord, redactSecrets } from '../common.js';
import { bundledClaudeCandidates, resolveExecutableCached, type ResolveResult } from '../discovery.js';
import { ClaudeMessageMapper, claudePermissionMode, describeToolUse, previewInput } from './messages.js';
import { claudeEnvironment } from './auth.js';
import { autoCompactPercent, claudeCompactEnv, describeClaudeCompaction } from '../compaction.js';

export type QueryFn = (params: { prompt: string; options: Options }) => Query | AsyncGenerator<unknown, void>;

export interface ClaudeAdapterDeps {
  query?: QueryFn;
  env?: NodeJS.ProcessEnv;
  resolveExecutable?: (settings: AppSettings, env: NodeJS.ProcessEnv) => Promise<ResolveResult>;
}

export function resolveClaudeExecutable(settings: AppSettings, env: NodeJS.ProcessEnv): Promise<ResolveResult> {
  return resolveExecutableCached({ name: 'claude', override: settings.claudeExecutable, env, extraCandidates: bundledClaudeCandidates() });
}

function promptWithSelectedClaudeSkill(prompt: string, skillName: string): string {
  const escapedName = skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let body = prompt.replace(new RegExp(`(^|\\s)\\$${escapedName}(?=$|\\s)`, 'g'), '$1');
  body = body.replace(new RegExp(`^/\\$${escapedName}(?=$|\\s)`), '').trim();
  if (!body) return `/${skillName}`;
  if (new RegExp(`^/${escapedName}(?=$|\\s)`).test(body)) return body;
  return `/${skillName} ${body}`;
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
      const { session, signal, onEvent, requestApproval, settings } = run;
      if (signal.aborted) throw abortError();
      const selectedSkills = run.skills ?? [];
      if (selectedSkills.length > 1) {
        throw new ProviderError('Claude sessions can dispatch one selected skill per run. Choose a single skill or clear the selection.', { code: 'multiple_skills_unsupported' });
      }
      const selectedSkill = selectedSkills[0];
      const selectedSkillName = selectedSkill?.name.replace(/^\/+/, '');
      if (selectedSkill && (!selectedSkill.enabled || selectedSkill.source === 'user' || !selectedSkillName || !/^[A-Za-z0-9_.:-]+$/.test(selectedSkillName))) {
        throw new ProviderError('The selected Claude skill is unavailable or has an invalid name. Refresh the provider catalog and select a listed project skill.', { code: 'invalid_skill' });
      }
      const prompt = selectedSkillName ? promptWithSelectedClaudeSkill(run.prompt, selectedSkillName) : run.prompt;
      if (session.effort !== 'none' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(session.effort)) {
        throw new ProviderError(`Claude does not support reasoning effort "${session.effort}". Refresh the model capabilities and choose a listed effort.`, { code: 'unsupported_effort' });
      }
      if (session.serviceTier && !['standard', 'fast'].includes(session.serviceTier)) {
        throw new ProviderError(`Claude does not support service tier "${session.serviceTier}".`, { code: 'unsupported_service_tier' });
      }
      const compactPercent = autoCompactPercent(settings);
      const childEnv = { ...claudeEnvironment(env), ...claudeCompactEnv(compactPercent) };
      const secrets = [childEnv.ANTHROPIC_API_KEY, childEnv.CLAUDE_CODE_OAUTH_TOKEN, childEnv.ANTHROPIC_AUTH_TOKEN];
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
        ...(session.effort !== 'none' ? { effort: session.effort as NonNullable<Options['effort']> } : {}),
        permissionMode: claudePermissionMode(session.policy),
        ...(session.policy === 'full-access' ? { allowDangerouslySkipPermissions: true } : {}),
        canUseTool,
        includePartialMessages: true,
        abortController: controller,
        pathToClaudeCodeExecutable: resolved.executable.path,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'],
        settings: { disableAllHooks: true, fastMode: session.serviceTier === 'fast' },
        ...(selectedSkillName ? { skills: [selectedSkillName] } : {}),
        env: { ...childEnv, CLAUDE_AGENT_SDK_CLIENT_APP: 'relay/0.1.0' },
        stderr: (data: string) => stderr.push(data),
        ...(session.providerSessionId ? { resume: session.providerSessionId } : {}),
      };

      const emit = (event: AdapterEvent): void => {
        try { onEvent(event); } catch { /* host listener errors must not break the stream */ }
      };
      const mapper = new ClaudeMessageMapper(session.model, emit);
      let stream: Query | AsyncGenerator<unknown, void> | undefined;
      try {
        const query = deps.query ?? (await loadSdkQuery());
        stream = query({ prompt, options });
        if (session.serviceTier === 'fast' && typeof (stream as Query).initializationResult === 'function') {
          const initialized = await (stream as Query).initializationResult();
          if (initialized.fast_mode_state !== 'on') {
            const reason = initialized.fast_mode_disabled_reason ? ` (${initialized.fast_mode_disabled_reason})` : '';
            throw new ProviderError(`Claude Code could not enable requested fast mode${reason}.`, { code: 'fast_mode_unavailable' });
          }
        }
        for await (const message of stream) {
          if (session.providerSessionId && isRecord(message) && message.type === 'system' && message.subtype === 'init' && !message.parent_tool_use_id &&
            typeof message.session_id === 'string' && message.session_id !== session.providerSessionId) {
            controller.abort();
            throw new ProviderError('Claude resumed a different conversation. Relay stopped the run to preserve the selected conversation.', { code: 'resume_failed' });
          }
          const compaction = describeClaudeCompaction(message, compactPercent);
          if (compaction) emit({ type: 'info', content: compaction });
          mapper.handle(message);
          if (signal.aborted) break;
        }
        if (signal.aborted) throw abortError();
        if (!mapper.finished) {
          const detail = stderr.summary(1_200, secrets);
          throw new ProviderError(`Claude Code ended without a result.${detail ? ` stderr: ${detail}` : ''}`, { code: 'no_result' });
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw abortError();
        if (error instanceof ProviderError) throw new ProviderError(redactSecrets(error.message, secrets), { code: error.code, cause: error });
        const detail = stderr.summary(1_200, secrets);
        throw new ProviderError(`${redactSecrets(errorMessage(error), secrets)}${detail ? ` — stderr: ${detail}` : ''}`, { code: 'claude_failed', cause: error });
      } finally {
        signal.removeEventListener('abort', onAbort);
        try { (stream as Query | undefined)?.close?.(); } catch { /* process already closed */ }
      }
    },
  };
}

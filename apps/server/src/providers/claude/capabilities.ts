import { tmpdir } from 'node:os';
import type { AppSettings, Policy, ProviderModel } from '@relay/contracts';
import { query, type ModelInfo, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeExecutable } from './adapter.js';
import { claudeEnvironment } from './auth.js';

/** Provider-wide policies with a direct native Claude Code mode mapping. */
export const CLAUDE_POLICIES: Policy[] = ['supervised', 'balanced', 'auto', 'full-access'];

/** Permission policies that Claude Code can enforce through its native Agent SDK modes. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

async function* noPrompt(): AsyncGenerator<SDKUserMessage, void, unknown> {
  // An empty async stream lets Claude Code initialize metadata without sending a user turn.
}

export async function queryWithoutPrompt(settings: AppSettings, cwd: string, model = settings.defaultClaudeModel): Promise<Query> {
  const resolved = await resolveClaudeExecutable(settings, process.env);
  if (!resolved.ok) throw new Error(resolved.reason);
  const abortController = new AbortController();
  const options: Options = {
    cwd,
    model,
    permissionMode: 'default',
    abortController,
    pathToClaudeCodeExecutable: resolved.executable.path,
    settingSources: ['project'],
    settings: { disableAllHooks: true },
    env: { ...claudeEnvironment(process.env), CLAUDE_AGENT_SDK_CLIENT_APP: 'relay/0.1.0' },
  };
  return query({ prompt: noPrompt(), options });
}

/** Map the SDK's live model catalog to Relay metadata without advertising unsupported controls. */
export function claudeModelsFromSdk(models: ModelInfo[]): ProviderModel[] {
  return models.flatMap((model) => {
    const id = model.value.trim();
    if (!id) return [];
    const sdkEfforts = model.supportedEffortLevels?.filter((effort) => (EFFORTS as readonly string[]).includes(effort));
    const supportedEfforts = sdkEfforts ?? ['low', 'medium', 'high'];
    const reasoningEfforts = model.supportsEffort === false
      ? []
      : supportedEfforts.map((effort) => ({ id: effort, label: effort }));
    const serviceTiers = [
      { id: 'standard', name: 'Standard' },
      ...(model.supportsFastMode ? [{ id: 'fast', name: 'Fast', description: 'Claude Code fast mode; account and usage availability is checked by Claude at run time.' }] : []),
    ];
    const policies: Policy[] = ['supervised', 'balanced', 'full-access', ...(model.supportsAutoMode ? ['auto' as const] : [])];
    return [{
      id,
      name: model.displayName || id,
      ...(model.resolvedModel && model.resolvedModel !== id ? { aliases: [model.resolvedModel] } : {}),
      reasoningEfforts,
      ...(model.supportsEffort === false ? { defaultReasoningEffort: 'none' } : {}),
      policies,
      serviceTiers,
      defaultServiceTier: 'standard',
    }];
  });
}

/** Probe Claude Code's own available model catalog without issuing a user prompt. */
export async function probeClaudeModels(settings: AppSettings): Promise<ProviderModel[]> {
  const activeQuery = await queryWithoutPrompt(settings, tmpdir());
  const timeout = setTimeout(() => activeQuery.close(), 15_000);
  timeout.unref?.();
  try {
    return claudeModelsFromSdk(await activeQuery.supportedModels());
  } finally {
    clearTimeout(timeout);
    activeQuery.close();
  }
}

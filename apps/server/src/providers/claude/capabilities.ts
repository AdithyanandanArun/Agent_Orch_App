import { tmpdir } from 'node:os';
import type { AppSettings, Policy, ProviderModel } from '@relay/contracts';
import { query, type ModelInfo, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeExecutable } from './adapter.js';
import { claudeEnvironment } from './auth.js';

/** Provider-wide policies with a direct native Claude Code mode mapping. */
export const CLAUDE_POLICIES: Policy[] = ['supervised', 'balanced', 'auto', 'full-access'];

/** Effort values accepted by Claude Code's Agent SDK. */
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

/** Run one metadata-only query with a hard deadline and close its CLI process on every exit path. */
export async function withClaudeMetadataQuery<T>(
  settings: AppSettings,
  cwd: string,
  model: string,
  read: (activeQuery: Query) => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  let activeQuery: Query | undefined;
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      try { activeQuery?.close(); } catch { /* deadline still rejects when teardown fails */ }
      reject(new Error(`Claude metadata discovery exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  try {
    const startedQuery = queryWithoutPrompt(settings, cwd, model).then((query) => {
      activeQuery = query;
      if (timedOut) query.close();
      return query;
    });
    const query = await Promise.race([startedQuery, deadline]);
    return await Promise.race([read(query), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    try { activeQuery?.close(); } catch { /* process already closed */ }
  }
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
  return withClaudeMetadataQuery(settings, tmpdir(), settings.defaultClaudeModel, async (activeQuery) =>
    claudeModelsFromSdk((await activeQuery.supportedModels()).slice(0, 500)));
}

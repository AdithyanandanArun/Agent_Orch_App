import type { Policy, Provider, ProviderInfo } from '@relay/contracts';
import { badRequest } from './util.ts';

export interface RunConfig {
  provider: Provider; model: string; effort: string; policy: Policy; serviceTier?: string;
}
type Explicit = Partial<Record<'effort' | 'policy' | 'serviceTier', boolean>>;

/** Resolve inherited defaults against model capabilities; explicit unsupported choices always fail. */
export function resolveRunConfig(info: ProviderInfo | undefined, config: RunConfig, explicit: Explicit = {}): RunConfig & { serviceTier: string } {
  const model = info?.models.find((row) => row.id === config.model || row.aliases?.includes(config.model));
  const efforts = model?.reasoningEfforts?.map((row) => row.id) ?? (config.provider === 'antigravity' ? ['none'] : ['low', 'medium', 'high']);
  // A model can explicitly advertise no reasoning control.
  if (!efforts.length) efforts.push('none');
  const defaultEffort = model?.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort : efforts.includes('high') ? 'high' : efforts[0]!;
  let effort = config.effort;
  if (!efforts.includes(effort)) {
    if (explicit.effort) throw badRequest(`Effort "${effort}" is not supported by ${config.model}. Choose a supported effort or refresh providers.`);
    effort = defaultEffort;
  }
  const policies = model?.policies ?? info?.policies ?? (config.provider === 'antigravity' ? ['supervised'] : ['supervised', 'balanced']);
  let policy = config.policy;
  if (!policies.includes(policy)) {
    if (explicit.policy) throw badRequest(`Permission mode "${policy}" is not supported by ${config.model}. Choose a supported mode or refresh providers.`);
    policy = policies.includes('supervised') ? 'supervised' : policies[0] ?? 'supervised';
  }
  const tiers = new Set(['standard', ...(model?.serviceTiers?.map((row) => row.id) ?? [])]);
  let serviceTier = config.serviceTier ?? 'standard';
  if (!tiers.has(serviceTier)) {
    if (explicit.serviceTier) throw badRequest(`Service tier "${serviceTier}" is not supported by ${config.model}. Choose Standard or refresh providers.`);
    serviceTier = 'standard';
  }
  return { ...config, effort, policy, serviceTier };
}

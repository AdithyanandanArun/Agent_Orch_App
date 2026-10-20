import type { Policy, ProviderModel } from '@mingle/contracts';
import { isRecord, truncate } from '../common.js';

export const CODEX_POLICIES: Policy[] = ['supervised', 'balanced', 'auto', 'full-access'];

const text = (value: unknown, max = 300): string | undefined =>
  typeof value === 'string' && value.trim() ? truncate(value.trim(), max) : undefined;

/** Parse the native model/list item without inventing unsupported reasoning or speed choices. */
export function parseCodexModel(value: unknown): ProviderModel | null {
  if (!isRecord(value)) return null;
  // The CLI uses `model` as the turn/start identifier; `id` is a separate catalog row key.
  const id = text(value.model, 150) ?? text(value.id, 150);
  if (!id) return null;
  const nativeEfforts = Array.isArray(value.supportedReasoningEfforts) ? value.supportedReasoningEfforts : undefined;
  const efforts = nativeEfforts
    ? nativeEfforts.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const effort = text(entry.reasoningEffort, 40);
      return effort ? [{ id: effort, label: effort, ...(text(entry.description) ? { description: text(entry.description) } : {}) }] : [];
    }).slice(0, 50)
    : [];
  const tiers = Array.isArray(value.serviceTiers)
    ? value.serviceTiers.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const tierId = text(entry.id, 80);
      const name = text(entry.name, 100);
      return tierId && name ? [{ id: tierId, name, ...(text(entry.description) ? { description: text(entry.description) } : {}) }] : [];
    }).slice(0, 20)
    : [];
  const defaultReasoningEffort = text(value.defaultReasoningEffort, 40);
  const defaultServiceTier = text(value.defaultServiceTier, 80);
  return {
    id,
    name: text(value.displayName, 150) ?? id,
    ...(nativeEfforts !== undefined ? { reasoningEfforts: efforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(tiers.length ? { serviceTiers: tiers } : {}),
    ...(defaultServiceTier ? { defaultServiceTier } : {}),
    ...(Array.isArray(value.inputModalities) ? { inputModalities: [...new Set(value.inputModalities.filter((item): item is string => typeof item === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(item)))].slice(0, 20) } : {}),
  };
}

export function parseCodexModels(value: unknown): ProviderModel[] {
  const data = isRecord(value) && Array.isArray(value.data) ? value.data : Array.isArray(value) ? value : [];
  return data.slice(0, 200).flatMap((model) => {
    if (isRecord(model) && model.hidden === true) return [];
    const parsed = parseCodexModel(model);
    return parsed ? [parsed] : [];
  });
}

/** Return a clear reason when a persisted effort is not advertised for the selected model. */
export function validateCodexEffort(model: ProviderModel | undefined, effort: string): string | null {
  if (!model) return 'Codex did not return metadata for the selected model.';
  if (!model.reasoningEfforts) return `Codex did not advertise reasoning efforts for model ${model.id}.`;
  if (model.reasoningEfforts.length === 0) return effort === 'none' ? null : `Codex model ${model.id} has no reasoning effort control.`;
  if (!model.reasoningEfforts.some((option) => option.id === effort)) {
    return `Reasoning effort "${truncate(effort, 80)}" is not supported by Codex model ${model.id}.`;
  }
  return null;
}

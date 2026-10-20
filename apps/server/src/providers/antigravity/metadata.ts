import type { ProviderModel } from '@relay/contracts';
import { isRecord, redactSecrets, truncate } from '../common.js';
import type { AntigravityMetadata } from './runtime.js';
import { ANTIGRAVITY_POLICIES, ANTIGRAVITY_DEFAULT } from './runtime.js';

const record = (v: unknown): Record<string, unknown> => isRecord(v) ? v : {};
const text = (v: unknown, max = 150): string | null => typeof v === 'string' && v.trim() ? truncate(redactSecrets(v.trim()), max) : null;
export function parseAntigravityMetadata(version: string, response: unknown): AntigravityMetadata {
  const result = record(response);
  const options = Array.isArray(result.configOptions) ? result.configOptions : [];
  const model = options.map(record).find((entry) => entry.id === 'model');
  const effort = options.map(record).find((entry) => entry.id === 'thinking_level');
  const modelOptions = model && Array.isArray(model.options) ? model.options : [];
  const effortOptions = effort && Array.isArray(effort.options) ? effort.options : [];
  const efforts = effortOptions.flatMap((entry) => {
    const option = record(entry); const id = text(option.value, 80); const label = text(option.name, 120);
    return id ? [{ id, label: label ?? id }] : [];
  });
  const models: ProviderModel[] = modelOptions.flatMap((entry) => {
    const option = record(entry); const id = text(option.value, 150); const name = text(option.name, 200);
    if (!id) return [];
    const flatEfforts = id === text(model?.currentValue) ? efforts : [];
    return [{ id, name: name ?? id, ...(flatEfforts.length ? { reasoningEfforts: flatEfforts, defaultReasoningEffort: text(effort?.currentValue, 80) ?? flatEfforts[0]?.id } : {}), policies: ANTIGRAVITY_POLICIES }];
  });
  const modelsPayload = Array.isArray(result.models) ? result.models : [];
  if (!models.length) for (const entry of modelsPayload) {
    const item = record(entry); const id = text(item.modelId, 150); if (id && !models.some((m) => m.id === id)) models.push({ id, name: text(item.name, 200) ?? id, policies: ANTIGRAVITY_POLICIES });
  }
  const modes = Array.isArray(result.modes) ? result.modes.map(record).flatMap((entry) => text(entry.id, 100) ? [text(entry.id, 100)!] : []) : [];
  const modelCatalog = models.length ? models : [ANTIGRAVITY_DEFAULT];
  const commands: AntigravityMetadata['commands'] = Array.isArray(result.availableCommands) ? result.availableCommands.slice(0, 100).flatMap((entry) => {
    const item = record(entry); const id = text(item.name, 100); if (!id) return [];
    return [{ id, name: id, description: text(item.description, 400) ?? '', source: 'provider' as const, kind: 'prompt' as const }];
  }) : [];
  return { version, models: modelCatalog, commands, choices: { models: models.map((m) => m.id), currentModel: text(model?.currentValue), thinkingLevels: efforts.map((e) => e.id), modes } };
}

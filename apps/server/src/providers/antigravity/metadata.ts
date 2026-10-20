import type { ProviderModel } from '@mingle/contracts';
import { isRecord, redactSecrets, truncate } from '../common.js';
import type { AntigravityMetadata } from './runtime.js';
import { ANTIGRAVITY_POLICIES, ANTIGRAVITY_DEFAULT } from './runtime.js';

export const object = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const text = (value: unknown, max = 150): string | null => typeof value === 'string' && value.trim() ? truncate(redactSecrets(value.trim()), max) : null;
export interface NativeChoice { value: string; name: string; description?: string }
/** ACP selectors can contain option groups. Only actual leaf choices become model settings. */
export function choices(value: unknown): NativeChoice[] {
  const output: NativeChoice[] = [];
  const visit = (entries: unknown, depth: number): void => {
    if (!Array.isArray(entries) || depth > 4) return;
    for (const raw of entries.slice(0, 200)) {
      const item = object(raw); const value = text(item.value);
      if (value) output.push({ value, name: text(item.name, 200) ?? value, ...(text(item.description, 400) ? { description: text(item.description, 400)! } : {}) });
      else visit(item.options, depth + 1);
      if (output.length >= 200) break;
    }
  };
  visit(value, 0);
  return [...new Map(output.slice(0, 200).map((item) => [item.value, item])).values()];
}
export function configuration(response: unknown, id: 'model' | 'mode' | 'thinking_level'): Record<string, unknown> | undefined {
  const raw = object(response).configOptions;
  if (!Array.isArray(raw)) return undefined;
  return raw.map(object).find((item) => item.id === id || item.category === (id === 'thinking_level' ? 'thought_level' : id));
}
export function nativeModelValue(response: unknown): string | null {
  return text(configuration(response, 'model')?.currentValue) ?? text(object(object(response).models).currentModelId);
}
export function nativeModes(response: unknown): string[] {
  const mode = configuration(response, 'mode');
  if (mode) return choices(mode.options).map((choice) => choice.value);
  const modes = object(object(response).modes).availableModes;
  return Array.isArray(modes) ? modes.flatMap((raw) => text(object(raw).id) ? [text(object(raw).id)!] : []) : [];
}
export function parseNativeCommands(raw: unknown): AntigravityMetadata['commands'] {
  return Array.isArray(raw) ? raw.slice(0, 100).flatMap((entry) => {
    const item = object(entry); const name = text(item.name, 100);
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) return [];
    const hint = text(object(item.input).hint, 150);
    return [{ id: name, name, description: text(item.description, 400) ?? '', ...(hint ? { argumentHint: hint } : {}), source: 'provider' as const, kind: 'prompt' as const }];
  }) : [];
}
export function parseAntigravityMetadata(version: string, response: unknown, commands: unknown = []): AntigravityMetadata {
  const selected = configuration(response, 'model');
  const thinking = configuration(response, 'thinking_level');
  const current = nativeModelValue(response);
  const nativeEfforts = choices(thinking?.options).filter((choice) => /^[a-z][a-z0-9_-]{0,39}$/.test(choice.value));
  const modes = nativeModes(response);
  const policyMap = { default: 'supervised', auto_edit: 'balanced', yolo: 'full-access' } as const;
  const policies = ANTIGRAVITY_POLICIES.filter((policy) => modes.some((mode) => policyMap[mode as keyof typeof policyMap] === policy));
  const knownPolicies = policies;
  let advertised = choices(selected?.options);
  if (!advertised.length) {
    const legacy = object(object(response).models).availableModels;
    advertised = Array.isArray(legacy) ? legacy.slice(0, 200).flatMap((raw) => {
      const item = object(raw); const value = text(item.modelId);
      return value ? [{ value, name: text(item.name, 200) ?? value }] : [];
    }) : [];
  }
  const currentName = advertised.find((model) => model.value === current)?.name;
  const currentThinking = nativeEfforts.find((choice) => choice.value === thinking?.currentValue);
  const defaultEffort = { id: 'none', label: currentThinking ? `Default (${currentThinking.name})` : 'Native default' };
  const selectedEfforts = nativeEfforts.filter((choice) => choice.value !== 'none').map((choice) => ({ id: choice.value, label: choice.name, ...(choice.description ? { description: choice.description } : {}) }));
  const models: ProviderModel[] = [{ ...ANTIGRAVITY_DEFAULT,
    name: currentName && current !== 'default' ? `${currentName} (default)` : ANTIGRAVITY_DEFAULT.name,
    reasoningEfforts: [defaultEffort, ...selectedEfforts], policies: knownPolicies }];
  for (const model of advertised) {
    if (model.value === 'default') continue;
    const efforts = model.value === current ? nativeEfforts.map((choice) => ({ id: choice.value, label: choice.name, ...(choice.description ? { description: choice.description } : {}) })) : [];
    models.push({ id: model.value, name: model.name, reasoningEfforts: [model.value === current ? defaultEffort : { id: 'none', label: 'Native default' }, ...efforts.filter((choice) => choice.id !== 'none')], defaultReasoningEffort: 'none', policies: knownPolicies });
  }
  return { version, models, commands: parseNativeCommands(commands), choices: { currentModel: current, modes, thinkingLevels: nativeEfforts.map((item) => item.value) } };
}
/** Run setup only refines its selected model; preserve earlier measured options for other models. */
export function mergeAntigravityMetadata(previous: AntigravityMetadata | undefined, next: AntigravityMetadata): AntigravityMetadata {
  if (!previous || previous.version !== next.version) return next;
  return { ...next, models: next.models.map((model) => {
    const earlier = previous.models.find((entry) => entry.id === model.id);
    return model.id !== 'default' && model.reasoningEfforts?.length === 1 && (earlier?.reasoningEfforts?.length ?? 0) > 1 ? { ...model, reasoningEfforts: earlier!.reasoningEfforts } : model;
  }), commands: next.commands.length ? next.commands : previous.commands };
}

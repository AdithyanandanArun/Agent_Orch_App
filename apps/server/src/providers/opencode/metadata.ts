import type { Policy, ProviderCommand, ProviderModel } from '@mingle/contracts';
import { isRecord, redactSecrets, truncate } from '../common.js';
import type { OpencodeConnection } from './rpc.js';

/** OpenCode's ACP has no Auto reviewer; permission rules map Supervised, Auto-accept edits and Full access. */
export const OPENCODE_POLICIES: Policy[] = ['supervised', 'balanced', 'full-access'];
export const OPENCODE_DEFAULT_MODEL = 'default';
/** Mingle's `none` effort means "leave the model on its native default variant". */
export const NATIVE_EFFORT = 'none';
/** The native option that clears a model variant. */
export const NATIVE_VARIANT_DEFAULT = 'default';
const MAX_MODELS = 500;

export const object = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const text = (value: unknown, max = 200): string | null => typeof value === 'string' && value.trim() ? truncate(redactSecrets(value.trim()), max) : null;

export interface NativeChoice { value: string; name: string; description?: string }
/** ACP selectors can contain option groups; only leaf choices become settings. */
export function choices(value: unknown): NativeChoice[] {
  const output: NativeChoice[] = [];
  const visit = (entries: unknown, depth: number): void => {
    if (!Array.isArray(entries) || depth > 4) return;
    for (const raw of entries.slice(0, 600)) {
      const item = object(raw);
      const optionValue = text(item.value, 300);
      if (optionValue) output.push({ value: optionValue, name: text(item.name, 200) ?? optionValue, ...(text(item.description, 400) ? { description: text(item.description, 400)! } : {}) });
      else visit(item.options, depth + 1);
      if (output.length >= 600) break;
    }
  };
  visit(value, 0);
  return [...new Map(output.map((item) => [item.value, item])).values()];
}

type ConfigId = 'model' | 'effort' | 'mode';
const CATEGORY: Record<ConfigId, string> = { model: 'model', effort: 'thought_level', mode: 'mode' };
/** Finds a native config selector by its identifier or ACP category. */
export function configuration(response: unknown, id: ConfigId): Record<string, unknown> | undefined {
  const raw = object(response).configOptions;
  if (!Array.isArray(raw)) return undefined;
  const options = raw.map(object);
  return options.find((item) => item.id === id) ?? options.find((item) => item.category === CATEGORY[id]);
}
export function currentValue(response: unknown, id: ConfigId): string | null {
  return text(configuration(response, id)?.currentValue, 300);
}

/**
 * Mingle effort identifiers are lowercase slugs and `none` is reserved for the native default, so a native variant that is
 * literally called `none` (an OpenAI reasoning level) is exposed as `variant-none`. Matching at run time recomputes this
 * mapping from the live native options, never from stored copies.
 */
export function mingleEffortId(native: string): string | null {
  if (native === NATIVE_VARIANT_DEFAULT) return null;
  if (native === 'none') return 'variant-none';
  if (/^[a-z][a-z0-9_-]{0,39}$/.test(native)) return native;
  const slug = native.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 40);
  return slug && slug !== 'none' ? slug : null;
}

export interface NativeEffort { id: string; native: string; label: string; description?: string }
/** Native variants of the selected model keyed by their Mingle identifiers. */
export function nativeEfforts(response: unknown): NativeEffort[] {
  const seen = new Set<string>();
  const output: NativeEffort[] = [];
  for (const choice of choices(configuration(response, 'effort')?.options)) {
    const id = mingleEffortId(choice.value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push({ id, native: choice.value, label: choice.name, ...(choice.description ? { description: choice.description } : {}) });
  }
  return output;
}
export function effortChoices(response: unknown): NonNullable<ProviderModel['reasoningEfforts']> {
  return [{ id: NATIVE_EFFORT, label: 'Native default' }, ...nativeEfforts(response).map((effort) => ({ id: effort.id, label: effort.label, ...(effort.description ? { description: effort.description } : {}) }))];
}

export function parseNativeCommands(raw: unknown): ProviderCommand[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const commands: ProviderCommand[] = [];
  for (const entry of raw.slice(0, 200)) {
    const item = object(entry);
    const name = text(item.name, 100);
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const hint = text(object(item.input).hint, 150);
    commands.push({ id: name, name, description: text(item.description, 400) ?? '', ...(hint ? { argumentHint: hint } : {}), source: 'provider', kind: 'prompt' });
  }
  return commands;
}

export interface OpencodeMetadata {
  version: string;
  models: ProviderModel[];
  commands: ProviderCommand[];
  /** Native default model as seen from the probe directory. Project configuration can select a different one. */
  currentModel: string | null;
  providers: string[];
  http: boolean;
  /** Models whose variants were not measured because the probe budget ended. */
  unmeasured: number;
  failures: number;
}

/**
 * The `default` sentinel keeps OpenCode's own model selection. When metadata measured the model OpenCode currently defaults to,
 * the entry carries that model's name and variants; otherwise it offers only Native default.
 */
export function defaultModelEntry(current?: { name: string; efforts: NonNullable<ProviderModel['reasoningEfforts']> }): ProviderModel {
  return {
    id: OPENCODE_DEFAULT_MODEL, name: current ? `${current.name} (default)` : 'OpenCode default',
    reasoningEfforts: current?.efforts ?? [{ id: NATIVE_EFFORT, label: 'Native default' }], defaultReasoningEffort: NATIVE_EFFORT, policies: OPENCODE_POLICIES,
  };
}

/**
 * Reads the native model list from session creation, then selects each model on the throwaway metadata session to read the
 * variants OpenCode reports for it. Selecting a model is local state; it submits no prompt.
 */
export async function readModels(conn: OpencodeConnection, sessionId: string, selected: unknown, budgetMs = 12_000): Promise<Pick<OpencodeMetadata, 'models' | 'currentModel' | 'unmeasured' | 'failures'>> {
  const option = configuration(selected, 'model');
  const advertised = choices(option?.options).filter((choice) => choice.value !== OPENCODE_DEFAULT_MODEL && choice.value.length <= 150);
  const current = text(option?.currentValue, 300);
  const models: ProviderModel[] = [];
  let currentMeasured: Parameters<typeof defaultModelEntry>[0];
  const deadline = Date.now() + budgetMs;
  const optionId = typeof option?.id === 'string' ? option.id : 'model';
  let unmeasured = 0;
  let failures = 0;
  for (const model of advertised.slice(0, MAX_MODELS)) {
    let efforts: ProviderModel['reasoningEfforts'] = [{ id: NATIVE_EFFORT, label: 'Native default' }];
    if (Date.now() >= deadline) unmeasured += 1;
    else {
      try {
        const response = await conn.request('session/set_config_option', { sessionId, configId: optionId, value: model.value }, Math.max(1_000, deadline - Date.now()));
        if (currentValue(response, 'model') === model.value) efforts = effortChoices(response);
        else failures += 1;
      } catch { failures += 1; }
    }
    models.push({ id: model.value, name: model.name, reasoningEfforts: efforts, defaultReasoningEffort: NATIVE_EFFORT, policies: OPENCODE_POLICIES });
    if (model.value === current) currentMeasured = { name: model.name, efforts };
  }
  models.unshift(defaultModelEntry(currentMeasured));
  return { models, currentModel: current, unmeasured: unmeasured + Math.max(0, advertised.length - MAX_MODELS), failures };
}

export function providerIds(models: ProviderModel[]): string[] {
  return [...new Set(models.filter((model) => model.id !== OPENCODE_DEFAULT_MODEL).map((model) => model.id.split('/')[0]!).filter(Boolean))].sort();
}

import type { AppSettings, Provider, ProviderInfo, ProviderModel } from '@relay/contracts';

export const PROVIDER_NAMES: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  antigravity: 'Antigravity',
};

export type ProviderModelSetting = 'defaultCodexModel' | 'defaultClaudeModel' | 'defaultAntigravityModel';

export const providerModelSetting = (provider: Provider): ProviderModelSetting => ({
  codex: 'defaultCodexModel',
  claude: 'defaultClaudeModel',
  antigravity: 'defaultAntigravityModel',
} satisfies Record<Provider, ProviderModelSetting>)[provider];

export function defaultProviderModel(provider: Provider, settings: AppSettings): string {
  const value = settings[providerModelSetting(provider)];
  return value ?? (provider === 'antigravity' ? 'default' : '');
}

/** Uses only discovered native models; Antigravity's sentinel delegates selection to agy. */
export function providerModelChoices(info: ProviderInfo | undefined, current?: string): ProviderModel[] {
  const models = info?.models ?? [];
  const choices = [...models];
  if (info?.id === 'antigravity' && choices.length === 0) choices.push({ id: 'default', name: 'Antigravity default' });
  if (current && !choices.some((model) => model.id === current || model.aliases?.includes(current))) {
    choices.unshift({ id: current, name: info?.id === 'antigravity' && current === 'default' ? 'Antigravity default' : current });
  }
  return choices;
}

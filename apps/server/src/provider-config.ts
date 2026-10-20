import type { AppSettings, Provider } from '@relay/contracts';

const PROVIDER_NAMES: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  antigravity: 'Antigravity',
};

const DEFAULT_MODEL_KEYS: Record<Provider, keyof Pick<AppSettings, 'defaultCodexModel' | 'defaultClaudeModel' | 'defaultAntigravityModel'>> = {
  codex: 'defaultCodexModel',
  claude: 'defaultClaudeModel',
  antigravity: 'defaultAntigravityModel',
};

const EXECUTABLE_KEYS: Record<Provider, keyof Pick<AppSettings, 'codexExecutable' | 'claudeExecutable' | 'antigravityExecutable'>> = {
  codex: 'codexExecutable',
  claude: 'claudeExecutable',
  antigravity: 'antigravityExecutable',
};

export function providerName(provider: Provider): string {
  return PROVIDER_NAMES[provider];
}

export function defaultModel(provider: Provider, settings: AppSettings): string {
  const value = settings[DEFAULT_MODEL_KEYS[provider]];
  return value || 'default';
}

export function providerExecutable(provider: Provider, settings: AppSettings): string {
  return settings[EXECUTABLE_KEYS[provider]] ?? '';
}

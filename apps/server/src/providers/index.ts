import type { AgentAdapter, AppSettings, Provider, ProviderCatalog, ProviderInfo, Session } from '@relay/contracts';
import { createClaudeAdapter } from './claude/adapter.js';
import { createCodexAdapter } from './codex/adapter.js';
import { detectProviders as detect } from './detect.js';
import { getCodexCatalog } from './codex/catalog.js';
import { getClaudeCatalog } from './claude/catalog.js';

export type { AdapterEvent, AgentAdapter, RunOptions } from '@relay/contracts';
export { CLAUDE_DEFAULT_MODEL, CODEX_DEFAULT_MODEL } from './detect.js';
export { ProviderError, isAbortError } from './common.js';

/** Returns the adapter for a provider. Adapters hold no state between runs. */
export function createAdapter(provider: Provider): AgentAdapter {
  switch (provider) {
    case 'codex': return createCodexAdapter();
    case 'claude': return createClaudeAdapter();
    default: throw new Error(`Unknown provider: ${String(provider)}`);
  }
}

/** Probes installed harnesses without running inference. See docs/provider-research.md for semantics. */
export function detectProviders(settings: AppSettings): Promise<ProviderInfo[]> {
  return detect(settings);
}

/** Native catalog metadata only: no prompt or model turn is submitted. */
export function getCatalog(session: Session, settings: AppSettings): Promise<ProviderCatalog> {
  return session.provider === 'codex' ? getCodexCatalog(session, settings) : getClaudeCatalog(session, settings);
}

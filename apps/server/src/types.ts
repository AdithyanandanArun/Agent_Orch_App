import type { AgentAdapter, AppSettings, Provider, ProviderCatalog, ProviderInfo, Session } from '@relay/contracts';

/** The provider module surface (apps/server/src/providers/index.ts) as consumed by the runtime. */
export interface ProviderRuntime {
  createAdapter(provider: Provider): AgentAdapter;
  detectProviders(settings: AppSettings): Promise<ProviderInfo[]>;
  getCatalog?(session: Session, settings: AppSettings): Promise<ProviderCatalog>;
}

export type Logger = (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;

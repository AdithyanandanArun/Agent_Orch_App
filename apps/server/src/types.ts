import type { AgentAdapter, AppSettings, ConversationListOptions, ExternalConversationDetails, ExternalConversationList, Provider, ProviderCatalog, ProviderInfo, ProviderUsage, Session } from '@mingle/contracts';

/** The provider module surface (apps/server/src/providers/index.ts) as consumed by the runtime. */
export interface ProviderRuntime {
  createAdapter(provider: Provider): AgentAdapter;
  detectProviders(settings: AppSettings): Promise<ProviderInfo[]>;
  getCatalog?(session: Session, settings: AppSettings): Promise<ProviderCatalog>;
  getUsage?(session: Session, settings: AppSettings): Promise<ProviderUsage>;
  listConversations?(provider: Provider, settings: AppSettings, options: ConversationListOptions): Promise<ExternalConversationList>;
  readConversation?(provider: Provider, settings: AppSettings, id: string): Promise<ExternalConversationDetails>;
  /** Stops any provider helper processes still alive after runs are finished, such as metadata probes. */
  close?(): Promise<void>;
}

export type Logger = (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;

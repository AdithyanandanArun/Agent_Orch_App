import type { AppSettings, ProviderUsage, Session } from '@relay/contracts';

/** OpenCode ACP exposes no account quota, plan or credit surface, and Relay does not read its credential store. */
export async function getOpencodeUsage(session: Session, _settings: AppSettings): Promise<ProviderUsage> {
  return {
    provider: 'opencode', fetchedAt: new Date().toISOString(), status: 'unavailable', plan: null, windows: [], credits: null, resets: null,
    notices: [
      `OpenCode does not report account quota or plan limits through ACP, so none are shown for ${session.model === 'default' ? 'the default model' : session.model}.`,
      'Token totals for this conversation come from OpenCode turn summaries and are recorded locally after each completed turn. Cost is not reported over ACP.',
    ],
  };
}

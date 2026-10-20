import type { AppSettings, ProviderCatalog, Session } from '@relay/contracts';
import { resolveAntigravity, cachedAntigravityMetadata } from './runtime.js';

export async function getAntigravityCatalog(session: Session, settings: AppSettings): Promise<ProviderCatalog> {
  if (session.provider !== 'antigravity') return { commands: [], skills: [], warnings: ['This catalog is only for Antigravity.'] };
  const resolved = await resolveAntigravity(settings);
  if (!resolved.ok) return { commands: [], skills: [], warnings: [resolved.reason] };
  const cached = cachedAntigravityMetadata(resolved.executable.path);
  return { commands: cached?.commands ?? [], skills: [], warnings: [
    'Relay-selected Antigravity skills are unavailable. Native provider skill loading remains under Antigravity’s control.',
    ...(!cached?.commands.length ? ['No native command metadata has been reported yet. Sign in and refresh models in Settings, or start a session. No discovery prompt was submitted.'] : []),
  ] };
}

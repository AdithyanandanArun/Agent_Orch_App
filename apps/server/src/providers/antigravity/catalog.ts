import type { AppSettings, ProviderCatalog, Session } from '@relay/contracts';
import { resolveAntigravity, cachedAntigravityMetadata } from './runtime.js';

export async function getAntigravityCatalog(session: Session, settings: AppSettings): Promise<ProviderCatalog> {
  if (session.provider !== 'antigravity') return { commands: [], skills: [], warnings: ['Provider catalog is available only for Antigravity sessions.'] };
  const resolved = await resolveAntigravity(settings);
  if (!resolved.ok) return { commands: [], skills: [], warnings: [resolved.reason] };
  const cached = cachedAntigravityMetadata(resolved.executable.path);
  if (!cached) return { commands: [], skills: [], warnings: ['Antigravity has not reported command metadata in an authenticated session yet.'] };
  return { commands: cached.commands, skills: [], warnings: [] };
}

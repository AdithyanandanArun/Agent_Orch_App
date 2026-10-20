import type { AppSettings, ProviderCatalog, Session } from '@relay/contracts';
import { resolveAntigravity, cachedAntigravityMetadata } from './runtime.js';
import { probeAuthenticatedAntigravity } from './auth.js';

const discoveries = new Map<string, ReturnType<typeof probeAuthenticatedAntigravity>>();

function discover(executable: string, settings: AppSettings): ReturnType<typeof probeAuthenticatedAntigravity> {
  const existing = discoveries.get(executable);
  if (existing) return existing;
  const pending = probeAuthenticatedAntigravity(settings).finally(() => { if (discoveries.get(executable) === pending) discoveries.delete(executable); });
  discoveries.set(executable, pending);
  return pending;
}

export async function getAntigravityCatalog(session: Session, settings: AppSettings): Promise<ProviderCatalog> {
  if (session.provider !== 'antigravity') return { commands: [], skills: [], warnings: ['This catalog is only for Antigravity.'] };
  const resolved = await resolveAntigravity(settings);
  if (!resolved.ok) return { commands: [], skills: [], warnings: [resolved.reason] };
  let cached = cachedAntigravityMetadata(resolved.executable.path);
  const warnings = ['Relay-selected Antigravity skills are unavailable. Native provider skill loading remains under Antigravity’s control.'];
  if (!cached?.commands.length) {
    // An empty picker should not require a paid conversation just to discover native commands.
    // This uses an isolated metadata session and aborts if Google asks for browser authentication.
    const result = await discover(resolved.executable.path, settings);
    if (!result.available && result.reason) warnings.push(result.reason);
    cached = cachedAntigravityMetadata(resolved.executable.path);
  }
  return { commands: cached?.commands ?? [], skills: [], warnings: [
    ...warnings,
    ...(!cached?.commands.length ? ['No native command metadata has been reported yet. Sign in and refresh models in Settings, or start a session. No discovery prompt was submitted.'] : []),
  ] };
}

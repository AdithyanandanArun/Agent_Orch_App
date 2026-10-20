import { tmpdir } from 'node:os';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppSettings, ProviderUsage, Session } from '@mingle/contracts';
import { isRecord, truncate } from '../common.js';
import { closeAntigravity, isAntigravityAuthenticated, resolveAntigravity, safeAntigravityError, safeAntigravityText, startAntigravity, type AntigravityRuntime } from './runtime.js';
import { object } from './metadata.js';

function unavailable(notice: string): ProviderUsage { return { provider: 'antigravity', fetchedAt: new Date().toISOString(), status: 'unavailable', plan: null, windows: [], credits: null, resets: null, notices: [truncate(safeAntigravityText(notice), 1500)] }; }
function resetTime(raw: string | undefined): string | null {
  if (!raw) return null;
  // The verified native formatter reports UTC to minute precision, or preserves an ISO timestamp it could not format.
  if (!/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2}, \d{4}, \d{2}:\d{2} UTC$/.test(raw)
    && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return null;
  const stamp = Date.parse(raw);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}
function parseReport(report: string, clipped: boolean): ProviderUsage {
  const windows: ProviderUsage['windows'] = [];
  let scope: string | undefined;
  for (const line of report.split(/\r?\n/)) {
    const heading = /^- \*\*([^*]+)\*\*\s*$/.exec(line);
    if (heading) { scope = heading[1]!.trim(); continue; }
    const bucket = /^\s+- \*\*([^*]+):\*\* (\d{1,3})% remaining(?: \(resets ([^)]+)\))?\s*$/.exec(line);
    if (!bucket || windows.length >= 40) continue;
    const remaining = Number(bucket[2]);
    if (remaining > 100) continue;
    windows.push({ id: `antigravity:${windows.length + 1}`, label: truncate(`${scope ? `${scope} · ` : ''}${bucket[1]!.trim()}`, 200), ...(scope ? { scope: truncate(scope, 100) } : {}),
      remainingPercent: remaining, usedPercent: 100 - remaining, resetAt: resetTime(bucket[3]), windowMinutes: null });
  }
  return { provider: 'antigravity', fetchedAt: new Date().toISOString(), status: windows.length ? 'partial' : 'unavailable', plan: null, windows, credits: null, resets: null,
    notices: [windows.length ? 'These are values from Antigravity’s native quota report. Reset times retain the provider’s minute precision.' : 'Antigravity did not return recognized quota percentages. Unknown fields remain blank.',
      'Antigravity does not expose credit balances or reset grants through this report.', ...(clipped ? ['The native report exceeded Mingle’s display limit.'] : []), truncate(safeAntigravityText(report.trim()), 8000)] };
}
/** Literal /usage is intercepted before inference in the publicly inspected Google ACP 1.4.1 release. */
export async function getAntigravityUsage(session: Session, settings: AppSettings): Promise<ProviderUsage> {
  if (session.provider !== 'antigravity') return unavailable('This quota reader is only for Antigravity.');
  const found = await resolveAntigravity(settings);
  if (!found.ok) return unavailable(found.reason);
  if (!isAntigravityAuthenticated(found.executable.path)) return unavailable('Sign in to Google Antigravity in Settings, or complete a session setup, before checking quota. No model prompt was sent.');
  let runtime: AntigravityRuntime | undefined;
  let workspace: string | undefined;
  let sessionId: string | null = null;
  let commands: unknown[] = [];
  let report = '';
  let clipped = false;
  let collecting = false;
  let commandsArrived!: () => void;
  const commandsReady = new Promise<void>((resolve) => { commandsArrived = resolve; });
  const limit = AbortSignal.timeout(60_000);
  try {
    workspace = await mkdtemp(join(tmpdir(), 'relay-antigravity-usage-'));
    if (process.platform !== 'win32') await chmod(workspace, 0o700);
    runtime = await startAntigravity(found.executable.path, found.executable.companion, { cwd: workspace, timeoutMs: 12_000, signal: limit,
      notification: (method, params) => {
        const data = object(params); const update = object(data.update);
        if (method !== 'session/update' || sessionId && data.sessionId !== sessionId) return;
        if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) { commands = update.availableCommands.slice(0, 100); commandsArrived(); }
        if (collecting && update.sessionUpdate === 'agent_message_chunk' && object(update.content).type === 'text' && typeof object(update.content).text === 'string') {
          const delta = String(object(update.content).text);
          clipped ||= report.length + delta.length > 12_000;
          if (report.length < 12_000) report += delta.slice(0, 12_000 - report.length);
        }
      },
    });
    if (runtime.version !== '1.4.1') return unavailable(`ACP ${runtime.version} was not queried. Mingle has verified the no-inference /usage behavior only in Google’s 1.4.1 release.`);
    // A separate empty maintenance session avoids replaying or concurrently resuming the user's active conversation.
    const response: unknown = await runtime.conn.request('session/new', { cwd: workspace, mcpServers: [] }, 35_000);
    if (!isRecord(response) || typeof response.sessionId !== 'string' || !response.sessionId) return unavailable('Antigravity did not return a maintenance session.');
    sessionId = response.sessionId;
    await Promise.race([commandsReady, new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1500); timer.unref(); })]);
    if (!commands.some((entry) => object(entry).name === 'usage')) return unavailable('Antigravity did not advertise its native /usage command. No prompt was sent.');
    collecting = true;
    const result: unknown = await runtime.conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/usage' }] }, 20_000);
    collecting = false;
    if (object(result).stopReason !== 'end_turn' || !report.trim()) return unavailable('Antigravity did not complete its native quota report.');
    return parseReport(report, clipped);
  } catch (error) { return unavailable(`Antigravity quota could not be read: ${safeAntigravityError(error)}`); }
  finally {
    if (runtime) await closeAntigravity(runtime);
    if (workspace && runtime) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

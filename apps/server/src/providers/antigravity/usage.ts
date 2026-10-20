import { tmpdir } from 'node:os';
import type { ProviderUsage, Session } from '@relay/contracts';
import { redactSecrets, truncate } from '../common.js';
import { isAntigravityAuthenticated, resolveAntigravity, startAntigravity, closeAntigravity } from './runtime.js';
import type { AppSettings } from '@relay/contracts';
import { isRecord } from '../common.js';

function unavailable(notice: string): ProviderUsage { return { provider: 'antigravity', fetchedAt: new Date().toISOString(), status: 'unavailable', plan: null, windows: [], credits: null, resets: null, notices: [truncate(redactSecrets(notice), 300)] }; }
function parseUsage(text: string): ProviderUsage {
  const notices = [truncate(redactSecrets(text.trim()), 1_500)];
  const windows: ProviderUsage['windows'] = [];
  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length && windows.length < 20; i += 1) {
    const row = rows[i]!;
    const match = /(?:\*\*)?([^\n:*]{2,100}?)(?:\*\*)?:\s*(\d{1,3})%\s+remaining/i.exec(row);
    if (!match) continue;
    const reset = /resets\s+([^\n)]+)/i.exec(row);
    const raw = reset?.[1]?.trim();
    let resetAt: string | null = null;
    if (raw) { const date = new Date(raw.replace(/ UTC$/i, 'Z')); if (Number.isFinite(date.getTime())) resetAt = date.toISOString(); }
    const remaining = Number(match[2]);
    windows.push({ id: `antigravity:${windows.length + 1}`, label: truncate(match[1]!.replace(/[*]/g, '').trim(), 100), remainingPercent: remaining <= 100 ? remaining : null, usedPercent: remaining <= 100 ? 100 - remaining : null, resetAt, windowMinutes: null });
  }
  const recognized = windows.length > 0;
  return { provider: 'antigravity', fetchedAt: new Date().toISOString(), status: recognized ? 'partial' : 'unavailable', plan: null, windows, credits: null, resets: null,
    notices: recognized ? ['Quota values were parsed from Antigravity’s native /usage report. Raw bounded report follows.', ...notices] : ['Antigravity /usage report could not be parsed; quota fields are left unknown.', ...notices] };
}
/** ACP 1.4.1's literal /usage command is handled before model inference. */
export async function getAntigravityUsage(session: Session, settings: AppSettings): Promise<ProviderUsage> {
  if (session.provider !== 'antigravity') return unavailable('Usage is available only for Antigravity sessions.');
  const found = await resolveAntigravity(settings);
  if (!found.ok) return unavailable(found.reason);
  if (!isAntigravityAuthenticated(found.executable.path)) return unavailable('Sign in to Antigravity from Settings before checking quota.');
  let runtime: Awaited<ReturnType<typeof startAntigravity>> | undefined;
  const commandState: { current: unknown[] | null } = { current: null };
  let report = '';
  let completedResolve!: () => void;
  const completed = new Promise<void>((resolve) => { completedResolve = resolve; });
  try {
    runtime = await startAntigravity(found.executable.path, found.executable.companion, {
      cwd: tmpdir(), timeoutMs: 12_000,
      notification: (method, params) => {
        const data = isRecord(params) ? params : {}; const update = isRecord(data.update) ? data.update : {};
        if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) commandState.current = update.availableCommands;
        if (update.sessionUpdate === 'agent_message_chunk' && isRecord(update.content) && typeof update.content.text === 'string') report += update.content.text;
        if (update.sessionUpdate === 'prompt_completed') completedResolve();
      },
    });
    if (runtime.version !== '1.4.1') return unavailable(`Antigravity ACP ${truncate(runtime.version, 80)} was not queried; the no-inference /usage behavior is verified only for version 1.4.1.`);
    const response: unknown = await runtime.conn.request('session/new', { cwd: tmpdir(), mcpServers: [] }, 90_000);
    if (!isRecord(response) || typeof response.sessionId !== 'string') return unavailable('Antigravity did not create a maintenance session for the quota read.');
    await new Promise((resolve) => { const timer = setTimeout(resolve, 1_500); timer.unref?.(); });
    if (!commandState.current?.some((item) => isRecord(item) && item.name === 'usage')) return unavailable('Antigravity did not advertise its /usage command; no prompt was sent.');
    const pending = runtime.conn.request('session/prompt', { sessionId: response.sessionId, prompt: [{ type: 'text', text: '/usage' }] }, 30_000);
    await Promise.race([pending.then(() => undefined), completed]);
    if (!report.trim()) return unavailable('Antigravity /usage returned no report.');
    return parseUsage(truncate(report, 12_000));
  } catch (error) { return unavailable(`Antigravity usage could not be read: ${truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 250)}`); }
  finally { if (runtime) await closeAntigravity(runtime); }
}

import type { SessionRun, ToolCategory } from '@relay/contracts';

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  return `${remainder}s`;
}

export function runElapsed(run: SessionRun, now = Date.now()): number | null {
  if (run.durationMs !== null) return run.durationMs;
  if (run.status !== 'running') return null;
  const started = Date.parse(run.startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : null;
}

const categoryNames: Record<ToolCategory, string> = {
  command: 'commands', browser: 'browser actions', search: 'searches', file: 'file actions', agent: 'subagents', other: 'tools',
};

export function toolCategoryLabel(category: ToolCategory): string {
  return categoryNames[category];
}

export function runStatusLabel(run: SessionRun, elapsed: number | null): string {
  if (run.status === 'running') return elapsed === null ? 'Working' : `Working for ${formatElapsed(elapsed)}`;
  if (run.status === 'completed') return elapsed === null ? 'Completed' : `Worked for ${formatElapsed(elapsed)}`;
  if (run.status === 'failed') return elapsed === null ? 'Failed' : `Failed after ${formatElapsed(elapsed)}`;
  return elapsed === null ? 'Interrupted' : `Interrupted after ${formatElapsed(elapsed)}`;
}

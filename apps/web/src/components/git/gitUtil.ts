import type { GitHubState, RepositoryChange, RepositoryState } from '@relay/contracts';

export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : 'none');

/** Opens provider-reported links only when they are plain web URLs. */
export function openExternal(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    window.open(parsed.href, '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
}

export type RunTone = 'pass' | 'fail' | 'pending' | 'unknown';

const PASS = new Set(['success', 'successful', 'pass', 'passed', 'neutral', 'skipped']);
const FAIL = new Set(['failure', 'failed', 'fail', 'error', 'timed_out', 'cancelled', 'canceled', 'startup_failure', 'action_required', 'stale']);
const PENDING = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested', 'expected', 'running']);

/** Classifies a GitHub status/conclusion pair; unrecognised values stay unknown rather than guessed. */
export function classifyRun(status: string, conclusion: string | null): RunTone {
  const value = (conclusion ?? status).toLowerCase().replace(/[\s-]+/g, '_');
  if (PASS.has(value)) return 'pass';
  if (FAIL.has(value)) return 'fail';
  if (PENDING.has(value)) return 'pending';
  return 'unknown';
}

export const runLabel = (status: string, conclusion: string | null): string => (conclusion ?? status).replace(/[_-]+/g, ' ').toLowerCase();

export interface ChecksSummary { tone: 'ok' | 'err' | 'warn' | 'neutral'; label: string }

export function summarizeChecks(checks: GitHubState['checks']): ChecksSummary {
  const counts: Record<RunTone, number> = { pass: 0, fail: 0, pending: 0, unknown: 0 };
  for (const check of checks) counts[classifyRun(check.status, check.conclusion)] += 1;
  if (counts.fail) return { tone: 'err', label: `${counts.fail} failing` };
  if (counts.pending) return { tone: 'warn', label: `${counts.pending} running` };
  if (counts.unknown) return { tone: 'neutral', label: `${counts.unknown} unrecognised` };
  return { tone: 'ok', label: checks.length === 1 ? 'passed' : `all ${checks.length} passed` };
}

/** GitHub data is only meaningful for the exact commit and branch the checkout is on right now. */
export const githubMatches = (github: GitHubState | null, repo: RepositoryState | null): boolean =>
  Boolean(github && repo && github.head === repo.head && github.branch === repo.branch);

export const changeLabel = (change: RepositoryChange): string => {
  if (change.status === '??') return 'Untracked';
  const code = change.indexStatus.trim() && change.indexStatus !== '?' ? change.indexStatus : change.worktreeStatus;
  switch (code) {
    case 'A': return 'Added';
    case 'M': return 'Modified';
    case 'D': return 'Deleted';
    case 'R': return 'Renamed';
    case 'C': return 'Copied';
    case 'T': return 'Type changed';
    case 'U': return 'Conflict';
    default: return change.status.trim() || 'Changed';
  }
};

/** Cheap client-side screen for obviously invalid branch names; the server remains authoritative. */
export function branchNameProblem(name: string): string | null {
  const value = name.trim();
  if (!value) return 'Enter a branch name.';
  if (value.length > 200) return 'Branch names are limited to 200 characters.';
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(value)) return 'Branch names cannot contain spaces or any of ~ ^ : ? * [ \\.';
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return 'That is not a valid Git branch name.';
  if (value.includes('..') || value.includes('//') || value.includes('@{') || value === '@') return 'That is not a valid Git branch name.';
  return null;
}

import type { GitHubState } from '@relay/contracts';
import { ghApi, ghRun, classify, isRepositorySlug, type GhFailure, type GhResult } from './gh.ts';
import { scrub } from './scrub.ts';

type PullRequest = NonNullable<GitHubState['pullRequest']>;
type Check = GitHubState['checks'][number];
type Workflow = GitHubState['workflows'][number];
export type CiState = 'none' | 'pending' | 'success' | 'failure';

export interface GitHubTarget {
  repository: string;
  /** Local branch name, or null while HEAD is detached. */
  branch: string | null;
  /** Branch name on the remote (differs from `branch` when the upstream was configured under another name). */
  remoteBranch: string | null;
  head: string;
}

export interface PullRequestInfo extends PullRequest { headSha: string | null; updatedAt: string }

const TTL_MS = 30_000;
const MIN_REFRESH_MS = 5_000;
const MAX_CACHE = 50;
const MAX_ITEMS = 100;
const MAX_RUNS = 20;
const SHA = /^[0-9a-f]{40,64}$/;
const BRANCH_ARG = /^[^\u0000-\u001f\u007f]{1,255}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 300): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const httpsUrl = (v: unknown): string | null => {
  const value = str(v, 2048);
  if (!value) return null;
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
};

/** Open pull requests rank first, then the most recently updated; pull requests from forks sharing the branch name are ignored. */
export async function listPullRequests(repository: string, branch: string, signal?: AbortSignal): Promise<GhResult<PullRequestInfo[]>> {
  if (!isRepositorySlug(repository) || !BRANCH_ARG.test(branch)) return { ok: false, failure: { kind: 'other', status: null, message: 'Invalid repository or branch.' } };
  const result = await ghRun(['pr', 'list', '--repo', repository, `--head=${branch}`, '--state', 'all', '--limit', '10', '--json', 'number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,headRepositoryOwner,updatedAt'], { signal });
  if (result.code !== 0 || result.spawnError) return { ok: false, failure: classify(result) };
  let rows: unknown;
  try { rows = JSON.parse(result.stdout); } catch { return { ok: false, failure: { kind: 'other', status: null, message: 'GitHub returned a pull request list Relay could not read.' } }; }
  if (!Array.isArray(rows)) return { ok: false, failure: { kind: 'other', status: null, message: 'GitHub returned an unexpected pull request list.' } };
  const owner = repository.split('/')[0]!.toLowerCase();
  const prefix = `https://github.com/${repository}/pull/`.toLowerCase();
  const found: PullRequestInfo[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const headOwner = isRecord(row.headRepositoryOwner) ? str(row.headRepositoryOwner.login)?.toLowerCase() : undefined;
    const url = httpsUrl(row.url);
    const number = typeof row.number === 'number' && Number.isInteger(row.number) ? row.number : null;
    if (!url || number === null || !url.toLowerCase().startsWith(prefix) || str(row.headRefName) !== branch || (headOwner && headOwner !== owner)) continue;
    found.push({
      number, title: str(row.title) ?? '', url, state: str(row.state, 20) ?? 'UNKNOWN', isDraft: row.isDraft === true, baseBranch: str(row.baseRefName) ?? '',
      headBranch: branch, headSha: SHA.test(str(row.headRefOid, 80) ?? '') ? str(row.headRefOid, 80) : null, updatedAt: str(row.updatedAt, 40) ?? '',
    });
  }
  found.sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.updatedAt.localeCompare(a.updatedAt));
  return { ok: true, data: found };
}

async function fetchChecks(repository: string, head: string, signal?: AbortSignal): Promise<GhResult<{ checks: Check[]; notices: string[] }>> {
  const [runs, statuses] = await Promise.all([
    ghApi(`repos/${repository}/commits/${head}/check-runs?per_page=${MAX_ITEMS}`, signal),
    ghApi(`repos/${repository}/commits/${head}/status?per_page=${MAX_ITEMS}`, signal),
  ]);
  if (!runs.ok && !statuses.ok) return runs;
  const checks: Check[] = [];
  const notices: string[] = [];
  if (runs.ok && isRecord(runs.data) && Array.isArray(runs.data.check_runs)) {
    for (const row of runs.data.check_runs.slice(0, MAX_ITEMS)) {
      if (!isRecord(row) || typeof row.id !== 'number') continue;
      checks.push({ id: `check-${row.id}`, name: str(row.name, 200) ?? 'check', status: str(row.status, 40) ?? 'unknown', conclusion: str(row.conclusion, 40), url: httpsUrl(row.html_url) ?? httpsUrl(row.details_url) });
    }
    if (typeof runs.data.total_count === 'number' && runs.data.total_count > MAX_ITEMS) notices.push(`Showing the first ${MAX_ITEMS} of ${runs.data.total_count} check runs.`);
  } else if (!runs.ok) notices.push(`Check runs: ${runs.failure.message}`);
  if (statuses.ok && isRecord(statuses.data) && Array.isArray(statuses.data.statuses)) {
    for (const row of statuses.data.statuses.slice(0, MAX_ITEMS)) {
      if (!isRecord(row) || typeof row.id !== 'number') continue;
      const state = str(row.state, 20) ?? 'pending';
      checks.push({ id: `status-${row.id}`, name: str(row.context, 200) ?? 'status', status: state === 'pending' ? 'pending' : 'completed', conclusion: state === 'pending' ? null : state, url: httpsUrl(row.target_url) });
    }
  } else if (!statuses.ok) notices.push(`Commit statuses: ${statuses.failure.message}`);
  return { ok: true, data: { checks, notices } };
}

async function fetchWorkflows(repository: string, head: string, signal?: AbortSignal): Promise<GhResult<{ workflows: Workflow[]; notices: string[] }>> {
  const result = await ghApi(`repos/${repository}/actions/runs?head_sha=${head}&per_page=${MAX_RUNS}`, signal);
  if (!result.ok) return result;
  const workflows: Workflow[] = [];
  const notices: string[] = [];
  const rows = isRecord(result.data) && Array.isArray(result.data.workflow_runs) ? result.data.workflow_runs : [];
  for (const row of rows.slice(0, MAX_RUNS)) {
    if (!isRecord(row) || typeof row.id !== 'number') continue;
    const headSha = str(row.head_sha, 80)?.toLowerCase();
    const url = httpsUrl(row.html_url);
    if (headSha !== head || !url) continue; // never present a run for another commit as current
    workflows.push({
      id: String(row.id), name: str(row.name, 200) ?? 'workflow', title: str(row.display_title, 300) ?? str(row.name, 200) ?? '', status: str(row.status, 40) ?? 'unknown',
      conclusion: str(row.conclusion, 40), url, headSha, branch: str(row.head_branch, 255) ?? '', createdAt: str(row.created_at, 40) ?? '', updatedAt: str(row.updated_at, 40) ?? '',
    });
  }
  workflows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (isRecord(result.data) && typeof result.data.total_count === 'number' && result.data.total_count > MAX_RUNS) notices.push(`Showing the ${MAX_RUNS} most recent of ${result.data.total_count} workflow runs for this commit.`);
  return { ok: true, data: { workflows, notices } };
}

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'error']);
const PASSING = new Set(['success', 'neutral', 'skipped']);

/** Aggregate state of CI for the exact commit the state describes. */
export function ciSummary(state: Pick<GitHubState, 'checks' | 'workflows'>): CiState {
  const items = [...state.checks, ...(state.checks.length ? [] : state.workflows)];
  if (!items.length) return 'none';
  if (items.some((item) => item.status !== 'completed')) return 'pending';
  if (items.some((item) => item.conclusion !== null && FAILING.has(item.conclusion))) return 'failure';
  return items.every((item) => item.conclusion !== null && PASSING.has(item.conclusion)) ? 'success' : 'failure';
}

interface CacheEntry { at: number; state?: GitHubState; pending?: Promise<GitHubState> }

/** Reads GitHub state through the signed-in gh CLI. Results are cached and coalesced per exact (repository, branch, HEAD). */
export class GitHubReader {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly signal: AbortSignal, private readonly now: () => number = Date.now) {}

  invalidate(repository: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${repository}\0`)) this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  read(target: GitHubTarget, refresh: boolean): Promise<GitHubState> {
    const key = [target.repository, target.branch ?? '', target.remoteBranch ?? '', target.head].join('\0');
    const entry = this.cache.get(key);
    if (entry?.pending) return entry.pending;
    const age = entry ? this.now() - entry.at : Infinity;
    if (entry?.state && age < TTL_MS && !(refresh && age >= MIN_REFRESH_MS)) return Promise.resolve(entry.state);
    const fresh: CacheEntry = { at: entry?.at ?? 0, state: entry?.state };
    fresh.pending = this.fetch(target).then((state) => {
      fresh.state = state;
      fresh.at = this.now();
      fresh.pending = undefined;
      return state;
    }, (error: unknown) => {
      fresh.pending = undefined;
      throw error;
    });
    this.cache.delete(key);
    this.cache.set(key, fresh);
    while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return fresh.pending;
  }

  private async fetch(target: GitHubTarget): Promise<GitHubState> {
    const { repository, head } = target;
    const state: GitHubState = {
      status: 'available', repository, url: `https://github.com/${repository}`, branch: target.branch, head, pullRequest: null, checks: [], workflows: [],
      fetchedAt: new Date().toISOString(), notices: [],
    };
    if (!isRepositorySlug(repository) || !SHA.test(head)) return { ...state, status: 'unsupported', notices: ['This repository cannot be queried on GitHub.'] };
    const [prs, checks, workflows] = await Promise.all([
      target.remoteBranch ? listPullRequests(repository, target.remoteBranch, this.signal) : Promise.resolve(null),
      fetchChecks(repository, head, this.signal),
      fetchWorkflows(repository, head, this.signal),
    ]);
    const failures: GhFailure[] = [];
    const notices = new Set<string>();
    const note = (label: string, failure: GhFailure) => {
      failures.push(failure);
      // A 422 for a commit lookup means the commit is not on GitHub (yet).
      notices.add(failure.kind === 'unprocessable' && /no commit found/i.test(failure.message) ? 'This commit has not been pushed to GitHub, so there are no checks for it yet.' : `${label}: ${failure.message}`);
    };

    if (prs?.ok) {
      const pr = prs.data[0];
      if (pr) {
        const { headSha, updatedAt: _updatedAt, ...visible } = pr;
        state.pullRequest = visible;
        if (headSha && headSha !== head) notices.add(`The pull request head (${headSha.slice(0, 7)}) differs from the local HEAD (${head.slice(0, 7)}).`);
        if (pr.state !== 'OPEN') notices.add(`The most recent pull request for this branch is ${pr.state.toLowerCase()}.`);
      }
    } else if (prs) note('Pull request', prs.failure);

    if (checks.ok) { state.checks = checks.data.checks; for (const n of checks.data.notices) notices.add(n); } else note('Checks', checks.failure);
    if (workflows.ok) { state.workflows = workflows.data.workflows; for (const n of workflows.data.notices) notices.add(n); } else note('Workflow runs', workflows.failure);

    const attempted = (prs ? 1 : 0) + 2;
    const fatal = failures.find((f) => ['missing', 'auth', 'rate-limit', 'timeout', 'cancelled'].includes(f.kind));
    if (failures.length >= attempted && !failures.every((f) => f.kind === 'unprocessable')) {
      // Nothing could be read: report the most actionable cause once and mark GitHub unavailable.
      state.status = 'unavailable';
      state.notices = fatal ? [fatal.message] : [...notices];
    } else {
      state.notices = [...notices];
      if (state.checks.length === 0 && state.workflows.length === 0 && failures.length === 0) state.notices.push('GitHub reports no checks or workflow runs for this exact commit.');
    }
    state.notices = state.notices.map((n) => scrub(n, 300));
    return state;
  }
}

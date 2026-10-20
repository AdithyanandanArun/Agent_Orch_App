import type { GitHubState } from '@relay/contracts';
import { ghApi, ghRun, classify, isRepositorySlug, type GhFailure, type GhResult } from './gh.ts';
import { scrub } from './scrub.ts';

type PullRequest = NonNullable<GitHubState['pullRequest']>;
type Check = GitHubState['checks'][number];
type Workflow = GitHubState['workflows'][number];
export type CiState = 'none' | 'unknown' | 'pending' | 'success' | 'neutral' | 'failure';

/** GitHubState plus completeness flags: false means a read failed, was truncated or had an unexpected shape, so "all passed" must not be claimed. */
export type GitHubReading = GitHubState & { checksComplete?: boolean; workflowsComplete?: boolean };

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
const MAX_WORKFLOWS_SHOWN = 30;
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

async function fetchChecks(repository: string, head: string, signal?: AbortSignal): Promise<GhResult<{ checks: Check[]; notices: string[]; complete: boolean }>> {
  const [runs, statuses] = await Promise.all([
    ghApi(`repos/${repository}/commits/${head}/check-runs?per_page=${MAX_ITEMS}`, signal),
    ghApi(`repos/${repository}/commits/${head}/status?per_page=${MAX_ITEMS}`, signal),
  ]);
  if (!runs.ok && !statuses.ok) return runs;
  const checks: Check[] = [];
  const notices: string[] = [];
  let complete = true;
  if (runs.ok && isRecord(runs.data) && Array.isArray(runs.data.check_runs)) {
    for (const row of runs.data.check_runs.slice(0, MAX_ITEMS)) {
      if (!isRecord(row) || typeof row.id !== 'number') { complete = false; continue; }
      checks.push({ id: `check-${row.id}`, name: str(row.name, 200) ?? 'check', status: str(row.status, 40) ?? 'unknown', conclusion: str(row.conclusion, 40), url: httpsUrl(row.html_url) ?? httpsUrl(row.details_url) });
    }
    if (typeof runs.data.total_count !== 'number' || runs.data.total_count > checks.length) {
      complete = false;
      if (typeof runs.data.total_count === 'number') notices.push(`Showing ${checks.length} of ${runs.data.total_count} check runs.`);
    }
  } else {
    complete = false;
    notices.push(runs.ok ? 'Check runs: GitHub returned a response Relay could not read.' : `Check runs: ${runs.failure.message}`);
  }
  if (statuses.ok && isRecord(statuses.data) && Array.isArray(statuses.data.statuses)) {
    let counted = 0;
    for (const row of statuses.data.statuses.slice(0, MAX_ITEMS)) {
      if (!isRecord(row) || typeof row.id !== 'number') { complete = false; continue; }
      const state = str(row.state, 20) ?? 'pending';
      counted++;
      checks.push({ id: `status-${row.id}`, name: str(row.context, 200) ?? 'status', status: state === 'pending' ? 'pending' : 'completed', conclusion: state === 'pending' ? null : state, url: httpsUrl(row.target_url) });
    }
    if (typeof statuses.data.total_count !== 'number' || statuses.data.total_count > counted) {
      complete = false;
      if (typeof statuses.data.total_count === 'number') notices.push(`Showing ${counted} of ${statuses.data.total_count} commit statuses.`);
    }
  } else {
    complete = false;
    notices.push(statuses.ok ? 'Commit statuses: GitHub returned a response Relay could not read.' : `Commit statuses: ${statuses.failure.message}`);
  }
  if (!complete && !notices.length) notices.push('Some checks could not be read, so the check summary is incomplete.');
  return { ok: true, data: { checks, notices, complete } };
}

/**
 * Workflow runs for the exact commit plus recent history of the branch. Every run keeps its own headSha so callers can tell
 * current CI from older commits; only exact-head runs ever count toward the current summary.
 */
async function fetchWorkflows(repository: string, head: string, remoteBranch: string | null, signal?: AbortSignal): Promise<GhResult<{ workflows: Workflow[]; notices: string[]; complete: boolean }>> {
  const [exact, history] = await Promise.all([
    ghApi(`repos/${repository}/actions/runs?head_sha=${head}&per_page=${MAX_RUNS}`, signal),
    remoteBranch ? ghApi(`repos/${repository}/actions/runs?branch=${encodeURIComponent(remoteBranch)}&per_page=${MAX_RUNS}`, signal) : Promise.resolve(null),
  ]);
  if (!exact.ok && (!history || !history.ok)) return exact;
  const notices: string[] = [];
  let complete = exact.ok && (history === null || history.ok);
  const byId = new Map<string, Workflow>();
  const collect = (result: GhResult<unknown>, exactOnly: boolean) => {
    if (!result.ok) { notices.push(`Workflow runs: ${result.failure.message}`); return; }
    const data = result.data;
    const rows = isRecord(data) && Array.isArray(data.workflow_runs) ? data.workflow_runs : null;
    if (!rows) { complete = false; notices.push('Workflow runs: GitHub returned a response Relay could not read.'); return; }
    for (const row of rows.slice(0, MAX_RUNS)) {
      if (!isRecord(row) || typeof row.id !== 'number') { complete = false; continue; }
      const headSha = str(row.head_sha, 80)?.toLowerCase();
      const url = httpsUrl(row.html_url);
      if (!headSha || !SHA.test(headSha) || !url) { complete = false; continue; }
      if (exactOnly && headSha !== head) continue;
      // Branch history can include runs for same-named branches of forks; keep only this repository's own.
      const source = isRecord(row.head_repository) ? str(row.head_repository.full_name, 200)?.toLowerCase() : undefined;
      if (!exactOnly && source && source !== repository.toLowerCase()) continue;
      byId.set(String(row.id), {
        id: String(row.id), name: str(row.name, 200) ?? 'workflow', title: str(row.display_title, 300) ?? str(row.name, 200) ?? '', status: str(row.status, 40) ?? 'unknown',
        conclusion: str(row.conclusion, 40), url, headSha, branch: str(row.head_branch, 255) ?? '', createdAt: str(row.created_at, 40) ?? '', updatedAt: str(row.updated_at, 40) ?? '',
      });
    }
    if (exactOnly && (typeof (data as Record<string, unknown>).total_count !== 'number' || ((data as Record<string, unknown>).total_count as number) > rows.length)) {
      complete = false;
      notices.push(`Showing ${rows.length} of ${String((data as Record<string, unknown>).total_count)} workflow runs for this commit.`);
    }
  };
  collect(exact, true);
  if (history) collect(history, false);
  const all = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Runs for the current commit are never crowded out by older history.
  const current = all.filter((w) => w.headSha === head);
  const older = all.filter((w) => w.headSha !== head).slice(0, Math.max(0, MAX_WORKFLOWS_SHOWN - current.length));
  const workflows = [...current, ...older].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ok: true, data: { workflows, notices, complete } };
}

const PASSING = new Set(['success', 'neutral', 'skipped']);

/**
 * Aggregate CI state for the commit the state describes. Only checks (always for the exact HEAD) and workflow runs whose headSha equals
 * HEAD count; older-commit history never contributes. An incomplete read can report failure or pending, but never a pass.
 */
export function ciSummary(state: Pick<GitHubReading, 'checks' | 'workflows' | 'head' | 'checksComplete' | 'workflowsComplete'>): CiState {
  const current = state.workflows.filter((w) => w.headSha.toLowerCase() === state.head?.toLowerCase());
  const items = [...state.checks, ...(state.checks.length ? [] : current)];
  const complete = state.checksComplete !== false && (state.checks.length > 0 || state.workflowsComplete !== false);
  let result: CiState;
  if (!items.length) result = 'none';
  else if (items.some((item) => item.status !== 'completed')) result = 'pending';
  else if (items.some((item) => item.conclusion === null || !PASSING.has(item.conclusion))) result = 'failure';
  else result = items.some((item) => item.conclusion === 'success') ? 'success' : 'neutral';
  if (!complete && (result === 'none' || result === 'success' || result === 'neutral')) return 'unknown';
  return result;
}

interface CacheEntry { at: number; state?: GitHubReading; pending?: Promise<GitHubReading> }

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

  read(target: GitHubTarget, refresh: boolean): Promise<GitHubReading> {
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

  private async fetch(target: GitHubTarget): Promise<GitHubReading> {
    const { repository, head } = target;
    const state: GitHubReading = {
      status: 'available', repository, url: `https://github.com/${repository}`, branch: target.branch, head, pullRequest: null, checks: [], workflows: [],
      fetchedAt: new Date().toISOString(), notices: [],
    };
    if (!isRepositorySlug(repository) || !SHA.test(head)) return { ...state, status: 'unsupported', notices: ['This repository cannot be queried on GitHub.'] };
    const [prs, checks, workflows] = await Promise.all([
      target.remoteBranch ? listPullRequests(repository, target.remoteBranch, this.signal) : Promise.resolve(null),
      fetchChecks(repository, head, this.signal),
      fetchWorkflows(repository, head, target.remoteBranch, this.signal),
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

    if (checks.ok) { state.checks = checks.data.checks; state.checksComplete = checks.data.complete; for (const n of checks.data.notices) notices.add(n); } else { state.checksComplete = false; note('Checks', checks.failure); }
    if (workflows.ok) { state.workflows = workflows.data.workflows; state.workflowsComplete = workflows.data.complete; for (const n of workflows.data.notices) notices.add(n); } else { state.workflowsComplete = false; note('Workflow runs', workflows.failure); }

    const attempted = (prs ? 1 : 0) + 2;
    const fatal = failures.find((f) => ['missing', 'auth', 'rate-limit', 'timeout', 'cancelled'].includes(f.kind));
    if (failures.length >= attempted && !failures.every((f) => f.kind === 'unprocessable')) {
      // Nothing could be read: report the most actionable cause once and mark GitHub unavailable.
      state.status = 'unavailable';
      state.notices = fatal ? [fatal.message] : [...notices];
    } else {
      state.notices = [...notices];
      if (state.checks.length === 0 && !state.workflows.some((w) => w.headSha === head) && failures.length === 0) state.notices.push('GitHub reports no checks or workflow runs for this exact commit.');
    }
    state.notices = state.notices.map((n) => scrub(n, 300));
    return state;
  }
}

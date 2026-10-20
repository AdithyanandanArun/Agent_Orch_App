import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { GitHubState, RepositoryMutationResult, RepositoryState } from '@mingle/contracts';
import { api, errorMessage } from '../lib/api';
import { useMingle } from './store';

/** Visible status is re-read at most this often; mutations and finished runs refresh immediately. */
export const REPOSITORY_POLL_MS = 30_000;

export interface RepoEntry {
  repo: RepositoryState | null;
  repoError: string | null;
  repoLoading: boolean;
  repoAt: number;
  github: GitHubState | null;
  githubError: string | null;
  githubLoading: boolean;
}
export interface RepoScope { projectId: string; sessionId: string | null }

const BLANK: RepoEntry = { repo: null, repoError: null, repoLoading: false, repoAt: 0, github: null, githubError: null, githubLoading: false };
export const repoKey = (scope: RepoScope): string => `${scope.projectId}:${scope.sessionId ?? ''}`;

interface RepoStore { entries: Record<string, RepoEntry> }
export const useRepoStore = create<RepoStore>(() => ({ entries: {} }));

const patchEntry = (key: string, patch: Partial<RepoEntry>): void =>
  useRepoStore.setState((s) => ({ entries: { ...s.entries, [key]: { ...(s.entries[key] ?? BLANK), ...patch } } }));
const entryOf = (key: string): RepoEntry => useRepoStore.getState().entries[key] ?? BLANK;

// Each request class has a sequence number: only the newest request for a scope may write its result.
const repoSeq = new Map<string, number>();
const githubSeq = new Map<string, number>();
const repoCtl = new Map<string, AbortController>();
const githubCtl = new Map<string, AbortController>();
const bump = (map: Map<string, number>, key: string): number => { const next = (map.get(key) ?? 0) + 1; map.set(key, next); return next; };
const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

export async function loadGithub(scope: RepoScope, refresh = false): Promise<void> {
  const key = repoKey(scope);
  const seq = bump(githubSeq, key);
  githubCtl.get(key)?.abort();
  const ctl = new AbortController();
  githubCtl.set(key, ctl);
  patchEntry(key, { githubLoading: true });
  try {
    const github = await api.github(scope.projectId, scope.sessionId, refresh, ctl.signal);
    if (githubSeq.get(key) !== seq) return;
    patchEntry(key, { github, githubError: null, githubLoading: false });
  } catch (e) {
    if (isAbort(e) || githubSeq.get(key) !== seq) return;
    patchEntry(key, { githubError: errorMessage(e), githubLoading: false });
  }
}

/** GitHub state only describes the exact commit/branch it was read for; re-read when the local checkout moved. */
const githubOutdated = (entry: RepoEntry): boolean => {
  const repo = entry.repo;
  if (!repo?.isRepo || repo.remotes.length === 0) return false;
  return !entry.github || entry.github.head !== repo.head || entry.github.branch !== repo.branch;
};

export async function loadRepository(scope: RepoScope, options: { silent?: boolean; github?: boolean } = {}): Promise<void> {
  const key = repoKey(scope);
  const seq = bump(repoSeq, key);
  repoCtl.get(key)?.abort();
  const ctl = new AbortController();
  repoCtl.set(key, ctl);
  if (!options.silent || !entryOf(key).repo) patchEntry(key, { repoLoading: true });
  try {
    const repo = await api.repository(scope.projectId, scope.sessionId, ctl.signal);
    if (repoSeq.get(key) !== seq) return;
    patchEntry(key, { repo, repoError: null, repoLoading: false, repoAt: Date.now() });
    const repoNow = entryOf(key).repo;
    const remote = Boolean(repoNow?.isRepo && repoNow.remotes.length > 0);
    if (remote && (options.github || githubOutdated(entryOf(key)))) void loadGithub(scope);
  } catch (e) {
    if (isAbort(e) || repoSeq.get(key) !== seq) return;
    patchEntry(key, { repoError: errorMessage(e), repoLoading: false });
  }
}

/** Adopt the state returned by a mutation, invalidating any older in-flight status read. */
export function applyMutation(scope: RepoScope, result: RepositoryMutationResult, remote = false): void {
  const key = repoKey(scope);
  bump(repoSeq, key);
  repoCtl.get(key)?.abort();
  patchEntry(key, { repo: result.state, repoError: null, repoLoading: false, repoAt: Date.now() });
  if (result.state.isRepo && result.state.remotes.length > 0) void loadGithub(scope, remote);
}

interface Watch { count: number; scope: RepoScope; timer: number }
const watches = new Map<string, Watch>();

const canPoll = (): boolean => document.visibilityState === 'visible' && useMingle.getState().connection === 'online';
function tick(scope: RepoScope): void {
  if (canPoll()) void loadRepository(scope, { silent: true, github: true });
}
function onVisible(): void {
  if (document.visibilityState !== 'visible') return;
  for (const [key, watch] of watches) {
    if (Date.now() - entryOf(key).repoAt >= REPOSITORY_POLL_MS) tick(watch.scope);
  }
}

/** Reference-counted watch: one bounded poll per scope no matter how many surfaces show it. */
export function watchRepository(scope: RepoScope): () => void {
  const key = repoKey(scope);
  let watch = watches.get(key);
  if (!watch) {
    watch = { count: 0, scope, timer: window.setInterval(() => tick(scope), REPOSITORY_POLL_MS) };
    watches.set(key, watch);
    if (watches.size === 1) document.addEventListener('visibilitychange', onVisible);
    const entry = entryOf(key);
    if (!entry.repo || Date.now() - entry.repoAt >= REPOSITORY_POLL_MS) void loadRepository(scope, { silent: Boolean(entry.repo), github: true });
    else if (githubOutdated(entry)) void loadGithub(scope);
  }
  watch.count += 1;
  return () => {
    const current = watches.get(key);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    window.clearInterval(current.timer);
    watches.delete(key);
    repoCtl.get(key)?.abort();
    githubCtl.get(key)?.abort();
    bump(repoSeq, key);
    bump(githubSeq, key);
    patchEntry(key, { repoLoading: false, githubLoading: false });
    if (watches.size === 0) document.removeEventListener('visibilitychange', onVisible);
  };
}

/** Why Git mutations must wait: a provider run may be editing the same checkout. */
export function useMutationGuard(scope: RepoScope | null): string | null {
  const connection = useMingle((s) => s.connection);
  const busy = useMingle((s) => {
    if (!scope) return '';
    const sessions = s.boot?.sessions ?? [];
    if (scope.sessionId) {
      const session = sessions.find((x) => x.id === scope.sessionId);
      return session && (session.status === 'running' || session.status === 'waiting') ? session.name : '';
    }
    // The project folder is shared by every non-isolated session.
    return sessions.find((x) => x.projectId === scope.projectId && !x.isolated && (x.status === 'running' || x.status === 'waiting'))?.name ?? '';
  });
  if (connection !== 'online') return 'Disconnected from the Mingle server';
  if (busy) return `${busy} is running — wait for it to finish or interrupt it before changing Git state`;
  return null;
}

/** Re-read when runs in this scope start or finish, and when the server connection returns. */
function useRunSignal(scope: RepoScope | null): string {
  return useMingle((s) => {
    if (!scope) return '';
    const sessions = (s.boot?.sessions ?? []).filter((x) => (scope.sessionId ? x.id === scope.sessionId : x.projectId === scope.projectId));
    return `${s.connection}|${sessions.map((x) => `${x.id}:${x.status}`).join(',')}`;
  });
}

export interface RepositoryView {
  entry: RepoEntry;
  refresh: () => Promise<void>;
  refreshGithub: (force?: boolean) => Promise<void>;
  adopt: (result: RepositoryMutationResult, remote?: boolean) => void;
}

export function useRepository(scope: RepoScope | null): RepositoryView {
  const projectId = scope?.projectId ?? null;
  const sessionId = scope?.sessionId ?? null;
  const key = projectId ? repoKey({ projectId, sessionId }) : '';
  const entry = useRepoStore((s) => (key ? s.entries[key] : undefined)) ?? BLANK;
  const signal = useRunSignal(scope);
  const previousSignal = useRef(signal);

  useEffect(() => {
    if (!projectId) return undefined;
    return watchRepository({ projectId, sessionId });
  }, [projectId, sessionId]);

  useEffect(() => {
    const before = previousSignal.current;
    previousSignal.current = signal;
    if (!projectId || before === signal) return undefined;
    const timer = window.setTimeout(() => { void loadRepository({ projectId, sessionId }, { silent: true, github: true }); }, 500);
    return () => window.clearTimeout(timer);
  }, [signal, projectId, sessionId]);

  const refresh = useCallback(() => (projectId ? loadRepository({ projectId, sessionId }, { silent: true, github: true }) : Promise.resolve()), [projectId, sessionId]);
  const refreshGithub = useCallback((force = true) => (projectId ? loadGithub({ projectId, sessionId }, force) : Promise.resolve()), [projectId, sessionId]);
  const adopt = useCallback((result: RepositoryMutationResult, remote = false) => { if (projectId) applyMutation({ projectId, sessionId }, result, remote); }, [projectId, sessionId]);
  return { entry, refresh, refreshGithub, adopt };
}

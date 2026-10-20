import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { ProjectContext } from '@mingle/contracts';
import { api, errorMessage } from '../lib/api';
import { useMingle } from './store';

const IDLE_POLL_MS = 30_000;
const INDEXING_POLL_MS = 2_500;

export interface ContextEntry { context: ProjectContext | null; error: string | null; loading: boolean; refreshing: boolean }
const BLANK: ContextEntry = { context: null, error: null, loading: false, refreshing: false };

interface ContextStore { entries: Record<string, ContextEntry> }
export const useContextStore = create<ContextStore>(() => ({ entries: {} }));
const patchEntry = (id: string, patch: Partial<ContextEntry>): void =>
  useContextStore.setState((s) => ({ entries: { ...s.entries, [id]: { ...(s.entries[id] ?? BLANK), ...patch } } }));

const seqs = new Map<string, number>();
const controllers = new Map<string, AbortController>();
const bump = (id: string): number => { const next = (seqs.get(id) ?? 0) + 1; seqs.set(id, next); return next; };
const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

export async function loadContext(projectId: string): Promise<void> {
  // A rescan in flight returns the freshest context itself; reading now would only race it.
  if (useContextStore.getState().entries[projectId]?.refreshing) return;
  const seq = bump(projectId);
  controllers.get(projectId)?.abort();
  const ctl = new AbortController();
  controllers.set(projectId, ctl);
  if (!useContextStore.getState().entries[projectId]?.context) patchEntry(projectId, { loading: true });
  try {
    const context = await api.projectContext(projectId, ctl.signal);
    if (seqs.get(projectId) !== seq) return;
    patchEntry(projectId, { context, error: null, loading: false });
  } catch (e) {
    if (isAbort(e) || seqs.get(projectId) !== seq) return;
    patchEntry(projectId, { error: errorMessage(e), loading: false });
  }
}

const reloadTimers = new Map<string, number>();
/** Coalesces bursts of realtime hints (and several mounted surfaces) into one read. */
export function scheduleContextReload(projectId: string, delayMs = 1500): void {
  window.clearTimeout(reloadTimers.get(projectId));
  reloadTimers.set(projectId, window.setTimeout(() => { reloadTimers.delete(projectId); void loadContext(projectId); }, delayMs));
}

const rescans = new Map<string, number>();

/**
 * Explicit rescan: the server answers with the new context, which supersedes any older read.
 * `refreshing` is owned by the newest rescan, so it always clears when that one settles.
 */
export async function rescanContext(projectId: string): Promise<void> {
  if (useContextStore.getState().entries[projectId]?.refreshing) return;
  const token = (rescans.get(projectId) ?? 0) + 1;
  rescans.set(projectId, token);
  bump(projectId);
  controllers.get(projectId)?.abort();
  patchEntry(projectId, { refreshing: true, error: null });
  try {
    const context = await api.refreshProjectContext(projectId);
    bump(projectId);
    patchEntry(projectId, { context, error: null, loading: false, refreshing: false });
  } catch (e) {
    patchEntry(projectId, { error: errorMessage(e), loading: false, refreshing: false });
  } finally {
    if (rescans.get(projectId) === token) rescans.delete(projectId);
  }
}

interface Watch { count: number; timer: number | undefined }
const watches = new Map<string, Watch>();
const visible = (): boolean => document.visibilityState === 'visible' && useMingle.getState().connection === 'online';

function schedule(projectId: string): void {
  const watch = watches.get(projectId);
  if (!watch) return;
  window.clearTimeout(watch.timer);
  const indexing = useContextStore.getState().entries[projectId]?.context?.status === 'indexing';
  watch.timer = window.setTimeout(async () => {
    if (!watches.has(projectId)) return;
    if (visible()) await loadContext(projectId);
    schedule(projectId);
  }, indexing ? INDEXING_POLL_MS : IDLE_POLL_MS);
}

/** Shared by the Tasks, Activity, Map and overview surfaces: one bounded poll per project. */
export function watchContext(projectId: string): () => void {
  let watch = watches.get(projectId);
  if (!watch) {
    watch = { count: 0, timer: undefined };
    watches.set(projectId, watch);
    void loadContext(projectId).then(() => schedule(projectId));
  }
  watch.count += 1;
  return () => {
    const current = watches.get(projectId);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    window.clearTimeout(current.timer);
    watches.delete(projectId);
    controllers.get(projectId)?.abort();
    bump(projectId);
    patchEntry(projectId, { loading: false });
  };
}

export interface ProjectContextView { entry: ContextEntry; rescan: () => Promise<void>; reload: () => Promise<void> }

export function useProjectContext(projectId: string | null | undefined): ProjectContextView {
  const entry = useContextStore((s) => (projectId ? s.entries[projectId] : undefined)) ?? BLANK;
  // Realtime: workspace events for this project (task sync, runs) imply the scan summary may have moved.
  const latestEvent = useMingle((s) => {
    if (!projectId) return 0;
    let id = 0;
    for (const event of s.boot?.events ?? []) if (event.projectId === projectId && event.id > id) id = event.id;
    return id;
  });
  const seen = useRef(latestEvent);

  useEffect(() => (projectId ? watchContext(projectId) : undefined), [projectId]);
  useEffect(() => {
    const before = seen.current;
    seen.current = latestEvent;
    if (!projectId || before === latestEvent) return undefined;
    scheduleContextReload(projectId);
    return undefined;
  }, [latestEvent, projectId]);

  const rescan = useCallback(() => (projectId ? rescanContext(projectId) : Promise.resolve()), [projectId]);
  const reload = useCallback(() => (projectId ? loadContext(projectId) : Promise.resolve()), [projectId]);
  return { entry, rescan, reload };
}

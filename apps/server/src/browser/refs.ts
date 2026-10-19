/**
 * Snapshot refs handed to the agent are scoped to one tab and one snapshot: `<tabId>.<snapshot>.<nativeRef>`.
 * Playwright's own refs (e12, f1e3) are only meaningful for the latest snapshot of one page, so the prefix lets
 * Relay reject refs from another tab or from an older snapshot instead of acting on whatever element now has that name.
 */
const SCOPED_REF = /^(tab_[0-9a-f]{12})\.(\d{1,9})\.([A-Za-z0-9_-]{1,40})$/u;
const NATIVE_REF_ATTR = /\[ref=([A-Za-z0-9_-]+)\]/gu;

export interface ScopedRef { tabId: string; snapshot: number; native: string }

export function formatRef(tabId: string, snapshot: number, native: string): string {
  return `${tabId}.${snapshot}.${native}`;
}

export function parseRef(ref: string): ScopedRef | null {
  const match = SCOPED_REF.exec(ref);
  return match ? { tabId: match[1]!, snapshot: Number(match[2]), native: match[3]! } : null;
}

/** Rewrites every native `[ref=e12]` in an accessibility snapshot into its tab- and snapshot-scoped form. */
export function scopeRefs(aria: string, tabId: string, snapshot: number): string {
  return aria.replace(NATIVE_REF_ATTR, (_all, native: string) => `[ref=${formatRef(tabId, snapshot, native)}]`);
}

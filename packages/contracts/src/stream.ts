/** Merge a live text chunk with a possibly newer snapshot; null requests gap recovery. */
export function mergeTextDelta(current: string, offset: number, delta: string): string | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > current.length) return null;
  if (offset + delta.length <= current.length) return current;
  return current.slice(0, offset) + delta;
}

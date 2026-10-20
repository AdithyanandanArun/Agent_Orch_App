import { useEffect, useRef, useState } from 'react';

export const EXIT_MOTION_MS = 160;
export interface PresenceRow<T> { item: T; closing: boolean }

/** Keep a surface mounted just long enough to finish its exit, cancelling stale closes on reopen. */
export function usePresence(open: boolean, duration = EXIT_MOTION_MS): { present: boolean; closing: boolean } {
  const [present, setPresent] = useState(open);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const timeout = window.setTimeout(() => {
      if (generation.current !== current) return;
      setPresent(false);
    }, reduced ? 0 : duration);
    return () => window.clearTimeout(timeout);
  }, [open, present, duration]);

  return { present: open || present, closing: !open && present };
}

/** Retain the last logical value while closing, with a new identity for every distinct opening. */
export function useRetainedPresence<T>(value: T | null | undefined, duration = EXIT_MOTION_MS): {
  value: T | null; present: boolean; closing: boolean; key: number;
} {
  const sequence = useRef(0);
  const retained = useRef<{ value: T; key: number; closed: boolean } | null>(null);
  const open = value !== null && value !== undefined;

  if (open) {
    if (!retained.current || retained.current.closed || !Object.is(retained.current.value, value)) {
      retained.current = { value, key: ++sequence.current, closed: false };
    } else {
      retained.current.value = value;
    }
  } else if (retained.current) {
    retained.current.closed = true;
  }

  const presence = usePresence(open, duration);
  return {
    value: open ? value : retained.current?.value ?? null,
    key: retained.current?.key ?? 0,
    ...presence,
  };
}

/** Keep removed keyed rows rendered for an exit while allowing an item to be revived safely. */
export function usePresenceList<T extends { id: string | number }>(items: T[], duration = EXIT_MOTION_MS): PresenceRow<T>[] {
  const [rows, setRows] = useState<PresenceRow<T>[]>(() => items.map((item) => ({ item, closing: false })));
  const source = useRef(items);
  const timers = useRef(new Map<string | number, number>());
  source.current = items;

  useEffect(() => {
    setRows((current) => {
      const incoming = new Map(items.map((item) => [item.id, item]));
      let changed = false;
      const next = current.map((row) => {
        const item = incoming.get(row.item.id);
        if (!item) {
          if (!row.closing) { changed = true; return { ...row, closing: true }; }
          return row;
        }
        if (row.closing || !Object.is(row.item, item)) changed = true;
        incoming.delete(row.item.id);
        return { item, closing: false };
      });
      for (const item of incoming.values()) { next.push({ item, closing: false }); changed = true; }
      return changed ? next : current;
    });
  }, [items]);

  useEffect(() => {
    for (const [id, timer] of timers.current) {
      if (!rows.some((row) => row.item.id === id && row.closing)) {
        window.clearTimeout(timer);
        timers.current.delete(id);
      }
    }
    for (const row of rows) {
      if (!row.closing || timers.current.has(row.item.id)) continue;
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const timer = window.setTimeout(() => {
        timers.current.delete(row.item.id);
        if (source.current.some((item) => item.id === row.item.id)) return;
        setRows((current) => current.filter((item) => item.item.id !== row.item.id || !item.closing));
      }, reduced ? 0 : duration);
      timers.current.set(row.item.id, timer);
    }
  }, [rows, duration]);

  useEffect(() => () => { for (const timer of timers.current.values()) window.clearTimeout(timer); }, []);
  const presentIds = new Set(items.map((item) => item.id));
  return rows.map((row) => presentIds.has(row.item.id)
    ? row.closing ? { ...row, closing: false } : row
    : row.closing ? row : { ...row, closing: true });
}

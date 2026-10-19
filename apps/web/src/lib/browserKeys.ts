import type { BrowserAction } from '@relay/contracts';

/** DOM `KeyboardEvent.key` values whose Playwright name differs; everything else with a name of 2+ chars passes through. */
const NAMED: Record<string, string> = {
  ' ': 'Space', Esc: 'Escape', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
};
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'Dead', 'Process', 'Unidentified']);

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

/** Whether a keydown is an ordinary character (no command modifier), which is typed rather than pressed. */
const isPlainCharacter = (e: KeyLike): boolean => [...e.key].length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
const isAscii = (key: string): boolean => key.length === 1 && key >= ' ' && key <= '~';

/** The paste shortcut is handled by the clipboard event so the user's explicit paste is the only clipboard read. */
export const isPasteShortcut = (e: KeyLike): boolean =>
  (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v';

/**
 * Translates a DOM keydown into a remote action, or null for keys that have no remote meaning (bare modifiers,
 * IME states, the paste shortcut). Printable characters beyond ASCII use text insertion because Playwright's
 * `press` only knows the US layout.
 */
export function keyToAction(e: KeyLike): BrowserAction | null {
  if (MODIFIER_KEYS.has(e.key) || isPasteShortcut(e)) return null;
  if (isPlainCharacter(e)) return isAscii(e.key) ? { type: 'press', key: NAMED[e.key] ?? e.key } : { type: 'text', text: e.key };
  const base = NAMED[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (base.length > 1 && !/^[A-Za-z0-9]+$/.test(base)) return null;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean) as string[];
  return { type: 'press', key: [...mods, base].join('+') };
}

/** Splits pasted text into chunks the `text` action accepts without cutting a surrogate pair. */
export function chunkText(text: string, size = 10_000): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

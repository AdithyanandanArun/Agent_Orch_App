import { HttpError, unprocessable } from '../util.ts';
import { normalizeRelative } from '../paths.ts';

/** Handles that would be ambiguous with provider aliases or addressing words. */
export const RESERVED_HANDLES = new Set(['codex', 'claude', 'antigravity', 'all', 'everyone', 'team', 'group', 'user', 'human', 'relay', 'system']);

/**
 * Handles addressed in user prose. Fenced and indented code, inline code, quoted lines, URLs and e-mail addresses
 * are prose about handles, never addressing, so they are removed before scanning.
 */
export function extractMentions(content: string): string[] {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    if (marker) { fence = marker; continue; }
    if (/^\s{0,3}>/.test(line) || /^(?: {4}|\t)/.test(line)) continue;
    kept.push(line);
  }
  const text = kept.join('\n')
    .replace(/(`+)[^`]*?\1/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"|(?<![A-Za-z0-9_])'(?:\\.|[^'\\])*'|“[^”]*”|‘[^’]*’/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  const found: string[] = [];
  for (const match of text.matchAll(/(?<![A-Za-z0-9_@/.:-])@([A-Za-z][A-Za-z0-9_-]{1,31})(?![A-Za-z0-9_/-])/g)) {
    const handle = match[1]!.toLowerCase();
    if (!found.includes(handle)) found.push(handle);
  }
  return found;
}

/** Scope entries are relative files or directories; a trailing glob suffix means "this directory and below". */
export function normalizeScope(raw: string): string {
  let value = raw.trim();
  while (/(?:\/\*\*|\/\*|\/)$/.test(value)) value = value.replace(/(?:\/\*\*|\/\*|\/)$/, '');
  if (/[*?[\]{}!]/.test(value)) throw unprocessable(`Scope "${raw.slice(0, 80)}" must name a file or directory, not a pattern`);
  let normalized: string;
  try {
    normalized = normalizeRelative(value);
  } catch (error) {
    throw unprocessable(`Scope "${raw.slice(0, 80)}" is not allowed: ${error instanceof HttpError ? error.message : 'invalid path'}`);
  }
  if (!normalized) throw unprocessable('Scope must name specific files or directories, not the whole project');
  return normalized;
}

export function normalizeScopes(raw: string[]): string[] {
  const unique = [...new Set(raw.map(normalizeScope))].sort();
  // Drop entries already covered by a parent directory in the same assignment.
  return unique.filter((scope) => !unique.some((other) => other !== scope && scope.toLowerCase().startsWith(`${other.toLowerCase()}/`)));
}

export function scopesOverlap(a: string[], b: string[]): string | null {
  for (const left of a) {
    for (const right of b) {
      const l = left.toLowerCase();
      const r = right.toLowerCase();
      if (l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`)) return l.length <= r.length ? left : right;
    }
  }
  return null;
}

export function safeArtifactPath(raw: string): string {
  let normalized: string;
  try {
    normalized = normalizeRelative(raw);
  } catch (error) {
    throw unprocessable(`Artifact path is not allowed: ${error instanceof HttpError ? error.message : 'invalid path'}`);
  }
  if (!normalized) throw unprocessable('Artifact path must name a file');
  return normalized;
}

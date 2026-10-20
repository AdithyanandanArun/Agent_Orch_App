import { createHash } from 'node:crypto';

export interface ChecklistItem { text: string; checked: boolean; line: number; heading: string | null }
export interface CommentMarker { marker: string; text: string; line: number }
export type CommentStyle = 'c' | 'hash' | 'sql' | 'html';

const ITEM = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+\[([ xX])\]\s+(\S.*?)\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const MARKER = /^(TODO|FIXME|HACK|XXX)\b(?:\([^)]{0,40}\))?\s*[:\-–]?\s*(.*)$/;

export function cleanInline(text: string, max = 200): string {
  const cleaned = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

/** Stable identity for a piece of text: independent of case, spacing, markup and line position. */
export function textKey(text: string): string {
  const normal = cleanInline(text, 1000).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return createHash('sha1').update(normal).digest('hex').slice(0, 12);
}

/**
 * GFM task-list items outside fenced code, HTML comments and indented code blocks. Deeply indented items only count
 * while they continue an actual list, so a code example indented after prose is not mistaken for work.
 */
export function extractChecklist(text: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const lines = text.split(/\r?\n/);
  let fence: { char: string; length: number } | null = null;
  let inComment = false;
  let inList = false;
  let heading: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length && line.trim() === close[1]) fence = null;
      continue;
    }
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    const open = FENCE.exec(line);
    if (open) { fence = { char: open[1]![0]!, length: open[1]!.length }; inList = false; continue; }
    if (line.trimStart().startsWith('<!--') && !line.includes('-->')) { inComment = true; continue; }
    if (line.trim() === '') continue;
    const match = ITEM.exec(line.replace(/\t/g, '    '));
    if (match) {
      const indent = match[1]!.length;
      if (indent < 4 || inList) {
        const cleaned = cleanInline(match[3]!);
        if (cleaned.length >= 2) items.push({ text: cleaned, checked: match[2] !== ' ', line: index + 1, heading });
        inList = true;
        continue;
      }
    }
    const head = HEADING.exec(line);
    if (head) { heading = cleanInline(head[1]!, 100); inList = false; continue; }
    // A continuation of a list item stays indented; a flush-left paragraph ends the list.
    if (!/^\s/.test(line) && !/^(?:[-*+]|\d{1,3}[.)])\s/.test(line)) inList = false;
    else if (/^(?:[-*+]|\d{1,3}[.)])\s/.test(line.trimStart())) inList = true;
  }
  return items;
}

const NEWLINE = '\n';

/**
 * Marker comments (TODO/FIXME/HACK/XXX written in upper case at the start of a comment). The lexer tracks string and
 * template literals so text inside them is never read as a comment. It is deliberately conservative: when a
 * construct confuses it, a marker is missed rather than invented.
 */
export function extractCommentMarkers(text: string, style: CommentStyle): CommentMarker[] {
  const found: CommentMarker[] = [];
  const emit = (raw: string, line: number, strip: RegExp) => {
    const match = MARKER.exec(raw.replace(strip, ''));
    if (!match) return;
    const body = match[2]!.replace(/\*\/\s*$/, '').trim();
    if (body.length < 3) return;
    found.push({ marker: match[1]!, text: cleanInline(body), line });
  };
  const n = text.length;
  let i = 0;
  let line = 1;
  const lineStart = () => i === 0 || text[i - 1] === NEWLINE;
  const afterSpace = () => i === 0 || /\s/.test(text[i - 1]!);
  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === NEWLINE) { line++; i++; continue; }
    // line comments
    const lineComment = style === 'c' ? ch === '/' && next === '/' : style === 'sql' ? ch === '-' && next === '-' : style === 'hash' ? ch === '#' && afterSpace() && !(lineStart() && next === '!') : false;
    if (lineComment) {
      let end = text.indexOf(NEWLINE, i);
      if (end < 0) end = n;
      emit(text.slice(i + (style === 'hash' ? 1 : 2), end), line, /^[\s/!#\-]+/);
      i = end;
      continue;
    }
    // block comments
    const blockOpen = (style === 'c' || style === 'sql') && ch === '/' && next === '*' ? '*/' : style === 'html' && text.startsWith('<!--', i) ? '-->' : null;
    if (blockOpen) {
      let end = text.indexOf(blockOpen, i + 2);
      if (end < 0) end = n;
      const body = text.slice(i + (blockOpen === '-->' ? 4 : 2), end);
      body.split(NEWLINE).forEach((part, offset) => emit(part, line + offset, /^[\s*]+/));
      line += body.split(NEWLINE).length - 1;
      i = Math.min(n, end + blockOpen.length);
      continue;
    }
    if (style !== 'html' && (ch === '"' || ch === "'" || ch === '`')) {
      const triple = style === 'hash' && ch !== '`' && text.startsWith(ch.repeat(3), i);
      const multiline = ch === '`' || triple;
      const closer = triple ? ch.repeat(3) : ch;
      let j = i + closer.length;
      for (; j < n; j++) {
        const c = text[j]!;
        if (c === '\\') { if (text[j + 1] === NEWLINE) line++; j++; continue; }
        if (c === NEWLINE) { if (!multiline) break; line++; }
        if (text.startsWith(closer, j)) { j += closer.length; break; }
      }
      i = Math.max(j, i + 1);
      continue;
    }
    i++;
  }
  return found;
}

const EXT_STYLE: Record<string, CommentStyle> = {};
for (const ext of ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'java', 'kt', 'kts', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'swift', 'scala', 'dart', 'php', 'scss', 'less']) EXT_STYLE[ext] = 'c';
for (const ext of ['py', 'rb', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml', 'pl', 'r']) EXT_STYLE[ext] = 'hash';
for (const ext of ['sql', 'lua']) EXT_STYLE[ext] = 'sql';
for (const ext of ['html', 'htm', 'vue', 'svelte']) EXT_STYLE[ext] = 'html';

const GENERATED = /(?:\.min\.|\.d\.ts$|\.d\.mts$|\.d\.cts$|\.generated\.|\.gen\.|_pb2?\.|\.pb\.go$|\.test\.|\.spec\.|-lock\.|\.lock$)/i;

/** Comment syntax for a source file, or null for files whose comments are not mined (tests, generated, unknown). */
export function commentStyleFor(rel: string): CommentStyle | null {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (GENERATED.test(base)) return null;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXT_STYLE[base.slice(dot + 1).toLowerCase()] ?? null;
}

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++',
  cs: 'C#', rb: 'Ruby', php: 'PHP', scala: 'Scala', dart: 'Dart', lua: 'Lua', r: 'R', sh: 'Shell', bash: 'Shell', zsh: 'Shell', sql: 'SQL',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less', vue: 'Vue', svelte: 'Svelte', md: 'Markdown', markdown: 'Markdown',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', ex: 'Elixir', exs: 'Elixir', hs: 'Haskell', zig: 'Zig', pl: 'Perl',
};

export function languageFor(rel: string): string | null {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) return 'Dockerfile';
  if (base === 'Makefile') return 'Makefile';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? null : LANGUAGES[base.slice(dot + 1).toLowerCase()] ?? null;
}

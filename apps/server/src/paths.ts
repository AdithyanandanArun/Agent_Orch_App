import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { FileEntry } from '@mingle/contracts';
import { HttpError } from './util.ts';

const DENIED_DIRS = new Set(['.git', '.mingle', '.relay', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker']);
const SECRET_EXACT = new Set([
  '.env', '.npmrc', '.netrc', '.pypirc', '.git-credentials', '.htpasswd', '.dockercfg',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'credentials.json', 'secrets.json',
]);
const SECRET_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.kdbx', '.secret', '.secrets'];
const SECRET_SAFE_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 5000;

export function isDeniedName(name: string): boolean {
  const lower = name.toLowerCase();
  if (DENIED_DIRS.has(lower)) return true;
  if (SECRET_EXACT.has(lower)) return true;
  if (lower.startsWith('.env.') && !SECRET_SAFE_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(lower)) return true;
  return SECRET_SUFFIXES.some((s) => lower.endsWith(s));
}

/** Pathspec exclusions used so secret files never appear in generated diffs. */
export const SECRET_PATHSPEC_EXCLUDES: string[] = [
  ':(exclude,glob)**/.env', ':(exclude,glob)**/.env.*', ':(exclude,glob)**/*.pem', ':(exclude,glob)**/*.key',
  ':(exclude,glob)**/*.p12', ':(exclude,glob)**/*.pfx', ':(exclude,glob)**/id_rsa*', ':(exclude,glob)**/id_ed25519*',
  ':(exclude,glob)**/id_ecdsa*', ':(exclude,glob)**/.npmrc', ':(exclude,glob)**/.netrc', ':(exclude,glob)**/.pypirc',
  ':(exclude,glob)**/credentials*', ':(exclude,glob)**/*.secret', ':(exclude,glob)**/*.secrets', ':(exclude,glob)**/.ssh/**',
  ':(exclude,glob)**/.aws/**', ':(exclude,glob)**/.gnupg/**',
];

export function pathError(status: number, message: string) {
  return new HttpError(status, message);
}

/** Validates a client-supplied relative path and returns its normalised POSIX form ('' for the root). */
export function normalizeRelative(input: string | undefined | null): string {
  const raw = input ?? '';
  if (raw.length > 4096) throw pathError(400, 'Path is too long');
  if (raw.includes('\0')) throw pathError(400, 'Path contains a NUL byte');
  if (raw.includes('\\')) throw pathError(400, 'Backslashes are not allowed in paths');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw pathError(400, 'Path must be relative to the project root');
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw pathError(403, 'Path escapes the project root');
    if (isDeniedName(part)) throw pathError(403, `Access to "${part}" is not allowed`);
    parts.push(part);
  }
  return parts.join('/');
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export interface ResolvedPath {
  /** Canonical absolute path (symlinks resolved) inside the root. */
  real: string;
  /** POSIX relative path as requested. */
  rel: string;
  root: string;
}

/**
 * Resolves a relative path below `root`, following symlinks and refusing anything that lands outside the root
 * or on a denied component (.git, secrets). Missing targets are allowed when `allowMissing` is set, provided
 * their nearest existing ancestor is inside the root.
 */
export async function resolveInside(root: string, input: string | undefined | null, options: { allowMissing?: boolean } = {}): Promise<ResolvedPath> {
  const rel = normalizeRelative(input);
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    throw pathError(404, 'Workspace directory does not exist');
  }
  const abs = rel ? path.join(realRoot, ...rel.split('/')) : realRoot;
  let real: string;
  try {
    real = await fsp.realpath(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw pathError(404, 'Path not found');
    // A dangling symlink reports ENOENT from realpath; never treat it as a creatable path.
    const link = await fsp.lstat(abs).catch(() => null);
    if (link?.isSymbolicLink()) throw pathError(403, 'Refusing to follow a dangling symlink');
    if (!options.allowMissing) throw pathError(404, 'Path not found');
    let ancestor = path.dirname(abs);
    const tail: string[] = [path.basename(abs)];
    for (;;) {
      try {
        const resolved = await fsp.realpath(ancestor);
        real = path.join(resolved, ...tail);
        break;
      } catch {
        if (ancestor === path.dirname(ancestor)) throw pathError(404, 'Path not found');
        tail.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
  }
  if (!isInside(realRoot, real)) throw pathError(403, 'Path escapes the project root');
  const realRel = path.relative(realRoot, real);
  if (realRel) {
    for (const part of realRel.split(path.sep)) {
      if (isDeniedName(part)) throw pathError(403, `Access to "${part}" is not allowed`);
    }
  }
  return { real, rel, root: realRoot };
}

export async function listDirectory(root: string, input: string | undefined | null): Promise<FileEntry[]> {
  const target = await resolveInside(root, input);
  const stat = await fsp.stat(target.real);
  if (!stat.isDirectory()) throw pathError(400, 'Path is not a directory');
  const dirents = await fsp.readdir(target.real, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    if (entries.length >= MAX_LIST_ENTRIES) break;
    if (isDeniedName(dirent.name)) continue;
    const entryRel = target.rel ? `${target.rel}/${dirent.name}` : dirent.name;
    let type: FileEntry['type'] | null = null;
    if (dirent.isDirectory()) type = 'directory';
    else if (dirent.isFile()) type = 'file';
    else if (dirent.isSymbolicLink()) {
      // Only list symlinks that stay inside the root, using the type of their target.
      try {
        const resolved = await resolveInside(root, entryRel);
        const st = await fsp.stat(resolved.real);
        type = st.isDirectory() ? 'directory' : st.isFile() ? 'file' : null;
      } catch {
        type = null;
      }
    }
    if (type) entries.push({ path: entryRel, name: dirent.name, type });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  return entries;
}

/** Bounded session-worktree search for the composer file picker. Symlinks are deliberately not traversed here. */
export async function searchFiles(root: string, query: string): Promise<FileEntry[]> {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle || needle.length > 100) return [];
  const results: FileEntry[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }];
  let visited = 0;
  let scanned = 0;
  while (pending.length && visited < 250 && scanned < 10_000 && results.length < 100) {
    const current = pending.shift()!;
    let target: ResolvedPath;
    try { target = await resolveInside(root, current.path); } catch { continue; }
    const stat = await fsp.stat(target.real).catch(() => null);
    if (!stat?.isDirectory()) continue;
    visited++;
    const entries = await fsp.readdir(target.real, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++scanned > 10_000) break;
      if (isDeniedName(entry.name) || entry.isSymbolicLink()) continue;
      const rel = current.path ? `${current.path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'vendor' && current.depth < 8) {
          if (`${rel}/${entry.name}`.toLocaleLowerCase().includes(needle) || rel.toLocaleLowerCase().includes(needle)) results.push({ path: rel, name: entry.name, type: 'directory' });
          pending.push({ path: rel, depth: current.depth + 1 });
        }
      } else if (entry.isFile() && `${rel}`.toLocaleLowerCase().includes(needle)) results.push({ path: rel, name: entry.name, type: 'file' });
      if (results.length >= 100) break;
    }
  }
  return results.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'directory' ? -1 : 1));
}

export async function readTextFile(root: string, input: string): Promise<{ content: string; path: string }> {
  const target = await resolveInside(root, input);
  if (!target.rel) throw pathError(400, 'Path is a directory');
  const stat = await fsp.stat(target.real);
  if (!stat.isFile()) throw pathError(400, 'Path is not a regular file');
  if (stat.size > MAX_TEXT_BYTES) throw pathError(413, 'File is too large to open in the editor');
  const buffer = await fsp.readFile(target.real);
  if (buffer.subarray(0, 8192).includes(0)) throw pathError(415, 'Binary files cannot be opened as text');
  return { content: buffer.toString('utf8'), path: target.rel };
}

export async function writeTextFile(root: string, input: string, content: string): Promise<{ content: string; path: string }> {
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw pathError(413, 'Content is too large');
  const target = await resolveInside(root, input, { allowMissing: true });
  if (!target.rel) throw pathError(400, 'Path is a directory');
  const existing = await fsp.lstat(target.real).catch(() => null);
  if (existing && !existing.isFile()) throw pathError(400, 'Path is not a regular file');
  const parent = await fsp.stat(path.dirname(target.real)).catch(() => null);
  if (!parent?.isDirectory()) throw pathError(404, 'Parent directory does not exist');
  // O_NOFOLLOW closes the window where the final component is swapped for a symlink after validation.
  const handle = await fsp.open(target.real, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return { content, path: target.rel };
}

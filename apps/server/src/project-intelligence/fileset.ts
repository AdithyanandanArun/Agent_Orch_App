import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { RepoInfo } from '../git.ts';
import { git } from '../git.ts';
import { isDeniedName, resolveInside } from '../paths.ts';
import { HttpError } from '../util.ts';
import type { Budget } from './limits.ts';
import { EXCLUDED_DIRS, LIMITS, SAMPLE_DIRS } from './limits.ts';

export interface FileListing {
  /** Eligible project-relative POSIX paths, sorted, capped at LIMITS.maxFiles. */
  files: string[];
  /** Eligible files seen, including any beyond the cap. */
  total: number;
  /** Paths skipped for vendor/build/ignored-secret reasons. */
  excluded: number;
  symlinks: number;
  /** True only when every eligible path was enumerated; absence of a path is trustworthy only then. */
  complete: boolean;
  method: 'git' | 'walk';
  notices: string[];
}

export const isExcludedSegment = (name: string): boolean => EXCLUDED_DIRS.has(name.toLowerCase()) || isDeniedName(name);
export const isExcludedPath = (rel: string): boolean => rel.split('/').some(isExcludedSegment);
/** Example/test locations: scanned for languages and components, never mined for tasks. */
export const isSamplePath = (rel: string): boolean => rel.split('/').slice(0, -1).some((part) => SAMPLE_DIRS.has(part.toLowerCase()));

async function listWithGit(root: string): Promise<{ paths: string[]; deleted: Set<string> } | null> {
  try {
    const [listed, deleted] = await Promise.all([
      git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { timeoutMs: 15_000, maxBuffer: 48 * 1024 * 1024 }),
      git(root, ['ls-files', '-z', '--deleted', '--', '.'], { timeoutMs: 15_000, maxBuffer: 16 * 1024 * 1024 }),
    ]);
    const split = (out: string) => out.split('\0').filter(Boolean);
    return { paths: split(listed.stdout), deleted: new Set(split(deleted.stdout)) };
  } catch {
    return null;
  }
}

async function walk(root: string, budget: Budget): Promise<FileListing> {
  const files: string[] = [];
  const result: FileListing = { files, total: 0, excluded: 0, symlinks: 0, complete: true, method: 'walk', notices: [] };
  const stack: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  let dirs = 0;
  while (stack.length) {
    const { rel, depth } = stack.pop()!;
    if (budget.expired() || dirs >= LIMITS.maxWalkDirs) { result.complete = false; break; }
    dirs++;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true });
    } catch {
      result.complete = false;
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1)); // reversed so the stack pops in ascending order
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (isExcludedSegment(entry.name)) { result.excluded++; continue; }
      if (entry.isSymbolicLink()) { result.symlinks++; continue; }
      if (entry.isDirectory()) {
        if (depth + 1 > LIMITS.maxWalkDepth) { result.complete = false; continue; }
        stack.push({ rel: child, depth: depth + 1 });
      } else if (entry.isFile()) {
        result.total++;
        if (files.length < LIMITS.maxFiles) files.push(child);
        else result.complete = false;
      }
    }
  }
  files.sort();
  if (!result.complete) result.notices.push('The file listing stopped at a scan limit, so counts are partial and no tracked source was marked missing.');
  return result;
}

/** Enumerates eligible files. Git projects honour .gitignore; other folders skip dependency/build/secret directories and all symlinks. */
export async function listFiles(root: string, info: RepoInfo, budget: Budget): Promise<FileListing> {
  if (info.isRepo) {
    const listed = await listWithGit(root);
    if (listed) {
      const seen = new Set<string>();
      const files: string[] = [];
      let excluded = 0;
      for (const rel of listed.paths) {
        if (seen.has(rel) || listed.deleted.has(rel)) continue;
        seen.add(rel);
        if (isExcludedPath(rel)) { excluded++; continue; }
        if (files.length < LIMITS.maxFiles) files.push(rel);
      }
      const total = seen.size - excluded;
      files.sort();
      const complete = total <= LIMITS.maxFiles;
      return { files, total, excluded, symlinks: 0, complete, method: 'git', notices: complete ? [] : [`Only the first ${LIMITS.maxFiles.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} files were analysed; no tracked source was marked missing.`] };
    }
    const fallback = await walk(root, budget);
    fallback.notices.unshift('Git could not list files, so the folder was walked without .gitignore rules.');
    return fallback;
  }
  return walk(root, budget);
}

export type ReadOutcome = { text: string } | { skipped: 'missing' | 'large' | 'binary' | 'unsafe' | 'unreadable' };

/**
 * Reads a bounded text file below `root`. The path is resolved through the shared guard (symlink escapes and
 * denied names refuse) and opened with O_NOFOLLOW; symlinked files are not read at all.
 */
export async function readBoundedText(root: string, rel: string, maxBytes: number): Promise<ReadOutcome> {
  let resolved: Awaited<ReturnType<typeof resolveInside>>;
  try {
    resolved = await resolveInside(root, rel);
  } catch (error) {
    return { skipped: error instanceof HttpError && error.status === 404 ? 'missing' : 'unsafe' };
  }
  try {
    if (resolved.real !== path.join(resolved.root, ...rel.split('/'))) return { skipped: 'unsafe' };
    const handle = await fsp.open(resolved.real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { skipped: 'unreadable' };
      if (stat.size > maxBytes) return { skipped: 'large' };
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
      const slice = buffer.subarray(0, bytesRead);
      if (slice.subarray(0, 8192).includes(0)) return { skipped: 'binary' };
      return { text: slice.toString('utf8') };
    } finally {
      await handle.close();
    }
  } catch {
    return { skipped: 'unreadable' };
  }
}

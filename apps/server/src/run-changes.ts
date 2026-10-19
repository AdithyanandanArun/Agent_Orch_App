import fsp from 'node:fs/promises';
import path from 'node:path';
import type { RunChangedFile, RunChanges, RunChangesSummary } from '@relay/contracts';
import { git, repoInfo } from './git.ts';
import { isDeniedName } from './paths.ts';
import { nowIso, redactSecrets } from './util.ts';

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_CAPTURE_MS = 30_000;
const MAX_LISTED_FILES = 200;
const MAX_DIFF_BYTES = 500 * 1024;
const NOTICE = 'Workspace changes are unavailable because an accurate snapshot could not be captured.';

export interface RunTreeSnapshot {
  status: 'available' | 'unavailable';
  repoRoot: string | null;
  scopeRoot: string | null;
  tree: string | null;
  capturedAt: string;
}

export function unavailableRunChanges(notice: string): RunChanges {
  return {
    summary: { status: 'unavailable', capturedAt: nowIso(), fileCount: 0, files: [], additions: 0, deletions: 0, truncated: false, notices: [redactSecrets(notice).slice(0, 200)] },
    diff: '', diffTruncated: false,
  };
}

function unavailableSnapshot(): RunTreeSnapshot {
  return { status: 'unavailable', repoRoot: null, scopeRoot: null, tree: null, capturedAt: nowIso() };
}

function deniedPath(file: string): boolean {
  return file.split('/').some(isDeniedName);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Capture the complete current workspace tree without touching the index, refs, or working files. */
export async function captureRunTree(cwd: string): Promise<RunTreeSnapshot> {
  const started = Date.now();
  try {
    const info = await repoInfo(cwd);
    if (!info.isRepo || !info.topLevel) return unavailableSnapshot();
    const repoRoot = await fsp.realpath(info.topLevel);
    const scopeRoot = await fsp.realpath(cwd);
    if (!inside(repoRoot, scopeRoot)) return unavailableSnapshot();
    const prefix = path.relative(repoRoot, scopeRoot).split(path.sep).join('/');

    const [listing, staged] = await Promise.all([
      git(scopeRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '--full-name', '-z', '--', '.'], { timeoutMs: 8_000, maxBuffer: 8 * 1024 * 1024 }),
      git(scopeRoot, ['ls-files', '--stage', '--full-name', '-z', '--', '.'], { timeoutMs: 8_000, maxBuffer: 8 * 1024 * 1024 }),
    ]);
    const candidates = new Set(listing.stdout.split('\0').filter(Boolean));
    const stagedEntries = new Map<string, { mode: string; oid: string; stage: number }>();
    for (const record of staged.stdout.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      if (tab < 0) throw new Error('malformed index listing');
      const [mode, oid, stageText] = record.slice(0, tab).split(' ');
      const file = record.slice(tab + 1);
      if (!mode || !oid || !stageText || Number(stageText) !== 0) throw new Error('unmerged index entry');
      stagedEntries.set(file, { mode, oid, stage: Number(stageText) });
    }

    const files = [...candidates].filter((file) => {
      if (prefix && !file.startsWith(`${prefix}/`)) return false;
      const scoped = prefix ? file.slice(prefix.length + 1) : file;
      return scoped.length > 0 && !deniedPath(scoped);
    });
    if (files.length > MAX_FILES) throw new Error('file count limit');
    let totalBytes = 0;
    const entries = new Map<string, { mode: string; oid: string }>();
    for (const repoFile of files) {
      if (Date.now() - started > MAX_CAPTURE_MS) throw new Error('capture time limit');
      const scoped = prefix ? repoFile.slice(prefix.length + 1) : repoFile;
      const absolute = path.join(scopeRoot, ...scoped.split('/'));
      const parentReal = await fsp.realpath(path.dirname(absolute));
      if (!inside(scopeRoot, parentReal)) throw new Error('parent escapes scope');
      const stat = await fsp.lstat(absolute).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!stat) continue; // A deleted tracked path is absent from this tree.
      const indexed = stagedEntries.get(repoFile);
      if (indexed?.mode === '160000') {
        entries.set(scoped, { mode: '160000', oid: indexed.oid });
        continue;
      }
      let content: Buffer;
      let mode: string;
      if (stat.isSymbolicLink()) {
        content = Buffer.from(await fsp.readlink(absolute));
        mode = '120000';
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) throw new Error('file size limit');
        totalBytes += stat.size;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error('total size limit');
        content = await fsp.readFile(absolute);
        if (content.length !== stat.size) throw new Error('file changed while reading');
        mode = (stat.mode & 0o111) !== 0 ? '100755' : '100644';
      } else {
        throw new Error('unsupported workspace entry');
      }
      const blob = await git(scopeRoot, ['hash-object', '-w', '--stdin'], { stdin: content, timeoutMs: 8_000, maxBuffer: 1024 });
      entries.set(scoped, { mode, oid: blob.stdout.trim() });
    }

    const tree = await writeTree(scopeRoot, entries, started);
    return { status: 'available', repoRoot, scopeRoot, tree, capturedAt: nowIso() };
  } catch {
    return unavailableSnapshot();
  }
}

async function writeTree(cwd: string, entries: Map<string, { mode: string; oid: string }>, started: number): Promise<string> {
  type Node = { files: Array<{ name: string; mode: string; oid: string }>; dirs: Map<string, Node> };
  const root: Node = { files: [], dirs: new Map() };
  for (const [file, value] of entries) {
    const parts = file.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) node.dirs.set(part, next = { files: [], dirs: new Map() });
      node = next;
    }
    node.files.push({ name: parts.at(-1)!, ...value });
  }
  const write = async (node: Node): Promise<string> => {
    if (Date.now() - started > MAX_CAPTURE_MS) throw new Error('capture time limit');
    const records: Array<{ name: string; mode: string; oid: string }> = [...node.files];
    for (const [name, child] of node.dirs) records.push({ name, mode: '040000', oid: await write(child) });
    records.sort((a, b) => {
      const left = Buffer.from(a.name + (a.mode === '040000' ? '/' : ''));
      const right = Buffer.from(b.name + (b.mode === '040000' ? '/' : ''));
      return Buffer.compare(left, right);
    });
    const input = Buffer.concat(records.map(({ name, mode, oid }) => Buffer.concat([Buffer.from(`${mode} ${mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob'} ${oid}\t${name}\0`)])));
    return (await git(cwd, ['mktree', '-z'], { stdin: input, timeoutMs: 8_000, maxBuffer: 1024 })).stdout.trim();
  };
  return write(root);
}

/** Compare complete captured trees; all counts describe the full diff even when returned files or patch are capped. */
export async function compareRunTrees(cwd: string, before: RunTreeSnapshot, after: RunTreeSnapshot): Promise<RunChanges> {
  if (before.status !== 'available' || after.status !== 'available' || !before.tree || !after.tree || before.repoRoot !== after.repoRoot || before.scopeRoot !== after.scopeRoot) return unavailableRunChanges(NOTICE);
  try {
    const info = await repoInfo(cwd);
    if (!info.isRepo || !info.topLevel || await fsp.realpath(info.topLevel) !== before.repoRoot || await fsp.realpath(cwd) !== before.scopeRoot) return unavailableRunChanges(NOTICE);
    const statusResult = await git(cwd, ['diff', '--no-renames', '--name-status', '-z', before.tree, after.tree, '--'], { timeoutMs: 15_000, maxBuffer: 8 * 1024 * 1024 });
    const statusRecords = statusResult.stdout.split('\0').filter(Boolean);
    const statuses = new Map<string, RunChangedFile['status']>();
    for (let i = 0; i + 1 < statusRecords.length; i += 2) {
      const status = statusRecords[i]!.slice(0, 1);
      if (['A', 'M', 'D', 'T'].includes(status)) statuses.set(statusRecords[i + 1]!, status as RunChangedFile['status']);
    }
    const numstat = await git(cwd, ['diff', '--no-renames', '--numstat', '-z', before.tree, after.tree, '--'], { timeoutMs: 15_000, maxBuffer: 8 * 1024 * 1024 });
    const changed: RunChangedFile[] = [];
    let additions = 0;
    let deletions = 0;
    for (const record of numstat.stdout.split('\0').filter(Boolean)) {
      const first = record.indexOf('\t');
      const second = record.indexOf('\t', first + 1);
      if (first < 0 || second < 0) continue;
      const plus = record.slice(0, first);
      const minus = record.slice(first + 1, second);
      const file = record.slice(second + 1);
      const binary = plus === '-' || minus === '-';
      const add = binary ? null : Number(plus);
      const del = binary ? null : Number(minus);
      if (add !== null) additions += add;
      if (del !== null) deletions += del;
      changed.push({ path: file, status: statuses.get(file) ?? 'M', additions: add, deletions: del, binary });
    }
    let rawDiff: string;
    let patchUnavailable = false;
    try {
      rawDiff = (await git(cwd, ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', before.tree, after.tree, '--'], { timeoutMs: 15_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
    } catch {
      // Stats remain valid if a very large patch exceeds the bounded subprocess buffer.
      rawDiff = 'Patch omitted because it exceeded the capture limit.\n';
      patchUnavailable = true;
    }
    const diffTruncated = patchUnavailable || Buffer.byteLength(rawDiff) > MAX_DIFF_BYTES;
    const diff = redactSecrets(patchUnavailable ? rawDiff : diffTruncated ? Buffer.from(rawDiff).subarray(0, MAX_DIFF_BYTES).toString('utf8') + '\n… diff truncated at 500 KiB\n' : rawDiff);
    const summary: RunChangesSummary = {
      status: 'available', capturedAt: nowIso(), fileCount: changed.length,
      files: changed.slice(0, MAX_LISTED_FILES), additions, deletions,
      truncated: changed.length > MAX_LISTED_FILES || diffTruncated,
      notices: [
        ...(patchUnavailable ? ['Patch was omitted because it exceeded the capture limit; file counts remain complete.'] : diffTruncated ? ['Patch was truncated at 500 KiB.'] : []),
        ...(changed.length > MAX_LISTED_FILES ? ['File list was truncated at 200 entries; totals cover all changed files.'] : []),
      ],
    };
    return { summary, diff, diffTruncated };
  } catch {
    return unavailableRunChanges(NOTICE);
  }
}

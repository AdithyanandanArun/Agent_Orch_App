import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Project, RepositoryChange, RepositoryState, Session } from '@mingle/contracts';
import { isDeniedName } from '../paths.ts';
import { git } from './git-run.ts';
import { locate, operationInProgress, remotes as readRemotes, tracking as readTracking, type RemoteInfo, type Tracking } from './inspect.ts';

export const MAX_CHANGES = 1000;
const MAX_OUTSIDE_SCOPE = 100;
const MAX_BRANCHES = 500;
/** Content of every committable file is hashed into the fingerprint, so files are bounded in size and per-read volume. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const READ_BUDGET_BYTES = 256 * 1024 * 1024;
const STAT_CONCURRENCY = 16;
const MEMO_LIMIT = 5000;
const RACY_MS = 2000;

/** Content hashes keyed by full-precision stat identity, so unchanged files are not reread on every poll. */
const hashMemo = new Map<string, string>();

export interface Scope { project: Project; root: string; session?: Session }

export interface Entry extends RepositoryChange {
  /** Staged rename source that must be committed together with this path. */
  companion?: string;
}

interface ReadBudget { remaining: number }

export interface Snapshot {
  state: RepositoryState;
  /** Canonical Git work-tree root; used for Git commands and the mutation lock. state.root is the displayed project/session folder. */
  top: string | null;
  prefix: string;
  /** Number of changed paths in the whole work tree (including outside this folder and beyond the visible cap). */
  dirty: number;
  unborn: boolean;
  operation: string | null;
  remotes: RemoteInfo[];
  tracking: Tracking;
  entries: Map<string, Entry>;
}

interface Raw { path: string; originalPath?: string; x: string; y: string; kind: 'ordinary' | 'rename' | 'unmerged' | 'untracked'; submodule: boolean }

interface Parsed { oid: string | null; head: string | null; upstream: string | null; ahead: number | null; behind: number | null; raw: Raw[]; body: string }

function fields(record: string, count: number): string[] | null {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const at = record.indexOf(' ', start);
    if (at < 0) return null;
    parts.push(record.slice(start, at));
    start = at + 1;
  }
  parts.push(record.slice(start));
  return parts;
}

export function parseStatus(output: string): Parsed {
  const parsed: Parsed = { oid: null, head: null, upstream: null, ahead: null, behind: null, raw: [], body: '' };
  const records = output.split('\0');
  const body: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') parsed.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') parsed.head = value;
      else if (key === 'branch.upstream') parsed.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) { parsed.ahead = Number(match[1]); parsed.behind = Number(match[2]); }
      }
      continue;
    }
    body.push(record);
    const type = record[0];
    if (type === '?') { parsed.raw.push({ path: record.slice(2), x: '?', y: '?', kind: 'untracked', submodule: false }); continue; }
    if (type === '1') {
      const f = fields(record, 8);
      if (f) parsed.raw.push({ path: f[8]!, x: f[1]![0]!, y: f[1]![1]!, kind: 'ordinary', submodule: f[2]!.startsWith('S') || f[3] === '160000' || f[4] === '160000' || f[5] === '160000' });
    } else if (type === '2') {
      const f = fields(record, 9);
      const original = records[++i] ?? '';
      body.push(original);
      if (f) parsed.raw.push({ path: f[9]!, originalPath: original, x: f[1]![0]!, y: f[1]![1]!, kind: 'rename', submodule: f[2]!.startsWith('S') || f[3] === '160000' || f[4] === '160000' || f[5] === '160000' });
    } else if (type === 'u') {
      const f = fields(record, 10);
      if (f) parsed.raw.push({ path: f[10]!, x: f[1]![0]!, y: f[1]![1]!, kind: 'unmerged', submodule: f[2]!.startsWith('S') });
    }
  }
  parsed.body = body.join('\0');
  return parsed;
}

const letter = (c: string) => (c === '.' ? '' : c);
function statusCode(raw: Raw): string {
  if (raw.kind === 'untracked') return '??';
  const x = letter(raw.x);
  const y = letter(raw.y);
  if (raw.kind === 'unmerged') return `${raw.x}${raw.y}`.replaceAll('.', '');
  if (x && y) return x === y ? x : `${x}${y}`;
  return x || y;
}

const inScope = (prefix: string, file: string) => !prefix || file === prefix || file.startsWith(`${prefix}/`);

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const statSig = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`;

async function digest(abs: string, stat: BigIntStats, budget: ReadBudget): Promise<{ hash?: string; reason?: string }> {
  const sig = statSig(stat);
  const key = `${abs}\0${sig}`;
  const known = hashMemo.get(key);
  if (known) return { hash: known };
  const size = Number(stat.size);
  if (size > budget.remaining) return { reason: 'Too many large changes to verify at once; refresh and try again' };
  budget.remaining -= size;
  let hash: string;
  try {
    const handle = await fsp.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const sum = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) sum.update(chunk as Buffer);
      const after = await handle.stat({ bigint: true });
      if (statSig(after) !== sig) return { reason: 'Changed while being read; refresh and try again' };
      hash = sum.digest('hex');
    } finally {
      await handle.close();
    }
  } catch {
    return { reason: 'Could not be read' };
  }
  // A file modified moments ago could still change within the clock's granularity, so only settled files are remembered.
  if (Date.now() - Number(stat.mtimeNs / 1_000_000n) > RACY_MS && Date.now() - Number(stat.ctimeNs / 1_000_000n) > RACY_MS) {
    hashMemo.set(key, hash);
    while (hashMemo.size > MEMO_LIMIT) hashMemo.delete(hashMemo.keys().next().value!);
  }
  return { hash };
}

/** Decides whether a changed path may be committed by Mingle; returns its content identity (stat + hash) for the fingerprint. */
async function assess(top: string, prefix: string, raw: Raw, budget: ReadBudget): Promise<{ reason?: string; identity: string }> {
  const none = (reason?: string) => ({ ...(reason ? { reason } : {}), identity: '' });
  if (raw.kind === 'unmerged') return none('Resolve the merge conflict outside Mingle first');
  if (raw.submodule) return none('Submodule changes are not committed from Mingle');
  if (raw.path.endsWith('/')) return none('Nested Git repository; commit it from its own folder');
  if (!inScope(prefix, raw.path) || (raw.originalPath !== undefined && !inScope(prefix, raw.originalPath))) return none('Outside this project folder');
  for (const file of [raw.path, raw.originalPath]) {
    if (file !== undefined && file.split('/').some((part) => !part || isDeniedName(part))) return none('Protected file (credentials or secrets)');
  }
  const abs = path.join(top, ...raw.path.split('/'));
  let stat: BigIntStats;
  try {
    stat = await fsp.lstat(abs, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return { identity: 'absent' }; // deleted in the work tree
    return none('Could not be inspected (permission denied or unreadable)');
  }
  const identity = (hash: string) => `${statSig(stat)}:${hash}`;
  const dir = path.posix.dirname(raw.path);
  const expectedParent = dir === '.' ? top : path.join(top, ...dir.split('/'));
  const realParent = await fsp.realpath(path.dirname(abs)).catch(() => null);
  if (realParent !== expectedParent) return none('Path passes through a symbolic link');
  if (stat.isSymbolicLink()) {
    const link = await fsp.readlink(abs).catch(() => null);
    if (link === null) return none('Unreadable symbolic link');
    const lexical = path.resolve(path.dirname(abs), link);
    const target = await fsp.realpath(lexical).catch(() => lexical);
    if (!isInside(top, lexical) || !isInside(top, target)) return none('Symbolic link points outside the repository');
    if (path.relative(top, target).split(path.sep).some((part) => part && isDeniedName(part))) return none('Symbolic link points at a protected path');
    return { identity: identity(createHash('sha256').update(link).digest('hex')) };
  }
  if (stat.isDirectory()) return none('Directory entries must be committed file by file');
  if (!stat.isFile()) return none('Not a regular file');
  if (stat.size > BigInt(MAX_FILE_BYTES)) return none('File is larger than 64 MiB; commit it from a terminal');
  const content = await digest(abs, stat, budget);
  if (content.reason) return none(content.reason);
  return { identity: identity(content.hash!) };
}

async function listBranches(top: string, current: string | null, unborn: boolean, signal?: AbortSignal): Promise<RepositoryState['branches']> {
  const base = ['for-each-ref', '--sort=-committerdate', `--count=${MAX_BRANCHES}`];
  let result = await git(top, [...base, '--format=%(refname)\t%(worktreepath)', 'refs/heads'], { allowFailure: true, signal });
  const withWorktrees = result.code === 0;
  if (!withWorktrees) result = await git(top, [...base, '--format=%(refname)', 'refs/heads'], { signal });
  const branches: RepositoryState['branches'] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('refs/heads/')) continue;
    const [ref, worktree] = line.split('\t');
    const name = ref!.slice('refs/heads/'.length);
    branches.push({ name, current: name === current, ...(withWorktrees ? { worktreePath: worktree || null } : {}) });
  }
  if (unborn && current && !branches.some((b) => b.name === current)) branches.unshift({ name: current, current: true, worktreePath: top });
  return branches;
}

function emptyState(scope: Scope, root: string, notices: string[], fingerprintSeed: string): Snapshot {
  const fetchedAt = new Date().toISOString();
  return {
    state: {
      projectId: scope.project.id, sessionId: scope.session?.id ?? null, root, isRepo: false, branch: null, head: null, detached: false,
      branches: [], remotes: [], upstream: null, ahead: null, behind: null, changes: [], fetchedAt,
      fingerprint: createHash('sha256').update(`none\0${fingerprintSeed}`).digest('hex'), notices,
    },
    top: null, prefix: '', dirty: 0, unborn: false, operation: null, remotes: [], tracking: { remote: null, merge: null }, entries: new Map(),
  };
}

async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

/** Local, offline repository state for a project or session folder. Never touches the network. */
export async function readSnapshot(scope: Scope, signal?: AbortSignal): Promise<Snapshot> {
  const located = await locate(scope.root, signal);
  if (located.kind === 'missing') return emptyState(scope, scope.root, ['This folder no longer exists on disk.'], scope.root);
  if (located.kind === 'not-repo') return emptyState(scope, scope.root, [located.detail ?? 'This folder is not a Git repository.'], scope.root);
  const { top, prefix } = located;
  const status = await git(top, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=none'], { timeoutMs: 30_000, signal });
  const parsed = parseStatus(status.stdout);
  const detached = parsed.head === '(detached)';
  const branch = parsed.head && !detached ? parsed.head : null;
  const unborn = parsed.oid === null && !detached;
  const [branches, remotes, tracking, operation] = await Promise.all([
    listBranches(top, branch, unborn, signal), readRemotes(top, signal), readTracking(top, branch, signal), operationInProgress(top, signal),
  ]);

  // In-scope paths are listed first so changes elsewhere in a larger work tree can never push eligible files out of the visible cap.
  const insideScope = parsed.raw.filter((raw) => inScope(prefix, raw.path));
  const outsideScope = parsed.raw.filter((raw) => !inScope(prefix, raw.path));
  const listed = [...insideScope.slice(0, MAX_CHANGES), ...outsideScope.slice(0, Math.min(MAX_OUTSIDE_SCOPE, Math.max(0, MAX_CHANGES - insideScope.length)))];
  const budget: ReadBudget = { remaining: READ_BUDGET_BYTES };
  const assessed = await inChunks(listed, STAT_CONCURRENCY, async (raw) => ({ raw, ...await assess(top, prefix, raw, budget) }));
  const entries = new Map<string, Entry>();
  const changes: RepositoryChange[] = [];
  for (const { raw, reason } of assessed) {
    const entry: Entry = {
      path: raw.path, ...(raw.originalPath !== undefined ? { originalPath: raw.originalPath } : {}), status: statusCode(raw),
      indexStatus: raw.kind === 'untracked' ? '?' : letter(raw.x), worktreeStatus: raw.kind === 'untracked' ? '?' : letter(raw.y),
      eligible: !reason, ...(reason ? { reason } : {}),
      ...(raw.kind === 'rename' && (raw.x === 'R' || raw.y === 'R') && raw.originalPath !== undefined ? { companion: raw.originalPath } : {}),
    };
    entries.set(entry.path, entry);
    const { companion: _companion, ...visible } = entry;
    changes.push(visible);
  }

  // Binds the full index/status text and the stat + content identity of every listed file, so a same-status content edit changes it.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([parsed.oid, parsed.head, parsed.body, assessed.map((row) => row.identity)]))
    .digest('hex');
  const displayRoot = prefix ? path.join(top, ...prefix.split('/')) : top;

  const notices: string[] = [];
  if (detached) notices.push('HEAD is detached. Switch to or create a branch before committing, pushing or opening a pull request.');
  if (unborn) notices.push('This repository has no commits yet.');
  if (operation) notices.push(`A ${operation} is in progress. Finish or abort it outside Mingle before committing or switching branches.`);
  if (prefix) notices.push('This project is a sub-folder of its Git repository; only files inside it can be committed from here.');
  if (scope.session && !scope.session.isolated) notices.push('This session works directly in the shared project folder, so commits affect that folder.');
  if (!remotes.length) notices.push('No Git remote is configured.');
  for (const remote of remotes.filter((r) => r.credentials)) notices.push(`Remote "${remote.name}" embeds credentials in its URL. Mingle will not push to it; use SSH or a Git credential helper.`);
  if (parsed.upstream && parsed.ahead === null) notices.push(`The upstream branch ${parsed.upstream} no longer exists.`);
  if (insideScope.length > MAX_CHANGES) notices.push(`Showing the first ${MAX_CHANGES} of ${insideScope.length} changed paths in this folder; commit some to see the rest.`);
  if (outsideScope.length) notices.push(`${outsideScope.length} changed path${outsideScope.length === 1 ? ' is' : 's are'} outside this project folder and cannot be committed from here.`);

  return {
    state: {
      projectId: scope.project.id, sessionId: scope.session?.id ?? null, root: displayRoot, isRepo: true, branch, head: parsed.oid, detached, branches,
      remotes: remotes.map(({ name, host, repository }) => ({ name, host, repository })), upstream: parsed.upstream, ahead: parsed.ahead, behind: parsed.behind,
      changes, fetchedAt: new Date().toISOString(), fingerprint, notices,
    },
    top, prefix, dirty: parsed.raw.length, unborn, operation, remotes, tracking, entries,
  };
}

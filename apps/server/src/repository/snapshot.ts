import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Project, RepositoryChange, RepositoryState, Session } from '@relay/contracts';
import { isDeniedName } from '../paths.ts';
import { git } from './git-run.ts';
import { locate, operationInProgress, remotes as readRemotes, tracking as readTracking, type RemoteInfo, type Tracking } from './inspect.ts';

export const MAX_CHANGES = 1000;
const MAX_BRANCHES = 500;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const STAT_CONCURRENCY = 32;

export interface Scope { project: Project; root: string; session?: Session }

export interface Entry extends RepositoryChange {
  /** Staged rename source that must be committed together with this path. */
  companion?: string;
}

export interface Snapshot {
  state: RepositoryState;
  top: string | null;
  prefix: string;
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

/** Decides whether a changed path may be committed by Relay; also returns a cheap content signature for the fingerprint. */
async function assess(top: string, prefix: string, raw: Raw): Promise<{ reason?: string; sig: string }> {
  const sig = (stat: { size: number; mtimeMs: number; mode: number } | null) => (stat ? `${stat.size}:${Math.trunc(stat.mtimeMs)}:${stat.mode}` : 'absent');
  if (raw.kind === 'unmerged') return { reason: 'Resolve the merge conflict outside Relay first', sig: sig(null) };
  if (raw.submodule) return { reason: 'Submodule changes are not committed from Relay', sig: sig(null) };
  if (raw.path.endsWith('/')) return { reason: 'Nested Git repository; commit it from its own folder', sig: sig(null) };
  if (!inScope(prefix, raw.path) || (raw.originalPath !== undefined && !inScope(prefix, raw.originalPath))) return { reason: 'Outside this project folder', sig: sig(null) };
  for (const file of [raw.path, raw.originalPath]) {
    if (file !== undefined && file.split('/').some((part) => !part || isDeniedName(part))) return { reason: 'Protected file (credentials or secrets)', sig: sig(null) };
  }
  const abs = path.join(top, ...raw.path.split('/'));
  const stat = await fsp.lstat(abs).catch(() => null);
  if (!stat) return { sig: sig(null) }; // deleted in the work tree
  const dir = path.posix.dirname(raw.path);
  const expectedParent = dir === '.' ? top : path.join(top, ...dir.split('/'));
  const realParent = await fsp.realpath(path.dirname(abs)).catch(() => null);
  if (realParent !== expectedParent) return { reason: 'Path passes through a symbolic link', sig: sig(stat) };
  if (stat.isSymbolicLink()) {
    const link = await fsp.readlink(abs).catch(() => null);
    if (link === null) return { reason: 'Unreadable symbolic link', sig: sig(stat) };
    const lexical = path.resolve(path.dirname(abs), link);
    const target = await fsp.realpath(lexical).catch(() => lexical);
    if (!isInside(top, lexical) || !isInside(top, target)) return { reason: 'Symbolic link points outside the repository', sig: sig(stat) };
    if (path.relative(top, target).split(path.sep).some((part) => part && isDeniedName(part))) return { reason: 'Symbolic link points at a protected path', sig: sig(stat) };
    return { sig: sig(stat) };
  }
  if (stat.isDirectory()) return { reason: 'Directory entries must be committed file by file', sig: sig(stat) };
  if (!stat.isFile()) return { reason: 'Not a regular file', sig: sig(stat) };
  if (stat.size > MAX_FILE_BYTES) return { reason: 'File is larger than 100 MiB', sig: sig(stat) };
  return { sig: sig(stat) };
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
    top: null, prefix: '', unborn: false, operation: null, remotes: [], tracking: { remote: null, merge: null }, entries: new Map(),
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

  const listed = parsed.raw.slice(0, MAX_CHANGES);
  const assessed = await inChunks(listed, STAT_CONCURRENCY, async (raw) => ({ raw, ...await assess(top, prefix, raw) }));
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

  const fingerprint = createHash('sha256')
    .update(JSON.stringify([parsed.oid, parsed.head, parsed.body, assessed.map((row) => row.sig)]))
    .digest('hex');

  const notices: string[] = [];
  if (detached) notices.push('HEAD is detached. Switch to or create a branch before committing, pushing or opening a pull request.');
  if (unborn) notices.push('This repository has no commits yet.');
  if (operation) notices.push(`A ${operation} is in progress. Finish or abort it outside Relay before committing or switching branches.`);
  if (prefix) notices.push('This project is a sub-folder of its Git repository; only files inside it can be committed from here.');
  if (scope.session && !scope.session.isolated) notices.push('This session works directly in the shared project folder, so commits affect that folder.');
  if (!remotes.length) notices.push('No Git remote is configured.');
  for (const remote of remotes.filter((r) => r.credentials)) notices.push(`Remote "${remote.name}" embeds credentials in its URL. Relay will not push to it; use SSH or a Git credential helper.`);
  if (parsed.upstream && parsed.ahead === null) notices.push(`The upstream branch ${parsed.upstream} no longer exists.`);
  if (parsed.raw.length > MAX_CHANGES) notices.push(`Showing the first ${MAX_CHANGES} of ${parsed.raw.length} changed paths.`);
  const outside = listed.filter((raw) => !inScope(prefix, raw.path)).length;
  if (outside) notices.push(`${outside} changed path${outside === 1 ? ' is' : 's are'} outside this project folder and cannot be committed from here.`);

  return {
    state: {
      projectId: scope.project.id, sessionId: scope.session?.id ?? null, root: top, isRepo: true, branch, head: parsed.oid, detached, branches,
      remotes: remotes.map(({ name, host, repository }) => ({ name, host, repository })), upstream: parsed.upstream, ahead: parsed.ahead, behind: parsed.behind,
      changes, fetchedAt: new Date().toISOString(), fingerprint, notices,
    },
    top, prefix, unborn, operation, remotes, tracking, entries,
  };
}

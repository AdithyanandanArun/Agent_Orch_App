import fsp from 'node:fs/promises';
import path from 'node:path';
import { git, GitFailure } from './git-run.ts';
import { parseRemoteUrl } from './remote.ts';
import { isSafeRemoteName } from './refs.ts';
import { failureSummary } from './scrub.ts';

export type Location =
  | { kind: 'ok'; top: string; prefix: string }
  | { kind: 'missing' }
  | { kind: 'not-repo'; detail?: string };

export interface RemoteInfo { name: string; host: string | null; repository: string | null; credentials: boolean }
export interface Tracking { remote: string | null; merge: string | null }

const MAX_REMOTES = 20;

/** Finds the canonical work-tree root for a folder. Folders that vanished or are not inside a work tree are reported, not thrown. */
export async function locate(root: string, signal?: AbortSignal): Promise<Location> {
  let real: string;
  try {
    real = await fsp.realpath(root);
    if (!(await fsp.stat(real)).isDirectory()) return { kind: 'missing' };
  } catch {
    return { kind: 'missing' };
  }
  const result = await git(real, ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--show-prefix'], { allowFailure: true, signal });
  if (result.code !== 0) {
    if (/not a git repository/i.test(result.stderr)) return { kind: 'not-repo' };
    return { kind: 'not-repo', detail: `Git could not inspect this folder: ${failureSummary(result.stderr)}` };
  }
  const lines = result.stdout.split('\n');
  if (lines[0]?.trim() !== 'true' || !lines[1]) return { kind: 'not-repo' };
  return { kind: 'ok', top: await fsp.realpath(lines[1]), prefix: (lines[2] ?? '').replace(/\r?$/, '').replace(/\/$/, '') };
}

export interface Basics { head: string | null; branch: string | null; detached: boolean; unborn: boolean }

export async function basics(top: string, signal?: AbortSignal): Promise<Basics> {
  const [head, branch] = await Promise.all([
    git(top, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true, signal }),
    git(top, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFailure: true, signal }),
  ]);
  const sha = head.code === 0 ? head.stdout.trim() : null;
  const name = branch.code === 0 ? branch.stdout.trim() : null;
  return { head: sha, branch: name, detached: name === null && sha !== null, unborn: sha === null };
}

/** Remotes with the host and GitHub owner/name of the URL that pushes would use. Raw URLs never leave this function. */
export async function remotes(top: string, signal?: AbortSignal): Promise<RemoteInfo[]> {
  const listed = await git(top, ['remote'], { allowFailure: true, signal });
  const names = listed.stdout.split('\n').map((line) => line.trim()).filter(isSafeRemoteName).slice(0, MAX_REMOTES);
  return Promise.all(names.map(async (name) => {
    const url = await git(top, ['remote', 'get-url', '--push', name], { allowFailure: true, signal });
    const parsed = url.code === 0 ? parseRemoteUrl(url.stdout.trim()) : { host: null, repository: null, credentials: false };
    return { name, ...parsed };
  }));
}

async function config(top: string, key: string, signal?: AbortSignal): Promise<string | null> {
  const result = await git(top, ['config', '--get', key], { allowFailure: true, signal });
  const value = result.code === 0 ? result.stdout.trim() : '';
  return value || null;
}

/** Configured upstream of a local branch; a "." remote (tracking another local branch) is treated as no remote. */
export async function tracking(top: string, branch: string | null, signal?: AbortSignal): Promise<Tracking> {
  if (!branch) return { remote: null, merge: null };
  const [remote, merge] = await Promise.all([config(top, `branch.${branch}.remote`, signal), config(top, `branch.${branch}.merge`, signal)]);
  return { remote: remote && remote !== '.' && isSafeRemoteName(remote) ? remote : null, merge };
}

export async function configuredPushRemote(top: string, branch: string, signal?: AbortSignal): Promise<string | null> {
  const value = (await config(top, `branch.${branch}.pushRemote`, signal)) ?? (await config(top, 'remote.pushDefault', signal));
  return value && isSafeRemoteName(value) ? value : null;
}

export async function isMirrorRemote(top: string, remote: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(top, ['config', '--type=bool', '--get', `remote.${remote}.mirror`], { allowFailure: true, signal });
  return result.code === 0 && result.stdout.trim() === 'true';
}

export async function signingConfigured(top: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(top, ['config', '--type=bool', '--get', 'commit.gpgsign'], { allowFailure: true, signal });
  return result.code === 0 && result.stdout.trim() === 'true';
}

const OPERATION_MARKERS: [string, string][] = [
  ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'],
];

/** Name of an in-progress merge/rebase/cherry-pick/revert, which must be finished outside Relay. */
export async function operationInProgress(top: string, signal?: AbortSignal): Promise<string | null> {
  const found = await Promise.all(OPERATION_MARKERS.map(async ([marker, label]) => {
    const where = await git(top, ['rev-parse', '--git-path', marker], { allowFailure: true, signal });
    if (where.code !== 0) return null;
    const file = path.resolve(top, where.stdout.replace(/\r?\n$/, ''));
    return (await fsp.access(file).then(() => true, () => false)) ? label : null;
  }));
  return found.find(Boolean) ?? null;
}

export async function identityProblem(top: string, signal?: AbortSignal): Promise<string | null> {
  for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const result = await git(top, ['var', variable], { allowFailure: true, signal }).catch((error: unknown) => { if (error instanceof GitFailure) return null; throw error; });
    if (!result || result.code !== 0) return 'Git author identity is not configured. Set user.name and user.email (git config) and try again.';
  }
  return null;
}

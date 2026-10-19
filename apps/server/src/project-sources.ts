import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CloneProjectSchema, NewProjectSchema, Project } from '@relay/contracts';
import type { z } from 'zod';
import type { WorkspaceService } from './workspace.ts';
import { git } from './git.ts';
import { badRequest, conflict, unprocessable } from './util.ts';

type NewProject = z.infer<typeof NewProjectSchema>;
type CloneProject = z.infer<typeof CloneProjectSchema>;

const GIT_INIT_TIMEOUT_MS = 10_000;
const GIT_CLONE_TIMEOUT_MS = 45_000;
const GIT_OUTPUT_LIMIT = 1024 * 1024;

/** Creates local Git repositories and clones safe remote Git URLs into a chosen parent folder. */
export class ProjectSources {
  constructor(private readonly workspace: WorkspaceService) {}

  async create(input: NewProject): Promise<Project> {
    const name = validateProjectName(input.name);
    const parent = await canonicalParent(input.parentPath);
    const destination = path.join(parent, name);
    await reserveDirectory(destination);

    try {
      await git(destination, ['init', '--quiet', '--initial-branch=main', '--template='], {
        timeoutMs: GIT_INIT_TIMEOUT_MS,
        maxBuffer: GIT_OUTPUT_LIMIT,
      });
      // An empty first commit gives the default isolated-session flow a valid HEAD.
      // Git uses the user's configured identity; no fallback identity is supplied.
      await git(destination, ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Initial commit'], {
        timeoutMs: GIT_INIT_TIMEOUT_MS,
        maxBuffer: GIT_OUTPUT_LIMIT,
      });
    } catch (error) {
      if (isGitIdentityError(error)) {
        throw unprocessable(`The new folder was created at ${destination}, but Git could not make its initial commit. Configure your Git user.name and user.email, then remove or rename this folder before trying again.`);
      }
      throw unprocessable(`The new folder was created at ${destination}, but Git repository setup failed. The folder was kept; inspect it or remove it before trying again.`);
    }

    try {
      return (await this.workspace.createProject({ name, path: destination })).project;
    } catch (error) {
      throw error;
    }
  }

  async clone(input: CloneProject): Promise<Project> {
    const name = validateProjectName(input.name);
    const url = validateCloneUrl(input.url);
    const parent = await canonicalParent(input.parentPath);
    const destination = path.join(parent, name);
    await reserveDirectory(destination);

    try {
      // The shared git() runner uses argv, short timeouts, bounded output, and disables hooks.
      // Do not recurse into submodules: their URLs can be arbitrary and are outside this request.
      await git(parent, ['clone', '--quiet', '--template=', '--no-recurse-submodules', '--', url, destination], {
        timeoutMs: GIT_CLONE_TIMEOUT_MS,
        maxBuffer: GIT_OUTPUT_LIMIT,
      });
    } catch {
      // Keep the partial clone for user inspection/recovery. Never include Git stderr or URL
      // in an error response: either can contain credential-shaped remote information.
      throw unprocessable(`Git clone did not finish within the allowed time or failed. The folder was kept at ${destination}; inspect it or remove it before trying again.`);
    }

    return (await this.workspace.createProject({ name, path: destination })).project;
  }
}

function validateProjectName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 100) throw badRequest('Project name must contain 1 to 100 characters');
  if (name.startsWith('-')) throw badRequest('Project name cannot start with a dash');
  if (name === '.' || name === '..' || name.includes('..')) throw badRequest('Project name cannot contain dot-dot');
  if (/\s|[\u0000-\u001f\u007f]/u.test(name)) throw badRequest('Project name cannot contain whitespace or control characters');
  if (/[\\/:<>"|?*]/u.test(name)) throw badRequest('Project name must be a single safe folder name');
  if (/[. ]$/u.test(name)) throw badRequest('Project name cannot end with a dot or space');
  const deviceName = name.split('.')[0]!.toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceName)) throw badRequest('Project name is reserved on Windows');
  return name;
}

async function canonicalParent(value: string): Promise<string> {
  let requested = value.trim();
  if (requested === '~') requested = os.homedir();
  else if (/^~[\\/]/u.test(requested)) {
    const remainder = requested.slice(2).split(/[\\/]/u).join(path.sep);
    requested = path.join(os.homedir(), remainder);
  }
  if (!path.isAbsolute(requested)) throw badRequest('Parent folder must be an absolute path or start with ~/');

  let real: string;
  try {
    real = await fsp.realpath(requested);
  } catch {
    throw badRequest('Parent folder does not exist');
  }
  const stat = await fsp.stat(real);
  if (!stat.isDirectory()) throw badRequest('Parent path is not a directory');
  return real;
}

async function reserveDirectory(destination: string): Promise<void> {
  try {
    // Nonrecursive mkdir is the reservation: an existing path is never overwritten.
    await fsp.mkdir(destination, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict('A folder with that project name already exists');
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw badRequest('Parent folder does not exist');
    throw error;
  }
}

function validateCloneUrl(value: string): string {
  const raw = value.trim();
  if (!raw || raw.length > 2048 || /[\u0000-\u0020\u007f]/u.test(raw)) throw badRequest('Enter a valid HTTPS or SSH Git URL');

  // GitHub-style SCP notation. Restrict the user to Git's conventional SSH account and
  // a plain repository path; no options, local paths, or shell syntax can enter argv.
  const scp = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+)$/u.exec(raw);
  if (scp) {
    validateRemoteHost(scp[1]!);
    validateRemotePath(scp[2]!);
    return raw;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw badRequest('Enter an HTTPS URL or an SSH Git URL such as git@github.com:owner/repository.git');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') throw badRequest('Only HTTPS and SSH Git URLs are supported');
  if (parsed.protocol === 'https:' && /^https:\/\/[^/]*@/iu.test(raw)) throw badRequest('Credential-bearing Git URLs are not supported');
  if (parsed.username && (parsed.protocol !== 'ssh:' || parsed.username !== 'git')) throw badRequest('Credential-bearing Git URLs are not supported');
  if (parsed.password || parsed.search || parsed.hash) throw badRequest('Git URLs cannot include passwords, query strings, or fragments');
  if (parsed.port && (parsed.protocol !== 'ssh:' || parsed.port !== '22')) throw badRequest('Custom Git URL ports are not supported');
  validateRemoteHost(parsed.hostname);
  validateRemotePath(parsed.pathname.replace(/^\//u, ''));
  return raw;
}

function validateRemoteHost(host: string): void {
  if (host.length > 253 || host.toLowerCase() === 'localhost' || !host.includes('.') ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(host) || host.includes('..')) {
    throw badRequest('Git URL must use a public DNS host name');
  }
}

function validateRemotePath(remotePath: string): void {
  if (!remotePath || remotePath.length > 1000 || !/^[A-Za-z0-9._/-]+$/u.test(remotePath)) throw badRequest('Git URL must point to a repository path');
  const segments = remotePath.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) throw badRequest('Git URL contains an invalid repository path');
}

function isGitIdentityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /user\.name|user\.email|unable to auto-detect email|Author identity unknown/iu.test(message);
}

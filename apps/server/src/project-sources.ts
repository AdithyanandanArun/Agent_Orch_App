import fsp from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { CloneProjectSchema, NewProjectSchema, Project } from '@relay/contracts';
import type { z } from 'zod';
import type { WorkspaceService } from './workspace.ts';
import { git } from './git.ts';
import { badRequest, conflict, HttpError, unprocessable } from './util.ts';

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
      if (isGitExecutableError(error)) throw unprocessable(`Git could not be started. Install Git and make it available to Relay. The new folder was kept at ${destination}.`);
      if (isGitIdentityError(error)) {
        throw unprocessable(`The new folder was created at ${destination}, but Git could not make its initial commit. Configure your Git user.name and user.email, then remove or rename this folder before trying again.`);
      }
      throw unprocessable(`The new folder was created at ${destination}, but Git repository setup failed. The folder was kept; inspect it or remove it before trying again.`);
    }

    return (await this.workspace.createProject({ name, path: destination })).project;
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
    } catch (error) {
      // Keep the partial clone for user inspection/recovery. Never include Git stderr or URL
      // in an error response: either can contain credential-shaped remote information.
      if (isGitExecutableError(error)) throw unprocessable(`Git could not be started. Install Git and make it available to Relay. The new folder was kept at ${destination}.`);
      throw unprocessable(`Git clone failed or exceeded its time limit. Check the URL, network connection and your existing Git login. The folder was kept at ${destination}; inspect it or remove it before trying again.`);
    }

    return (await this.workspace.createProject({ name, path: destination })).project;
  }
}

function validateProjectName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 100) throw badRequest('Project name must contain 1 to 100 characters');
  if (name.startsWith('-')) throw badRequest('Project name cannot start with a dash');
  if (name === '.' || name === '..') throw badRequest('Project name cannot be . or ..');
  if (/[\u0000-\u001f\u007f]/u.test(name)) throw badRequest('Project name cannot contain control characters');
  if (/[\\/:<>"|?*]/u.test(name)) throw badRequest('Project name must be a single safe folder name');
  if (/[. ]$/u.test(name)) throw badRequest('Project name cannot end with a dot or space');
  const deviceName = name.split('.')[0]!.toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceName)) throw badRequest('Project name is reserved on Windows');
  return name;
}

async function canonicalParent(value: string): Promise<string> {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw badRequest('Parent folder must be a valid path of at most 4096 characters');
  let requested = value;
  if (requested === '~') requested = os.homedir();
  else if (path.sep === '/' && requested.startsWith('~/')) {
    const remainder = requested.slice(2);
    requested = path.join(os.homedir(), remainder);
  } else if (path.sep === '\\' && /^~[\\/]/u.test(requested)) {
    const remainder = requested.slice(2).split(/[\\/]/u).join(path.sep);
    requested = path.join(os.homedir(), remainder);
  }
  if (!isFullyQualifiedAbsolutePath(requested)) throw badRequest('Parent folder must be a fully qualified absolute path or start with ~/');

  let real: string;
  try {
    real = await fsp.realpath(requested);
    const stat = await fsp.stat(real);
    if (!stat.isDirectory()) throw badRequest('Parent path is not a directory');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw pathError(error, 'Parent folder does not exist or cannot be accessed');
  }
  return real;
}

function isFullyQualifiedAbsolutePath(value: string): boolean {
  if (path.sep !== '\\') return path.isAbsolute(value);
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value) || /^\/\/[^/]+\/[^/]+(?:\/|$)/u.test(value);
}

async function reserveDirectory(destination: string): Promise<void> {
  try {
    // Nonrecursive mkdir is the reservation: an existing path is never overwritten.
    await fsp.mkdir(destination, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict('A folder with that project name already exists');
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw badRequest('Parent folder does not exist');
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new HttpError(403, 'Permission denied while creating the project folder');
    throw error;
  }
}

function validateCloneUrl(value: string): string {
  const raw = value.trim();
  if (!raw || raw.length > 2048 || /[\u0000-\u0020\u007f]/u.test(raw)) throw badRequest('Enter a valid HTTPS or SSH Git URL');

  // SCP notation is limited to a safe account/host/repository path; no options, local
  // paths, or shell syntax can enter argv.
  const scp = /^([A-Za-z0-9_][A-Za-z0-9._-]*)@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+)$/u.exec(raw);
  if (scp) {
    validateRemoteHost(scp[2]!);
    validateRemotePath(scp[3]!);
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
  if (parsed.username && (parsed.protocol !== 'ssh:' || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(parsed.username))) throw badRequest('Git URL has an invalid SSH account or includes credentials');
  if (parsed.password || parsed.search || parsed.hash) throw badRequest('Git URLs cannot include passwords, query strings, or fragments');
  if (parsed.port && (Number(parsed.port) < 1 || Number(parsed.port) > 65_535)) throw badRequest('Git URL port must be between 1 and 65535');
  validateRemoteHost(parsed.hostname);
  validateRemotePath(parsed.pathname.replace(/^\//u, ''));
  return raw;
}

function validateRemoteHost(host: string): void {
  const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (normalized.length > 253 || (isIP(normalized) === 0 && !isValidDnsHost(normalized))) throw badRequest('Git URL must contain a valid host name or IP address');
}

function isValidDnsHost(host: string): boolean {
  if (!host || host.length > 253 || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false;
  return host.split('.').every((label) => label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label));
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

function isGitExecutableError(error: unknown): boolean {
  return error instanceof Error && /spawn git (?:ENOENT|EACCES|EPERM)/u.test(error.message);
}

function pathError(error: unknown, fallback: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return new HttpError(403, 'Permission denied while opening the parent folder');
  if (code === 'ENOENT' || code === 'ENOTDIR') return badRequest(fallback);
  return badRequest(fallback);
}

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { DirectoryListing, LocalDirectory } from '@relay/contracts';
import { isDeniedName } from './paths.ts';
import { badRequest, HttpError } from './util.ts';

const MAX_DIRECTORIES = 2000;
const MAX_SCANNED_ENTRIES = 20_000;
const BROWSE_BUDGET_MS = 5000;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function expandPath(input?: string): string {
  const value = input || os.homedir();
  if (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw badRequest('Folder path contains invalid characters or is too long');
  const expanded = value === '~' || value.startsWith('~/') || process.platform === 'win32' && value.startsWith('~\\')
    ? path.join(os.homedir(), value.slice(1)) : value;
  if (!path.isAbsolute(expanded)) throw badRequest('Enter an absolute folder path or a path starting with ~');
  // Windows rooted-but-drive-relative paths (\folder or C:folder) depend on process state.
  if (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/?]+[\\/][^\\/?]+(?:[\\/]|$))/.test(expanded)) {
    throw badRequest('Use a full drive path, such as C:\\Users, or a network share path');
  }
  return path.normalize(expanded);
}

function checkComponents(value: string): void {
  const relative = value.slice(path.parse(value).root.length);
  if (relative.split(path.sep).some(isDeniedName)) throw new HttpError(403, 'This folder is excluded from workspace browsing');
}

function directoryError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return new HttpError(403, 'You do not have permission to browse this folder');
  if (code === 'ENOENT' || code === 'ENOTDIR') return new HttpError(404, 'Folder not found');
  return badRequest('This folder could not be read');
}

async function canonicalDirectory(requested: string): Promise<string> {
  checkComponents(requested);
  const real = await fs.realpath(requested);
  checkComponents(real);
  if (!(await fs.stat(real)).isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
  return real;
}

/** No file contents are read, including when following a directory symlink or Windows junction. */
export class DirectoryService {
  private rootsCache: { expires: number; value: DirectoryListing['roots'] } | null = null;
  private inflight = 0;

  private async roots(home: string): Promise<DirectoryListing['roots']> {
    if (this.rootsCache && this.rootsCache.expires > Date.now()) return this.rootsCache.value;
    const roots: DirectoryListing['roots'] = [{ name: 'Home', path: home }];
    if (process.platform === 'win32') {
      const found = await Promise.all(Array.from({ length: 26 }, (_, i) => {
        const drive = `${String.fromCharCode(65 + i)}:\\`;
        let timer: NodeJS.Timeout | undefined;
        return Promise.race([
          fs.stat(drive).then((stat) => stat.isDirectory() ? drive : null, () => null),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 500); }),
        ]).finally(() => clearTimeout(timer));
      }));
      for (const drive of found) if (drive) roots.push({ name: drive, path: drive });
    } else {
      roots.push({ name: 'Filesystem', path: '/' });
      if (process.platform === 'darwin') roots.push({ name: 'Volumes', path: '/Volumes' });
    }
    this.rootsCache = { expires: Date.now() + 10_000, value: roots };
    return roots;
  }

  async list(input?: string, query = '', hidden = false): Promise<DirectoryListing> {
    if (this.inflight >= 4) throw new HttpError(429, 'Folder browsing is busy. Try again shortly.');
    this.inflight++;
    try { return await this.read(input, query, hidden); }
    catch (error) { throw directoryError(error); }
    finally { this.inflight--; }
  }

  private async read(input: string | undefined, query: string, hidden: boolean): Promise<DirectoryListing> {
    const requested = expandPath(input);
    let real: string;
    let prefix = '';
    let exact = true;
    try { real = await canonicalDirectory(requested); }
    catch (error) {
      // Complete just the last path segment; never guess another location after a permission error.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' || path.dirname(requested) === requested) throw error;
      real = await canonicalDirectory(path.dirname(requested));
      prefix = path.basename(requested).toLocaleLowerCase();
      exact = false;
    }
    const home = await fs.realpath(os.homedir()).catch(() => os.homedir());
    const parent = path.dirname(real);
    const search = query.toLocaleLowerCase();
    const directories: LocalDirectory[] = [];
    let scanned = 0;
    let truncated = false;
    const deadline = Date.now() + BROWSE_BUDGET_MS;
    const handle = await fs.opendir(real);
    for await (const entry of handle) {
      if (++scanned > MAX_SCANNED_ENTRIES || Date.now() > deadline) { truncated = true; break; }
      if (isDeniedName(entry.name) || /[\x00-\x1f\x7f]/.test(entry.name)) continue;
      if (!hidden && (entry.name.startsWith('.') || process.platform === 'win32' && entry.name.toLowerCase() === 'appdata')) continue;
      const lower = entry.name.toLocaleLowerCase();
      if (prefix && !lower.startsWith(prefix) || search && !lower.includes(search)) continue;
      const child = path.join(real, entry.name);
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { const resolved = await fs.realpath(child); checkComponents(resolved); directory = (await fs.stat(resolved)).isDirectory(); }
        catch { continue; }
      }
      if (!directory) continue;
      if (directories.length >= MAX_DIRECTORIES) { truncated = true; break; }
      directories.push({ name: entry.name, path: child, symlink: entry.isSymbolicLink() });
    }
    directories.sort((a, b) => collator.compare(a.name, b.name) || a.name.localeCompare(b.name));
    const relativeHome = path.relative(home, real);
    const inHome = relativeHome === '' || relativeHome !== '..' && !relativeHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeHome);
    const displayPath = inHome ? `~${path.sep}${relativeHome}${relativeHome ? path.sep : ''}` : real.endsWith(path.sep) ? real : real + path.sep;
    return { path: real, displayPath, parentPath: parent === real ? null : parent, homePath: home, separator: path.sep, platform: process.platform,
      directories, roots: await this.roots(home), canSelect: exact && parent !== real, truncated };
  }

  async reveal(input: string): Promise<{ ok: true }> {
    let directory: string;
    try { directory = await canonicalDirectory(expandPath(input)); } catch (error) { throw directoryError(error); }
    const executable = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
    await new Promise<void>((resolve, reject) => {
      execFile(executable, [directory], { timeout: 5000, maxBuffer: 16_384, windowsHide: true }, (error) => {
        // Explorer can return 1 after opening an existing window successfully.
        if (!error || process.platform === 'win32' && (error as unknown as { code: unknown }).code === 1) resolve();
        else reject(new HttpError(422, 'Could not open the system file manager. Open the folder directly on this device.'));
      });
    });
    return { ok: true };
  }
}

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserSource } from '@mingle/contracts';
import { activePortEndpoint, type ResolvedEndpoint } from './endpoint.ts';
import { BrowserError } from './errors.ts';

const ACTIVE_PORT_FILE = 'DevToolsActivePort';
const MAX_ACTIVE_PORT_BYTES = 4096;

interface Candidate { name: string; userDataDir: string }

/** Default user-data directories of the common Chromium browsers. Only these exact directories are ever considered. */
export function candidateDirectories(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Candidate[] {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      { name: 'Google Chrome', userDataDir: path.join(local, 'Google', 'Chrome', 'User Data') },
      { name: 'Chromium', userDataDir: path.join(local, 'Chromium', 'User Data') },
      { name: 'Microsoft Edge', userDataDir: path.join(local, 'Microsoft', 'Edge', 'User Data') },
      { name: 'Brave', userDataDir: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
    ];
  }
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return [
      { name: 'Google Chrome', userDataDir: path.join(support, 'Google', 'Chrome') },
      { name: 'Chromium', userDataDir: path.join(support, 'Chromium') },
      { name: 'Microsoft Edge', userDataDir: path.join(support, 'Microsoft Edge') },
      { name: 'Brave', userDataDir: path.join(support, 'BraveSoftware', 'Brave-Browser') },
    ];
  }
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return [
    { name: 'Google Chrome', userDataDir: path.join(config, 'google-chrome') },
    { name: 'Chromium', userDataDir: path.join(config, 'chromium') },
    { name: 'Chromium (Snap)', userDataDir: path.join(home, 'snap', 'chromium', 'common', 'chromium') },
    { name: 'Microsoft Edge', userDataDir: path.join(config, 'microsoft-edge') },
    { name: 'Brave', userDataDir: path.join(config, 'BraveSoftware', 'Brave-Browser') },
  ];
}

export const sourceIdFor = (userDataDir: string) => `src_${createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)}`;

async function isDirectory(target: string): Promise<boolean> {
  try { return (await stat(target)).isDirectory(); } catch { return false; }
}

async function isRegularFile(target: string): Promise<boolean> {
  try { return (await lstat(target)).isFile(); } catch { return false; }
}

/**
 * Lists installed Chromium browsers. Only directory and DevToolsActivePort existence is checked:
 * no profile, cookie, login or Local State file is opened.
 */
export async function discoverSources(candidates: Candidate[] = candidateDirectories()): Promise<BrowserSource[]> {
  const found = await Promise.all(candidates.map(async (candidate) => {
    if (!(await isDirectory(candidate.userDataDir))) return null;
    return { id: sourceIdFor(candidate.userDataDir), name: candidate.name, userDataDir: candidate.userDataDir, debuggingAvailable: await isRegularFile(path.join(candidate.userDataDir, ACTIVE_PORT_FILE)) } satisfies BrowserSource;
  }));
  return found.filter((source): source is BrowserSource => source !== null);
}

/** Parses the two-line DevToolsActivePort file: a port, then the browser WebSocket path. */
export function parseActivePort(content: string): ResolvedEndpoint {
  const lines = content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const port = Number(lines[0]);
  if (lines.length < 2 || !/^\d{1,5}$/u.test(lines[0]!)) throw new BrowserError(409, 'The browser has not published a usable remote debugging address yet.');
  return activePortEndpoint(port, lines[1]!);
}

/** Reads only the selected browser's DevToolsActivePort file (regular file, no symlink, at most 4 KiB). */
export async function readActivePortEndpoint(source: BrowserSource): Promise<ResolvedEndpoint> {
  const file = path.join(source.userDataDir, ACTIVE_PORT_FILE);
  const notEnabled = new BrowserError(409, `Remote debugging is not enabled in ${source.name}. Open chrome://inspect/#remote-debugging in that browser, turn it on, then connect again.`);
  let info;
  try { info = await lstat(file); } catch { throw notEnabled; }
  if (!info.isFile() || info.size > MAX_ACTIVE_PORT_BYTES) throw notEnabled;
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const handle = await open(file, flags).catch(() => null);
  if (!handle) throw notEnabled;
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_ACTIVE_PORT_BYTES) throw notEnabled;
    const buffer = Buffer.alloc(MAX_ACTIVE_PORT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_ACTIVE_PORT_BYTES) throw notEnabled;
    return parseActivePort(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

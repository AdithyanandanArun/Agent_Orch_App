import { mkdirSync, readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root derived from this file's location, never from the caller's cwd. */
export const SOURCE_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4310;
export const WEB_DEV_PORT = 5173;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface ConfigOptions {
  /** Directory for the database, example workspace and session worktrees. Defaults to RELAY_DATA_DIR or <sourceRoot>/.relay. */
  dataDir?: string;
  host?: string;
  /** 0 picks a free port (tests). */
  port?: number;
  sourceRoot?: string;
  /** Directory with the built web app; null disables static serving. Defaults to <sourceRoot>/apps/web/dist when present. */
  webDistDir?: string | null;
  /** Extra browser origins allowed to call mutating routes and open WebSockets. */
  allowedOrigins?: string[];
  /** Port of the Vite dev server whose origin is trusted. */
  webDevPort?: number;
  /** Content-Security-Policy for static responses; null disables it. */
  csp?: string | null;
}

export interface ServerConfig {
  sourceRoot: string;
  dataDir: string;
  host: string;
  port: number;
  webDistDir: string | null;
  allowedOrigins: string[];
  webDevPort: number;
  csp: string | null;
  version: string;
}

export const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*",
  "worker-src 'self' blob:",
  'frame-src http://127.0.0.1:* http://localhost:* http://[::1]:*',
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.replace(/^\[|\]$/g, '').toLowerCase());
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${raw}`);
  return port;
}

function readVersion(sourceRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(sourceRoot, 'apps/server/package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function resolveConfig(options: ConfigOptions = {}, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : SOURCE_ROOT;
  const dataSetting = options.dataDir ?? (env.RELAY_DATA_DIR?.trim() || path.join(sourceRoot, '.relay'));
  const dataDir = path.resolve(dataSetting);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const host = options.host ?? (env.RELAY_HOST?.trim() || DEFAULT_HOST);
  if (!isLoopbackHost(host)) throw new Error(`Relay only binds loopback addresses (got ${host}).`);
  const port = options.port ?? parsePort(env.RELAY_PORT, DEFAULT_PORT);
  let webDistDir: string | null;
  if (options.webDistDir !== undefined) webDistDir = options.webDistDir;
  else if (env.RELAY_WEB_DIST) webDistDir = path.resolve(env.RELAY_WEB_DIST);
  else {
    const candidate = path.join(sourceRoot, 'apps/web/dist');
    webDistDir = existsSync(path.join(candidate, 'index.html')) ? candidate : null;
  }
  if (webDistDir && !(existsSync(webDistDir) && statSync(webDistDir).isDirectory())) webDistDir = null;
  if (webDistDir) webDistDir = realpathSync(webDistDir);
  const envOrigins = (env.RELAY_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    sourceRoot,
    dataDir: realpathSync(dataDir),
    host,
    port,
    webDistDir,
    allowedOrigins: [...(options.allowedOrigins ?? []), ...envOrigins],
    webDevPort: options.webDevPort ?? parsePort(env.RELAY_WEB_PORT, WEB_DEV_PORT),
    csp: options.csp === undefined ? DEFAULT_CSP : options.csp,
    version: readVersion(sourceRoot),
  };
}

import { BrowserError, cleanMessage } from './errors.ts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MIN_PORT = 1024;
const MAX_VERSION_BYTES = 64 * 1024;
const BROWSER_WS_PATH = /^\/devtools\/browser\/[A-Za-z0-9-]{8,80}$/u;

export interface ResolvedEndpoint {
  /** Loopback ws:// browser endpoint handed to Playwright. */
  wsUrl: string;
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase();
}

function checkLoopback(url: URL, what: string): void {
  if (!LOOPBACK_HOSTS.has(hostOf(url))) throw new BrowserError(403, `${what} must be on this machine (127.0.0.1, localhost or ::1).`);
  const port = Number(url.port);
  if (!url.port || !Number.isInteger(port) || port < MIN_PORT || port > 65535) {
    throw new BrowserError(400, `${what} needs an explicit port between ${MIN_PORT} and 65535.`);
  }
  if (url.username || url.password) throw new BrowserError(400, `${what} must not contain credentials.`);
  if (url.search || url.hash) throw new BrowserError(400, `${what} must not contain a query string or fragment.`);
}

/** Builds the ws:// endpoint for a DevToolsActivePort-style (port, path) pair; both are validated. */
export function activePortEndpoint(port: number, path: string): ResolvedEndpoint {
  if (!Number.isInteger(port) || port < MIN_PORT || port > 65535) throw new BrowserError(400, 'The browser reported an invalid debugging port.');
  if (!BROWSER_WS_PATH.test(path)) throw new BrowserError(400, 'The browser reported an invalid debugging path.');
  return { wsUrl: `ws://127.0.0.1:${port}${path}` };
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_VERSION_BYTES) { await reader.cancel().catch(() => undefined); throw new BrowserError(400, 'The debugging endpoint returned an unexpectedly large response.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Validates a user-supplied CDP endpoint. http(s) endpoints must be loopback origins; the browser's
 * webSocketDebuggerUrl is fetched without following redirects and must itself be a loopback browser endpoint.
 */
export async function resolveCdpEndpoint(raw: string): Promise<ResolvedEndpoint> {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new BrowserError(400, 'That is not a valid debugging endpoint URL.'); }
  if (url.protocol === 'ws:') {
    checkLoopback(url, 'The debugging endpoint');
    if (!BROWSER_WS_PATH.test(url.pathname)) throw new BrowserError(400, 'A ws:// endpoint must point at /devtools/browser/<id>.');
    return { wsUrl: `ws://${url.host}${url.pathname}` };
  }
  if (url.protocol !== 'http:') throw new BrowserError(400, 'The debugging endpoint must use http:// or ws://.');
  checkLoopback(url, 'The debugging endpoint');
  if (url.pathname !== '/' && url.pathname !== '') throw new BrowserError(400, 'An http:// endpoint must be a bare origin such as http://127.0.0.1:9222.');
  let payload: unknown;
  try {
    const response = await fetch(`http://${url.host}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new BrowserError(502, `The debugging endpoint answered with HTTP ${response.status}.`);
    payload = JSON.parse(await readCapped(response));
  } catch (error) {
    if (error instanceof BrowserError) throw error;
    throw new BrowserError(502, `Could not reach the browser's debugging endpoint at ${url.host}: ${cleanMessage(error, 160)}`);
  }
  const ws = typeof payload === 'object' && payload !== null ? (payload as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl : undefined;
  if (typeof ws !== 'string') throw new BrowserError(502, 'The debugging endpoint did not report a WebSocket URL.');
  let wsUrl: URL;
  try { wsUrl = new URL(ws); } catch { throw new BrowserError(502, 'The debugging endpoint reported an invalid WebSocket URL.'); }
  if (wsUrl.protocol !== 'ws:') throw new BrowserError(403, 'The debugging endpoint reported a non-local WebSocket URL.');
  checkLoopback(wsUrl, 'The reported WebSocket URL');
  if (wsUrl.port !== url.port) throw new BrowserError(403, 'The reported WebSocket URL uses a different port than the endpoint.');
  if (!BROWSER_WS_PATH.test(wsUrl.pathname)) throw new BrowserError(502, 'The debugging endpoint did not report a browser WebSocket path.');
  return { wsUrl: `ws://${wsUrl.host}${wsUrl.pathname}` };
}

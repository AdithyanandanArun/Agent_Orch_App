import { BrowserError } from './errors.ts';

const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const HOST_PORT = /^[^/\s:?#@]+:\d+(?:[/?#]|$)/u;
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/iu;

/**
 * Navigation policy for agent and human navigation: http(s) and about:blank only.
 * file:, chrome:, devtools:, javascript:, data:, view-source: and friends are rejected.
 * A scheme-less input is treated as a host name (http for loopback, https otherwise).
 */
export function normalizeNavigationUrl(input: string): string {
  const raw = input.trim();
  if (!raw || raw.length > 4096) throw new BrowserError(400, 'Provide a URL of at most 4096 characters.');
  if (raw === 'about:blank') return raw;
  let candidate = raw;
  if (!SCHEME.test(raw) || HOST_PORT.test(raw)) candidate = `${LOCAL_HOST.test(raw) ? 'http' : 'https'}://${raw}`;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new BrowserError(400, 'That is not a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserError(403, `Navigation to ${url.protocol} URLs is not allowed. Only http(s) URLs and about:blank can be opened.`);
  }
  if (url.username || url.password) throw new BrowserError(403, 'URLs with embedded credentials are not allowed.');
  return url.href;
}

/** Pages Relay may adopt or keep tracking; everything else (chrome://, devtools://, extensions, file:) is left alone. */
export function isEligibleTabUrl(url: string): boolean {
  return url === 'about:blank' || /^https?:\/\//iu.test(url);
}

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const AUTH_PATHS = new Set(['/o/oauth2/auth', '/o/oauth2/v2/auth']);
/** Accept only the native Google authorization flow returning to its own loopback listener. */
export function googleAuthorizationUrl(value: string): string | null {
  if (value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.port || url.username || url.password || url.hash || !AUTH_PATHS.has(url.pathname)) return null;
    if (url.searchParams.get('response_type') !== 'code' || !url.searchParams.get('client_id') || !url.searchParams.get('state')) return null;
    for (const key of ['response_type', 'client_id', 'state', 'redirect_uri']) if (url.searchParams.getAll(key).length !== 1) return null;
    if ([...url.searchParams.keys()].some((key) => /^(?:code|access_token|refresh_token|id_token|client_secret|code_verifier)$/i.test(key))) return null;
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.pathname !== '/' || redirect.username || redirect.password || redirect.search || redirect.hash) return null;
    return url.href;
  } catch { return null; }
}

/** Python webbrowser's documented BROWSER command override. Relay opens the URL on the host instead.
 * A quick successful no-op prevents a packaged Python browser opener from blocking before it prints
 * its native fallback link. No shell is used by Python's GenericBrowser or by this command.
 */
export function delegatedBrowserCommand(): string {
  const node = `"${process.execPath.replace(/[\\"]/g, '\\$&')}"`;
  return `${node} -e "process.exit(0)" -- "%s"`;
}

/** Request the user's existing default browser; never retain/log the authorization URL or close it. */
export async function openGoogleAuthorization(value: string, signal: AbortSignal): Promise<void> {
  const url = googleAuthorizationUrl(value);
  if (!url || signal.aborted) return;
  const file = process.platform === 'darwin' ? '/usr/bin/open'
    : process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe') : 'xdg-open';
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { resolve(); return; }
    const child = spawn(file, [url], { stdio: 'ignore', detached: true, windowsHide: true });
    let settled = false;
    const finish = (failed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (failed) reject(new Error('The default browser could not be opened. Use Open Google sign-in below.'));
      else resolve();
    };
    const onAbort = () => finish();
    // Some desktop launchers stay alive with the browser. Do not terminate the user's browser.
    const timer = setTimeout(() => finish(), 2000); timer.unref();
    child.once('error', () => finish(true));
    child.once('exit', (code) => finish(code !== 0));
    signal.addEventListener('abort', onAbort, { once: true });
    child.unref();
    if (signal.aborted) finish();
  });
}

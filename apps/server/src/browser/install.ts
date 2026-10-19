import { execFile, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { redactSecrets } from '../util.ts';
import { BrowserError, cleanMessage } from './errors.ts';

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT = 256 * 1024;
const PASS_THROUGH_ENV = [
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'ComSpec', 'LANG',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_DOWNLOAD_HOST',
];

function playwrightCli(): string {
  try {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  } catch (error) {
    throw new BrowserError(503, `The Playwright command line is not available: ${cleanMessage(error, 200)}`);
  }
}

/** Installs Playwright's pinned Chromium on explicit request. Never runs from discovery. */
export class ChromiumInstaller {
  lastError: string | null = null;
  private current: Promise<void> | null = null;
  private child: ChildProcess | null = null;

  constructor(private readonly onChange: () => void) {}

  get installing(): boolean {
    return this.current !== null;
  }

  start(): Promise<void> {
    if (this.current) return this.current;
    this.lastError = null;
    const run = this.run().then(
      () => { this.finish(); },
      (error: unknown) => { this.lastError = error instanceof BrowserError ? error.message : cleanMessage(error); this.finish(); throw error; },
    );
    this.current = run;
    this.onChange();
    return run;
  }

  /** Stops a running download, used on shutdown. */
  abort(): void {
    this.child?.kill();
  }

  private finish(): void {
    this.current = null;
    this.child = null;
    this.onChange();
  }

  private run(): Promise<void> {
    const cli = playwrightCli();
    const env: NodeJS.ProcessEnv = {};
    for (const key of PASS_THROUGH_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
    // --no-remove leaves browsers installed for other Playwright versions alone; --no-shell skips the headless-only binary.
    const args = [cli, 'install', 'chromium', '--no-shell', '--no-remove', '--no-progress'];
    return new Promise((resolve, reject) => {
      this.child = execFile(process.execPath, args, { env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (!error) return resolve();
        const detail = redactSecrets(String(stderr || stdout || error.message)).trim().split('\n').slice(-6).join(' ');
        reject(new BrowserError(503, `Installing Chromium failed: ${detail.slice(0, 600)}`));
      });
    });
  }
}

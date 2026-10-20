import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { runProbe } from '../process.js';

export interface AntigravityLaunchOptions {
  cwd: string;
  env: Record<string, string>;
  /** Variable names never forwarded into the service, even if present in `env`. */
  unsetEnv?: readonly string[];
}
export interface AntigravityLaunchPlan {
  file: string;
  args: string[];
  /** Asks the transient unit to stop; resolves even when the unit is already gone. */
  stop?: () => Promise<void>;
  /** Sends SIGKILL to every process in the transient unit; resolves even when the unit is already gone. */
  kill?: () => Promise<void>;
}

const CONTROL_TIMEOUT_MS = 2_000;
const TOOL_DIRECTORIES = ['/usr/bin', '/bin'];
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Variables the systemctl client needs to reach the user manager; nothing else is forwarded to it. */
const CONTROL_ENV_KEYS = ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];

/**
 * The runtime's native Google sign-in aborts when its hard realtime-timeout limit (RLIMIT_RTTIME) is
 * inherited as zero. The systemd user manager has a normal limit, so in that situation the runtime is
 * started as a transient user service with the limit lifted instead of inheriting ours.
 * `--pipe` forwards stdio to the caller (nothing goes to the journal) and `--wait` ties the unit's
 * lifetime to the returned command. Environment values travel through the spawn environment, never argv.
 * The caller must spawn the returned command with `options.env` (including XDG_RUNTIME_DIR and the user bus).
 */
export async function antigravityLinuxLaunch(file: string, args: string[], options: AntigravityLaunchOptions): Promise<AntigravityLaunchPlan> {
  const original: AntigravityLaunchPlan = { file, args };
  if (process.platform !== 'linux' || !(await realtimeLimitIsZero())) return original;

  const systemdRun = await findTool('systemd-run');
  const systemctl = await findTool('systemctl');
  if (!systemdRun || !systemctl) {
    const missing = [!systemdRun && 'systemd-run', !systemctl && 'systemctl'].filter(Boolean).join(' and ');
    throw new Error(
      `Antigravity cannot start here: this process has a zero realtime-timeout (RTTIME) limit that its native sign-in rejects, `
      + `and ${missing} was not found in ${TOOL_DIRECTORIES.join(' or ')}. Install systemd, or start Relay from a session `
      + `whose RTTIME limit is not zero (ulimit -R).`);
  }

  const omitted = new Set(options.unsetEnv ?? []);
  const unit = `relay-antigravity-${process.pid}-${randomUUID()}.service`;
  const launchArgs = [
    '--user', '--pipe', '--wait', '--collect', '--quiet',
    '--service-type=exec',
    '--expand-environment=no',
    `--unit=${unit}`,
    '--property=LimitRTTIME=infinity',
    '--property=TimeoutStopSec=2s',
    `--working-directory=${isAbsolute(options.cwd) ? options.cwd : resolve(options.cwd)}`,
    ...Object.keys(options.env).filter((key) => ENV_KEY.test(key) && !omitted.has(key)).map((key) => `--setenv=${key}`),
    '--', file, ...args,
  ];

  const control = async (controlArgs: string[]): Promise<void> => {
    // Failures are expected when the unit already exited, so the outcome is intentionally not reported.
    await runProbe(systemctl, ['--user', ...controlArgs, unit], {
      timeoutMs: CONTROL_TIMEOUT_MS, cwd: options.cwd, env: controlEnvironment(options.env),
    });
  };
  return {
    file: systemdRun,
    args: launchArgs,
    stop: () => control(['stop', '--no-block']),
    kill: () => control(['kill', '--signal=SIGKILL']),
  };
}

async function realtimeLimitIsZero(): Promise<boolean> {
  let limits: string;
  try { limits = await readFile('/proc/self/limits', 'utf8'); } catch { return false; }
  const row = /^Max realtime timeout[ \t]+(\S+)[ \t]+(\S+)/m.exec(limits);
  return !!row && (row[1] === '0' || row[2] === '0');
}

async function findTool(name: string): Promise<string | null> {
  for (const directory of TOOL_DIRECTORIES) {
    const candidate = `${directory}/${name}`;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* try the next directory */ }
  }
  return null;
}

function controlEnvironment(env: Record<string, string>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of CONTROL_ENV_KEYS) {
    const value = env[key] ?? process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

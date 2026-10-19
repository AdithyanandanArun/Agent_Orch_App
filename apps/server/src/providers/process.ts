import { spawn } from 'node:child_process';
import { TextTail, redactSecrets, truncate } from './common.js';

export interface ProbeResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

export interface ProbeOptions { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string }
export type ProbeFn = (file: string, args: string[], options: ProbeOptions) => Promise<ProbeResult>;

/** Runs a short-lived command without a shell, with a hard timeout and bounded output. */
export const runProbe: ProbeFn = (file, args, options) =>
  new Promise<ProbeResult>((resolve) => {
    const stdout = new TextTail(32_768);
    const stderr = new TextTail(32_768);
    let settled = false;
    let timedOut = false;
    const finish = (result: Omit<ProbeResult, 'stdout' | 'stderr' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: stdout.summary(32_768), stderr: stderr.summary(32_768), timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => finish({ ok: false, exitCode: null, signal: null, spawnError: error.code ?? error.message }));
    child.on('close', (exitCode, signal) => finish({ ok: exitCode === 0 && !timedOut, exitCode, signal, spawnError: null }));
  });

/** One-line, redacted explanation of why a probe failed. */
export function describeProbeFailure(result: ProbeResult, timeoutMs: number): string {
  if (result.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (result.spawnError) return `could not be started (${result.spawnError})`;
  const detail = (result.stderr || result.stdout).split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const exit = result.signal ? `killed by ${result.signal}` : `exit code ${result.exitCode}`;
  return detail ? `${exit}: ${truncate(redactSecrets(detail), 200)}` : exit;
}

/** The subset of ChildProcess the provider code relies on, so tests can substitute a fake. */
export interface ChildLike {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'close', listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

/** Resolves true if `promise` settled before `ms` elapsed; never leaves a timer behind. */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ShutdownOptions {
  /** Resolves once the child has fully closed. */
  closed: Promise<unknown>;
  /** The child leads its own process group, so signals can reach its descendants. */
  group: boolean;
  graceMs: number;
  termMs: number;
  killMs: number;
}

export type ShutdownOutcome = 'exited' | 'terminated' | 'killed' | 'unresponsive';

function signalChild(child: ChildLike, signal: NodeJS.Signals, group: boolean): void {
  try {
    if (group && child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** Escalating stop: close stdin, wait, SIGTERM, wait, SIGKILL. */
export async function shutdownChild(child: ChildLike, options: ShutdownOptions): Promise<ShutdownOutcome> {
  try { child.stdin?.end(); } catch { /* stdin already closed */ }
  if (await settlesWithin(options.closed, options.graceMs)) return 'exited';
  signalChild(child, 'SIGTERM', options.group);
  if (await settlesWithin(options.closed, options.termMs)) return 'terminated';
  signalChild(child, 'SIGKILL', options.group);
  return (await settlesWithin(options.closed, options.killMs)) ? 'killed' : 'unresponsive';
}

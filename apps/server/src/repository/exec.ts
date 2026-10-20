import { spawn, type ChildProcess } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
  stdin?: string | Buffer;
  signal?: AbortSignal;
  /** Starts the child in its own session so it has no controlling terminal to prompt on; the whole group is killed on timeout. */
  detached?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

const KILL_GRACE_MS = 2_000;

function failed(spawnError: NodeJS.ErrnoException): RunResult {
  return { stdout: '', stderr: '', code: null, timedOut: false, aborted: false, truncated: false, spawnError };
}

/** Runs a program from an argv array (never through a shell) with bounded output and a hard deadline. Never rejects. */
export function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) return resolve({ stdout: '', stderr: '', code: null, timedOut: false, aborted: true, truncated: false, spawnError: null });
    const group = Boolean(options.detached) && process.platform !== 'win32';
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: group, windowsHide: true, shell: false });
    } catch (error) {
      return resolve(failed(error as NodeJS.ErrnoException));
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let settled = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let killTimer: NodeJS.Timeout | undefined;

    const signalChild = (sig: NodeJS.Signals) => {
      try {
        if (group && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // The process already exited.
      }
    };
    const stop = () => {
      signalChild('SIGTERM');
      killTimer ??= setTimeout(() => signalChild('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code, timedOut, aborted, truncated, spawnError });
    };
    const deadline = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const onAbort = () => { aborted = true; stop(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes < options.maxBuffer) out.push(chunk.subarray(0, options.maxBuffer - outBytes));
      outBytes += chunk.length;
      if (outBytes > options.maxBuffer && !truncated) { truncated = true; stop(); }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes < 256 * 1024) err.push(chunk.subarray(0, 256 * 1024 - errBytes));
      errBytes += chunk.length;
    });
    child.on('error', (error) => { spawnError = error; finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.stdin);
  });
}

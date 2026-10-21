import { existsSync, statSync } from 'node:fs';
import { z } from 'zod';
import type { ClientEvent } from '@mingle/contracts';
import type { WebSocket } from 'ws';
import type { Hub } from './hub.ts';
import type { Store } from './store.ts';
import type { Logger } from './types.ts';
import { conflict, errorMessage, newId } from './util.ts';

export const MAX_TERMINALS_PER_SOCKET = 8;
export const MAX_TERMINALS_TOTAL = 32;
export const MIN_COLS = 2, MAX_COLS = 500, MIN_ROWS = 1, MAX_ROWS = 300;
export const MAX_INPUT_BYTES = 64 * 1024;

const size = { cols: z.number().int().min(MIN_COLS).max(MAX_COLS), rows: z.number().int().min(MIN_ROWS).max(MAX_ROWS) };
const ClientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('terminal.start'), projectId: z.string().min(1).max(100), sessionId: z.string().min(1).max(100).optional(), ...size }),
  z.object({ type: z.literal('terminal.input'), terminalId: z.string().min(1).max(100), data: z.string().max(MAX_INPUT_BYTES) }),
  z.object({ type: z.literal('terminal.resize'), terminalId: z.string().min(1).max(100), ...size }),
  z.object({ type: z.literal('terminal.stop'), terminalId: z.string().min(1).max(100) }),
]) satisfies z.ZodType<ClientEvent>;

interface PtyHandle {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number }) => void): void;
}

interface Terminal { id: string; projectId: string; sessionId?: string; owner: WebSocket; pty: PtyHandle; exited: boolean; backpressure: NodeJS.Timeout | null }

export type PtySpawner = (shell: string, args: string[], options: { cwd: string; cols: number; rows: number; env: Record<string, string> }) => Promise<PtyHandle>;

const defaultSpawner: PtySpawner = async (shell, args, options) => {
  const pty = await import('node-pty');
  return pty.spawn(shell, args, { name: 'xterm-256color', cwd: options.cwd, cols: options.cols, rows: options.rows, env: options.env }) as unknown as PtyHandle;
};

export interface TerminalOptions { shell?: string; spawner?: PtySpawner }

/** Real PTY terminals over the shared WebSocket. A terminal is owned by the socket that created it and dies with it. */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();
  private readonly pending = new Map<WebSocket, number>();
  private readonly pendingSessions = new Map<string, number>();
  private readonly sessionStartWaiters = new Map<string, Set<() => void>>();
  private readonly stoppingSessions = new Set<string>();
  private pendingTotal = 0;
  private readonly pendingProjects = new Map<string, number>();
  private readonly shell: string;
  private readonly spawner: PtySpawner;

  constructor(private readonly store: Store, private readonly hub: Hub, private readonly log: Logger, options: TerminalOptions = {}) {
    this.shell = options.shell ?? (process.platform === 'win32' ? process.env.COMSPEC ?? 'powershell.exe' : process.env.SHELL || '/bin/sh');
    this.spawner = options.spawner ?? defaultSpawner;
  }

  get count(): number {
    return this.terminals.size;
  }
  hasProject(projectId: string): boolean {
    return (this.pendingProjects.get(projectId) ?? 0) > 0 || [...this.terminals.values()].some((terminal) => terminal.projectId === projectId && !terminal.exited);
  }

  /** Stops session-scoped shells and prevents a concurrent PTY start from outliving archival. */
  async withSessionsStopped<T>(sessionIds: string[], action: () => Promise<T> | T): Promise<T> {
    const ids = [...new Set(sessionIds)];
    if (ids.some((id) => this.stoppingSessions.has(id))) throw conflict('A session terminal is already being removed.');
    for (const id of ids) this.stoppingSessions.add(id);
    for (const terminal of this.terminals.values()) if (terminal.sessionId && ids.includes(terminal.sessionId)) this.kill(terminal);
    try {
      await Promise.all(ids.map((id) => this.waitForSessionStarts(id)));
      return await action();
    } finally {
      for (const id of ids) this.stoppingSessions.delete(id);
    }
  }

  private waitForSessionStarts(sessionId: string): Promise<void> {
    if (!this.pendingSessions.has(sessionId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.sessionStartWaiters.get(sessionId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.sessionStartWaiters.set(sessionId, waiters);
    });
  }

  private releaseSessionStart(sessionId: string): void {
    const remaining = (this.pendingSessions.get(sessionId) ?? 1) - 1;
    if (remaining > 0) {
      this.pendingSessions.set(sessionId, remaining);
      return;
    }
    this.pendingSessions.delete(sessionId);
    const waiters = this.sessionStartWaiters.get(sessionId);
    this.sessionStartWaiters.delete(sessionId);
    for (const resolve of waiters ?? []) resolve();
  }

  handleMessage(socket: WebSocket, raw: string): void {
    let parsed: ClientEvent;
    try {
      parsed = ClientEventSchema.parse(JSON.parse(raw));
    } catch {
      return; // malformed or out-of-range client messages are dropped
    }
    switch (parsed.type) {
      case 'terminal.start':
        void this.start(socket, parsed);
        break;
      case 'terminal.input': {
        const terminal = this.owned(socket, parsed.terminalId);
        if (terminal && !terminal.exited) terminal.pty.write(parsed.data);
        break;
      }
      case 'terminal.resize': {
        const terminal = this.owned(socket, parsed.terminalId);
        if (terminal && !terminal.exited) {
          try { terminal.pty.resize(parsed.cols, parsed.rows); } catch (error) { this.log('warn', 'PTY resize failed', error); }
        }
        break;
      }
      case 'terminal.stop': {
        const terminal = this.owned(socket, parsed.terminalId);
        if (terminal) this.kill(terminal);
        break;
      }
    }
  }

  private owned(socket: WebSocket, id: string): Terminal | undefined {
    const terminal = this.terminals.get(id);
    return terminal && terminal.owner === socket ? terminal : undefined;
  }

  private fail(socket: WebSocket, message: string): void {
    this.hub.send(socket, { type: 'terminal.error', message });
  }

  private async start(socket: WebSocket, request: Extract<ClientEvent, { type: 'terminal.start' }>): Promise<void> {
    const mine = [...this.terminals.values()].filter((t) => t.owner === socket && !t.exited).length;
    if (mine + (this.pending.get(socket) ?? 0) >= MAX_TERMINALS_PER_SOCKET || this.terminals.size + this.pendingTotal >= MAX_TERMINALS_TOTAL) return this.fail(socket, 'Too many open terminals');
    const project = this.store.getProject(request.projectId);
    if (!project) return this.fail(socket, 'Unknown project');
    let cwd = project.path;
    if (request.sessionId) {
      if (this.stoppingSessions.has(request.sessionId)) return this.fail(socket, 'This session is being removed');
      const session = this.store.getSession(request.sessionId);
      if (!session || session.projectId !== project.id) return this.fail(socket, 'Unknown session for this project');
      cwd = session.worktreePath;
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return this.fail(socket, 'Working directory does not exist');
    const id = newId('trm');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('MINGLE_') && !key.startsWith('RELAY_')) env[key] = value;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    let pty: PtyHandle;
    // Reserve capacity synchronously: multiple starts can be awaiting the native spawner at once.
    this.pending.set(socket, (this.pending.get(socket) ?? 0) + 1);
    this.pendingTotal++;
    this.pendingProjects.set(project.id, (this.pendingProjects.get(project.id) ?? 0) + 1);
    if (request.sessionId) this.pendingSessions.set(request.sessionId, (this.pendingSessions.get(request.sessionId) ?? 0) + 1);
    try {
      pty = await this.spawner(this.shell, process.platform === 'win32' ? [] : ['-i'], { cwd, cols: request.cols, rows: request.rows, env });
    } catch (error) {
      this.log('error', 'Failed to start PTY', error);
      return this.fail(socket, `Could not start a terminal: ${errorMessage(error)}`);
    } finally {
      const remaining = (this.pending.get(socket) ?? 1) - 1;
      if (remaining > 0) this.pending.set(socket, remaining);
      else this.pending.delete(socket);
      this.pendingTotal--;
      const projectPending = (this.pendingProjects.get(project.id) ?? 1) - 1;
      if (projectPending > 0) this.pendingProjects.set(project.id, projectPending);
      else this.pendingProjects.delete(project.id);
      if (request.sessionId) this.releaseSessionStart(request.sessionId);
    }
    const terminal: Terminal = { id, projectId: project.id, sessionId: request.sessionId, owner: socket, pty, exited: false, backpressure: null };
    if (socket.readyState !== socket.OPEN || (request.sessionId && this.stoppingSessions.has(request.sessionId))) {
      try { pty.kill(); } catch { /* already gone */ }
      if (socket.readyState === socket.OPEN) this.fail(socket, 'This session is being removed');
      return;
    }
    this.terminals.set(id, terminal);
    pty.onData((data) => {
      this.hub.send(socket, { type: 'terminal.output', terminalId: id, data });
      if (socket.bufferedAmount > 4 * 1024 * 1024 && !terminal.backpressure) {
        pty.pause();
        terminal.backpressure = setInterval(() => {
          if (socket.bufferedAmount < 512 * 1024 || socket.readyState !== socket.OPEN) {
            clearInterval(terminal.backpressure!);
            terminal.backpressure = null;
            try { pty.resume(); } catch { /* exited */ }
          }
        }, 50);
      }
    });
    pty.onExit(({ exitCode }) => {
      terminal.exited = true;
      if (terminal.backpressure) clearInterval(terminal.backpressure);
      this.terminals.delete(id);
      this.hub.send(socket, { type: 'terminal.exit', terminalId: id, exitCode });
    });
    this.hub.send(socket, { type: 'terminal.ready', terminalId: id });
  }

  private kill(terminal: Terminal): void {
    if (terminal.exited) return;
    try { terminal.pty.kill(); } catch (error) { this.log('warn', 'PTY kill failed', error); }
  }

  /** Called when a socket closes: its terminals never outlive it. */
  releaseSocket(socket: WebSocket): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.owner !== socket) continue;
      this.kill(terminal);
      this.terminals.delete(terminal.id);
    }
  }

  killAll(): void {
    for (const terminal of [...this.terminals.values()]) {
      this.kill(terminal);
      this.terminals.delete(terminal.id);
    }
  }

  /** Test helper: pids of live terminals. */
  pids(): number[] {
    return [...this.terminals.values()].map((t) => t.pty.pid);
  }
}

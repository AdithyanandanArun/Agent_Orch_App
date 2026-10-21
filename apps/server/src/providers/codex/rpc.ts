import { ProviderError, isRecord, redactSecrets, truncate } from '../common.js';
import type { ChildLike } from '../process.js';

export interface CloseInfo { exitCode: number | null; signal: NodeJS.Signals | null; error: Error | null }

/** A JSON-RPC error object returned by (or sent to) the peer. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;

export interface ConnectionHooks {
  onNotification(method: string, params: unknown): void;
  /** Return the result for a server-initiated request, or throw RpcError to answer with an error. */
  onRequest(method: string, params: unknown, requestId: number | string): Promise<unknown>;
  /** Builds the message used to reject in-flight requests when the process goes away. */
  formatClose(info: CloseInfo): string;
  onIssue?(message: string): void;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const MAX_LINE_CHARS = 16 * 1024 * 1024;

/**
 * Newline-delimited JSON-RPC 2.0 (header omitted, as the Codex app-server does) over a child's stdio.
 * Every in-flight request is rejected as soon as the process closes.
 */
export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private buffer = '';
  private discarding = false;
  private closeInfo: CloseInfo | null = null;
  readonly closed: Promise<CloseInfo>;

  constructor(private readonly child: ChildLike, private readonly hooks: ConnectionHooks) {
    let finish: (info: CloseInfo) => void = () => undefined;
    this.closed = new Promise<CloseInfo>((resolve) => { finish = resolve; });
    const onClose = (info: CloseInfo): void => {
      if (this.closeInfo) return;
      this.closeInfo = info;
      const reason = new ProviderError(hooks.formatClose(info), { code: 'process_exited', cause: info.error ?? undefined });
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(reason);
      }
      finish(info);
    };
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => this.receive(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    child.stdin?.on('error', () => undefined); // EPIPE surfaces through the close event
    child.on('error', (error) => onClose({ exitCode: null, signal: null, error }));
    child.on('close', (exitCode, signal) => onClose({ exitCode, signal, error: null }));
  }

  get isClosed(): boolean { return this.closeInfo !== null; }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closeInfo) return Promise.reject(new ProviderError(this.hooks.formatClose(this.closeInfo), { code: 'process_exited' }));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError(`Codex app-server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`, { code: 'timeout' }));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ method, params });
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (this.closeInfo || !stdin || (stdin as { destroyed?: boolean }).destroyed || (stdin as { writableEnded?: boolean }).writableEnded) {
      throw new ProviderError('Codex app-server is not accepting input.', { code: 'process_exited' });
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (this.discarding) { this.discarding = false; continue; }
      if (line.trim()) this.dispatch(line);
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.hooks.onIssue?.('Dropped an oversized JSON-RPC line from the Codex app-server.');
      this.buffer = '';
      this.discarding = true;
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.hooks.onIssue?.(`Ignored non-JSON output from the Codex app-server: ${truncate(redactSecrets(line), 160)}`);
      return;
    }
    if (!isRecord(message)) { this.hooks.onIssue?.('Ignored a JSON-RPC message that is not an object.'); return; }
    const { id, method } = message;
    const hasId = typeof id === 'number' || typeof id === 'string';
    if (typeof method === 'string' && hasId) { void this.answerRequest(id, method, message.params); return; }
    if (typeof method === 'string') {
      try { this.hooks.onNotification(method, message.params); } catch (error) {
        this.hooks.onIssue?.(`Notification handler for ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (hasId) { this.settle(id, message); return; }
    this.hooks.onIssue?.('Ignored a JSON-RPC message without id or method.');
  }

  private settle(id: number | string, message: Record<string, unknown>): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (isRecord(message.error)) {
      const { code, message: text, data } = message.error;
      entry.reject(new RpcError(typeof code === 'number' ? code : RPC_INTERNAL_ERROR, redactSecrets(typeof text === 'string' ? text : `${entry.method} failed`), data));
    } else {
      entry.resolve(message.result);
    }
  }

  private async answerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    let response: Record<string, unknown>;
    try {
      response = { id, result: (await this.hooks.onRequest(method, params, id)) ?? {} };
    } catch (error) {
      response = error instanceof RpcError
        ? { id, error: { code: error.code, message: error.message } }
        : { id, error: { code: RPC_INTERNAL_ERROR, message: truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 300) } };
    }
    try { this.write(response); } catch { /* the process is gone; nothing left to answer */ }
  }
}

import { ProviderError, isRecord, redactSecrets, truncate } from '../common.js';
import type { ChildLike } from '../process.js';

export const ACP_METHOD_NOT_FOUND = -32601;
export const ACP_INVALID_PARAMS = -32602;
export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = 'AcpRpcError'; }
}
export interface AcpCloseInfo { exitCode: number | null; signal: NodeJS.Signals | null; error: Error | null }
interface Pending { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
export interface AcpHooks {
  notification(method: string, params: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
  closeMessage(info: AcpCloseInfo): string;
  issue?(message: string): void;
}
const MAX_LINE = 16 * 1024 * 1024;

/** Newline-delimited ACP JSON-RPC over one `opencode acp` child. */
export class OpencodeConnection {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private buffer = '';
  private discarding = false;
  private closeInfo: AcpCloseInfo | null = null;
  readonly closed: Promise<AcpCloseInfo>;
  constructor(private readonly child: ChildLike, private readonly hooks: AcpHooks) {
    let finish!: (info: AcpCloseInfo) => void;
    this.closed = new Promise((resolve) => { finish = resolve; });
    const close = (info: AcpCloseInfo): void => {
      if (this.closeInfo) return;
      this.closeInfo = info;
      const error = new ProviderError(hooks.closeMessage(info), { code: 'process_exited', cause: info.error ?? undefined });
      for (const [id, item] of this.pending) { clearTimeout(item.timer); this.pending.delete(id); item.reject(error); }
      finish(info);
    };
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => this.receive(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    child.stdin?.on('error', () => undefined);
    child.on('error', (error) => close({ exitCode: null, signal: null, error }));
    child.on('close', (exitCode, signal) => close({ exitCode, signal, error: null }));
  }
  get isClosed(): boolean { return this.closeInfo !== null; }
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closeInfo) return Promise.reject(new ProviderError(this.hooks.closeMessage(this.closeInfo), { code: 'process_exited' }));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError(`OpenCode ACP did not answer ${method} within ${Math.ceil(timeoutMs / 1000)}s.`, { code: 'timeout' }));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params: unknown = {}): void { this.write({ jsonrpc: '2.0', method, params }); }
  private write(message: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (this.closeInfo || !stdin || (stdin as { destroyed?: boolean }).destroyed || (stdin as { writableEnded?: boolean }).writableEnded) {
      throw new ProviderError('OpenCode ACP is not accepting input.', { code: 'process_exited' });
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
      if (line.length > MAX_LINE) { this.hooks.issue?.('Dropped an oversized ACP JSON-RPC line.'); continue; }
      if (line.trim()) this.dispatch(line);
    }
    if (this.buffer.length > MAX_LINE) { this.hooks.issue?.('Dropped an oversized ACP JSON-RPC line.'); this.buffer = ''; this.discarding = true; }
  }
  private dispatch(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { this.hooks.issue?.('Ignored non-JSON output from OpenCode ACP.'); return; }
    if (!isRecord(value) || value.jsonrpc !== '2.0') { this.hooks.issue?.('Ignored a malformed ACP JSON-RPC message.'); return; }
    const id = value.id;
    const hasId = typeof id === 'number' || typeof id === 'string';
    if (typeof value.method === 'string' && hasId) { void this.answer(id, value.method, value.params); return; }
    if (typeof value.method === 'string') {
      try { this.hooks.notification(value.method, value.params); } catch { this.hooks.issue?.(`ACP notification ${value.method} could not be handled.`); }
      return;
    }
    if (hasId) {
      const item = this.pending.get(id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(id);
      if (isRecord(value.error)) {
        item.reject(new AcpRpcError(typeof value.error.code === 'number' ? value.error.code : -32603,
          redactSecrets(typeof value.error.message === 'string' ? value.error.message : `${item.method} failed`), value.error.data));
      } else item.resolve(value.result);
    }
  }
  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    let message: Record<string, unknown>;
    try { message = { jsonrpc: '2.0', id, result: (await this.hooks.request(method, params)) ?? {} }; }
    catch (error) {
      message = { jsonrpc: '2.0', id, error: error instanceof AcpRpcError
        ? { code: error.code, message: error.message }
        : { code: -32603, message: truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 300) } };
    }
    try { this.write(message); } catch { /* closed */ }
  }
}

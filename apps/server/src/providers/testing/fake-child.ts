import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildLike } from '../process.js';

export type Json = Record<string, any>;

export interface FakeChildOptions {
  /** Called for every JSON line the client writes. */
  onMessage?: (message: Json, child: FakeChild) => void;
  /** Signals that make the fake exit; anything else is ignored (a stubborn process). */
  diesOn?: NodeJS.Signals[];
  /** Whether closing stdin makes the process exit, as the real app-server does. */
  exitsOnStdinEnd?: boolean;
}

/** In-memory stand-in for a child process speaking newline-delimited JSON on stdio. */
export class FakeChild extends EventEmitter implements ChildLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  readonly received: Json[] = [];
  readonly signals: NodeJS.Signals[] = [];
  closed = false;
  private buffer = '';

  constructor(private readonly options: FakeChildOptions = {}) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Json;
        this.received.push(message);
        queueMicrotask(() => this.options.onMessage?.(message, this));
      }
    });
    this.stdin.on('end', () => { if (this.options.exitsOnStdinEnd ?? true) setImmediate(() => this.exit(0)); });
  }

  send(message: Json): void { if (!this.closed) this.stdout.write(`${JSON.stringify(message)}\n`); }
  reply(request: Json, result: unknown = {}): void { this.send({ id: request.id, result }); }
  fail(request: Json, code: number, message: string): void { this.send({ id: request.id, error: { code, message } }); }
  notify(method: string, params: unknown): void { this.send({ method, params }); }
  serverRequest(id: number | string, method: string, params: unknown): void { this.send({ id, method, params }); }
  log(text: string): void { this.stderr.write(text); }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    const name = (typeof signal === 'number' ? 'SIGTERM' : signal) as NodeJS.Signals;
    this.signals.push(name);
    if ((this.options.diesOn ?? ['SIGTERM', 'SIGKILL']).includes(name)) setImmediate(() => this.exit(null, name));
    return true;
  }

  requestsFor(method: string): Json[] { return this.received.filter((message) => message.method === method); }
  responseFor(id: number | string): Json | undefined { return this.received.find((message) => message.id === id && message.method === undefined); }
}

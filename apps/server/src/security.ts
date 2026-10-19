import type { IncomingMessage } from 'node:http';
import { isLoopbackHost } from './config.ts';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface SecurityOptions {
  /** Actual listening port; resolved lazily because tests listen on port 0. */
  getPort: () => number;
  webDevPort: number;
  extraOrigins: string[];
}

export interface Verdict { ok: boolean; reason?: string }

function splitHost(value: string): { hostname: string; port: string } | null {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(value.trim());
  if (!match) return null;
  return { hostname: match[1]!.replace(/^\[|\]$/g, '').toLowerCase(), port: match[2] ?? '' };
}

/**
 * Guards the loopback server against DNS rebinding (Host header) and cross-site request forgery / cross-origin WebSocket
 * hijacking (Origin header). The Electron shell loads the app from the server's own origin, so it is covered by the
 * same-origin rule; the Vite dev server origin is allowed explicitly.
 */
export class Security {
  constructor(private readonly options: SecurityOptions) {}

  private allowedPorts(): Set<string> {
    return new Set([String(this.options.getPort()), String(this.options.webDevPort)]);
  }

  private extraHostPorts(): Set<string> {
    const set = new Set<string>();
    for (const origin of this.options.extraOrigins) {
      try { set.add(new URL(origin).host.toLowerCase()); } catch { /* ignore malformed entries */ }
    }
    return set;
  }

  allowedOrigins(): string[] {
    const origins: string[] = [];
    for (const port of this.allowedPorts()) for (const host of ['localhost', '127.0.0.1', '[::1]']) origins.push(`http://${host}:${port}`);
    return [...origins, ...this.options.extraOrigins];
  }

  checkHost(header: string | undefined): Verdict {
    if (!header) return { ok: false, reason: 'Missing Host header' };
    const parsed = splitHost(header);
    if (!parsed) return { ok: false, reason: 'Malformed Host header' };
    if (this.extraHostPorts().has(header.toLowerCase())) return { ok: true };
    if (!isLoopbackHost(parsed.hostname)) return { ok: false, reason: `Host ${parsed.hostname} is not allowed` };
    if (!this.allowedPorts().has(parsed.port)) return { ok: false, reason: `Host port ${parsed.port || '(default)'} is not allowed` };
    return { ok: true };
  }

  checkOrigin(origin: string | undefined, required: boolean): Verdict {
    if (origin === undefined) return required ? { ok: false, reason: 'Missing Origin header' } : { ok: true };
    return this.allowedOrigins().includes(origin.toLowerCase()) || this.options.extraOrigins.includes(origin) ? { ok: true } : { ok: false, reason: `Origin ${origin} is not allowed` };
  }

  /**
   * HTTP: every request needs a loopback Host; state-changing requests additionally need an allowed Origin when the
   * client sends one (browsers always do). Requests without Origin come from non-browser local clients.
   */
  checkHttp(req: IncomingMessage): Verdict {
    const host = this.checkHost(req.headers.host);
    if (!host.ok) return host;
    const method = (req.method ?? 'GET').toUpperCase();
    const origin = req.headers.origin;
    if (MUTATING.has(method) || method === 'OPTIONS') return this.checkOrigin(origin, false);
    // Reads with a foreign Origin are cross-site fetches; the browser would block reading, but be strict anyway.
    if (typeof origin === 'string' && origin !== 'null') return this.checkOrigin(origin, false);
    if (origin === 'null') return { ok: false, reason: 'Opaque origins are not allowed' };
    return { ok: true };
  }

  checkWebSocket(req: IncomingMessage): Verdict {
    const host = this.checkHost(req.headers.host);
    if (!host.ok) return host;
    const origin = req.headers.origin;
    return this.checkOrigin(Array.isArray(origin) ? origin[0] : origin, false);
  }
}

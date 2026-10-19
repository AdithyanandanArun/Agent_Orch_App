import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

/**
 * Serves the built web app. Only files that resolve (after symlink resolution) inside the dist directory are served;
 * dotfiles are refused and unknown extensionless paths fall back to index.html for client-side routing.
 */
export async function serveStatic(distDir: string, req: IncomingMessage, res: ServerResponse, csp: string | null): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://relay.local').pathname);
  } catch {
    return false;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return false;
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s.startsWith('.'))) return false;
  const wantsIndex = segments.length === 0 || !path.extname(segments[segments.length - 1]!);
  let target = path.join(distDir, ...segments);
  let real: string | null = null;
  try {
    real = await fsp.realpath(target);
    const rel = path.relative(distDir, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) real = null;
    else if ((await fsp.stat(real)).isDirectory()) real = null;
  } catch {
    real = null;
  }
  if (!real) {
    if (!wantsIndex) return false;
    target = path.join(distDir, 'index.html');
    try { real = await fsp.realpath(target); } catch { return false; }
  }
  const stat = await fsp.stat(real);
  const ext = path.extname(real).toLowerCase();
  const isIndex = path.basename(real) === 'index.html';
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', isIndex ? 'no-cache' : segments[0] === 'assets' ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (csp && isIndex) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'DENY');
  }
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise<void>((resolve) => {
    const stream = createReadStream(real!);
    stream.on('error', () => { res.destroy(); resolve(); });
    stream.on('close', () => resolve());
    stream.pipe(res);
  });
  return true;
}

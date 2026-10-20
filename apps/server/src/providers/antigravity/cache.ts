import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { PolicySchema } from '@relay/contracts';
import type { AntigravityMetadata } from './runtime.js';

// Public discovery results only. Authentication state, credentials and authorization links never enter this file.
const MAX_BYTES = 512 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60_000;
const text = (max: number) => z.string().max(max).refine((value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const effort = z.object({ id: text(40).regex(/^[a-z][a-z0-9_-]*$/), label: text(200), description: text(400).optional() });
const metadataSchema = z.object({
  version: text(100),
  models: z.array(z.object({
    id: text(150).min(1), name: text(200).min(1),
    reasoningEfforts: z.array(effort).max(64).optional(), defaultReasoningEffort: text(40).optional(),
    policies: z.array(PolicySchema).max(4).optional(),
  })).min(1).max(200),
  commands: z.array(z.object({
    id: text(100).regex(/^[A-Za-z0-9_-]+$/), name: text(100).regex(/^[A-Za-z0-9_-]+$/),
    description: text(400), argumentHint: text(150).optional(), source: z.literal('provider'), kind: z.literal('prompt'),
  })).max(100),
  choices: z.object({ currentModel: text(150).nullable(), modes: z.array(text(150)).max(200), thinkingLevels: z.array(text(40)).max(64) }),
});
const envelope = z.object({ schema: z.literal(1), savedAt: z.number().finite(), metadata: metadataSchema });

function directory(env: NodeJS.ProcessEnv): string {
  const preferred = process.platform === 'win32' ? env.LOCALAPPDATA : process.platform === 'darwin' ? undefined : env.XDG_CACHE_HOME;
  const base = preferred && isAbsolute(preferred) ? preferred : process.platform === 'win32' ? join(homedir(), 'AppData', 'Local') : process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches') : join(homedir(), '.cache');
  return join(base, 'Relay', 'antigravity');
}

function filename(executable: string, context: string, env: NodeJS.ProcessEnv): string {
  // A replaced runtime must not inherit choices from its predecessor, even at the same configured path.
  const stat = statSync(executable);
  const key = createHash('sha256').update(JSON.stringify([context, stat.size, stat.mtimeMs, stat.ctimeMs])).digest('hex');
  return join(directory(env), `${key}.json`);
}

function prune(env: NodeJS.ProcessEnv): void {
  const root = directory(env);
  const entries = readdirSync(root).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).flatMap((name) => {
    try { const path = join(root, name); return [{ path, modified: statSync(path).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.modified - a.modified);
  for (const [index, entry] of entries.entries()) {
    if (index >= 16 || Date.now() - entry.modified > MAX_AGE) { try { unlinkSync(entry.path); } catch { /* Another process can prune concurrently. */ } }
  }
}

export function readAntigravityMetadata(executable: string, context: string, env: NodeJS.ProcessEnv): AntigravityMetadata | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filename(executable, context, env), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return;
    const result = envelope.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
    if (!result.success || result.data.savedAt > Date.now() + 60_000 || Date.now() - result.data.savedAt > MAX_AGE) return;
    return result.data.metadata;
  } catch { return; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function writeAntigravityMetadata(executable: string, context: string, env: NodeJS.ProcessEnv, value: AntigravityMetadata): void {
  let temporary: string | undefined;
  try {
    // Validation strips unknown provider fields instead of serializing arbitrary native payloads.
    const metadata = metadataSchema.parse(value);
    const data = JSON.stringify({ schema: 1, savedAt: Date.now(), metadata });
    if (Buffer.byteLength(data) > MAX_BYTES) return;
    const target = filename(executable, context, env);
    mkdirSync(directory(env), { recursive: true, mode: 0o700 });
    temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
    prune(env);
  } catch { /* An unwritable cache never prevents using live native metadata. */ }
  finally { if (temporary) { try { unlinkSync(temporary); } catch { /* Already atomically renamed. */ } } }
}

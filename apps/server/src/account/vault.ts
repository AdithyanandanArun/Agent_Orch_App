import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function writePrivateJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** The key crosses a private parent/child IPC channel, never argv, the environment or the renderer. */
export async function desktopAccountKey(): Promise<Buffer | null> {
  const expected = process.env.MINGLE_ACCOUNT_IPC === '1' && Boolean(process.channel);
  delete process.env.MINGLE_ACCOUNT_IPC;
  if (!expected) return null;
  return new Promise((resolve) => {
    const finish = (key: Buffer | null) => {
      clearTimeout(timer);
      process.off('message', receive);
      if (process.connected) process.disconnect();
      resolve(key);
    };
    const receive = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'mingle.account-key') return;
      const raw = 'key' in message ? message.key : null;
      const key = typeof raw === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(raw) ? Buffer.from(raw, 'base64') : null;
      finish(key?.length === 32 ? key : null);
    };
    const timer = setTimeout(() => finish(null), 5000);
    process.on('message', receive);
    process.send?.({ type: 'mingle.account-key.request' });
  });
}

/** Supabase storage adapter. PKCE verifiers and Google's tokens are never written to disk. */
export class AccountVault {
  private values = new Map<string, string>();
  readonly file: string;
  constructor(dataDir: string, private key: Buffer | null) {
    this.file = path.join(dataDir, 'account-session.enc');
    if (key && existsSync(this.file)) {
      if (statSync(this.file).size > 1024 * 1024) throw new Error('Saved account session is too large');
      const record = JSON.parse(readFileSync(this.file, 'utf8')) as { iv: string; tag: string; data: string };
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
      decipher.setAAD(Buffer.from('mingle-account-session-v1'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const raw = Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
      const entries = Object.entries(JSON.parse(raw) as Record<string, unknown>);
      if (entries.some(([name, value]) => !name.startsWith('mingle-account-session') || typeof value !== 'string')) throw new Error('Invalid saved account session');
      this.values = new Map(entries as [string, string][]);
    }
  }
  get persistent() { return Boolean(this.key); }
  getItem = (key: string): string | null => this.values.get(key) ?? null;
  setItem = (key: string, value: string): void => {
    if (!key.endsWith('-code-verifier')) {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      delete parsed.provider_token;
      delete parsed.provider_refresh_token;
      value = JSON.stringify(parsed);
    }
    this.values.set(key, value);
    this.persist();
  };
  removeItem = (key: string): void => { this.values.delete(key); this.persist(); };
  clear(): void { this.values.clear(); rmSync(this.file, { force: true }); }
  close(): void { this.values.clear(); this.key?.fill(0); this.key = null; }
  private persist(): void {
    if (!this.key) return;
    const persisted = Object.fromEntries([...this.values].filter(([key]) => !key.endsWith('-code-verifier')));
    if (!Object.keys(persisted).length) { rmSync(this.file, { force: true }); return; }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('mingle-account-session-v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(persisted)), cipher.final()]);
    writePrivateJson(this.file, { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
  }
}

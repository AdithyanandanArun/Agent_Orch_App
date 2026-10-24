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

export class AccountVaultError extends Error {
  constructor(readonly reason: 'session-unreadable' | 'storage-write-failed') { super(reason); }
}

/** Supabase storage adapter. PKCE verifiers and Google's tokens are never written to disk. */
export class AccountVault {
  private values = new Map<string, string>();
  private signInPending = false;
  readonly file: string;
  constructor(dataDir: string, private key: Buffer | null, private readonly failed?: (reason: 'storage-write-failed') => void) {
    this.file = path.join(dataDir, 'account-session.enc');
    if (key) this.values = this.readSaved(key);
  }
  private readSaved(key: Buffer): Map<string, string> {
    if (!existsSync(this.file)) return new Map();
    try {
      if (statSync(this.file).size > 1024 * 1024) throw new Error('Saved account session is too large');
      const record = JSON.parse(readFileSync(this.file, 'utf8')) as { iv: string; tag: string; data: string };
      const decode = (value: unknown, length?: number) => {
        if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid ciphertext');
        const bytes = Buffer.from(value, 'base64');
        if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) throw new Error('Invalid ciphertext');
        return bytes;
      };
      const decipher = createDecipheriv('aes-256-gcm', key, decode(record.iv, 12));
      decipher.setAAD(Buffer.from('mingle-account-session-v1'));
      decipher.setAuthTag(decode(record.tag, 16));
      const raw = Buffer.concat([decipher.update(decode(record.data)), decipher.final()]).toString('utf8');
      const entries = Object.entries(JSON.parse(raw) as Record<string, unknown>);
      if (entries.some(([name, value]) => name !== 'mingle-account-session' || typeof value !== 'string')) throw new Error('Invalid saved account session');
      return new Map(entries as [string, string][]);
    } catch { throw new AccountVaultError('session-unreadable'); }
  }
  /** Preserve the current account and pending PKCE verifier while upgrading an in-memory session. */
  enablePersistence(key: Buffer, restoreSaved: boolean): { restored: boolean } {
    const saved = this.readSaved(key); // Authenticate existing ciphertext before replacing anything.
    const restored = restoreSaved && !this.values.has('mingle-account-session') && saved.has('mingle-account-session');
    const previous = this.values;
    if (restored) this.values = new Map([...saved, ...this.values]);
    const previousKey = this.key;
    this.key = key;
    try {
      // With only a pending verifier, leave the prior saved session untouched until sign-in completes.
      if (!this.signInPending && this.values.has('mingle-account-session')) this.writeSession();
    } catch {
      this.key = previousKey; this.values = previous;
      throw new AccountVaultError('storage-write-failed');
    }
    if (previousKey && previousKey !== key) previousKey.fill(0);
    return { restored };
  }
  get persistent() { return Boolean(this.key); }
  /** OAuth can replace storage before its user is verified. Commit only a verified sign-in. */
  beginSignIn(): void { this.signInPending = true; }
  finishSignIn(verified: boolean): void {
    this.signInPending = false;
    if (verified) this.persist();
    else this.values.clear();
  }
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
  removeItem = (key: string): void => {
    this.values.delete(key);
    if (key === 'mingle-account-session' && !this.signInPending) rmSync(this.file, { force: true });
    else this.persist();
  };
  clear(): void { this.values.clear(); if (!this.signInPending) rmSync(this.file, { force: true }); }
  close(): void { this.values.clear(); this.key?.fill(0); this.key = null; }
  private persist(): void {
    if (!this.key || this.signInPending) return;
    try { this.writeSession(); }
    catch {
      this.key.fill(0); this.key = null;
      this.failed?.('storage-write-failed');
    }
  }
  private writeSession(): void {
    if (!this.key) return;
    const persisted = Object.fromEntries([...this.values].filter(([key]) => !key.endsWith('-code-verifier')));
    if (!Object.keys(persisted).length) return;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('mingle-account-session-v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(persisted)), cipher.final()]);
    writePrivateJson(this.file, { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
  }
}

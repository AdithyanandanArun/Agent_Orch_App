import { randomBytes } from 'node:crypto';
import type { AccountStorageState } from '@mingle/contracts';

export interface DesktopStorageResult { key: Buffer | null; storage: AccountStorageState }
export interface DesktopStorageChannel {
  send(message: { type: 'mingle.account-key.request'; requestId: string }, failed: () => void): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onDisconnect(listener: () => void): () => void;
}
const unavailable = (): DesktopStorageResult => ({ key: null, storage: { status: 'unavailable', backend: null, reason: 'ipc-unavailable', retryable: true } });
const reasons = new Set(['no-keyring', 'keyring-unavailable', 'key-unreadable', 'storage-write-failed', 'ipc-unavailable']);

function processChannel(): DesktopStorageChannel | null {
  const enabled = process.env.MINGLE_ACCOUNT_IPC === '1' && Boolean(process.channel);
  delete process.env.MINGLE_ACCOUNT_IPC;
  if (!enabled) return null;
  return {
    send(message, failed) {
      if (!process.connected || !process.send) return failed();
      try { process.send(message, (error) => { if (error) failed(); }); } catch { failed(); }
    },
    onMessage(listener) { process.on('message', listener); return () => process.off('message', listener); },
    onDisconnect(listener) { process.on('disconnect', listener); return () => process.off('disconnect', listener); },
  };
}

/** Only the Electron parent can supply a key. No credential transport reaches HTTP or the renderer. */
export class DesktopAccountStorage {
  private pending = new Set<() => void>();
  private closed = false;
  constructor(private readonly channel = processChannel(), private readonly timeoutMs = 5000) {}
  request(): Promise<DesktopStorageResult> {
    if (this.closed) return Promise.resolve(unavailable());
    if (!this.channel) return Promise.resolve({ key: null, storage: { status: 'unavailable', backend: null, reason: 'web-runtime', retryable: false } });
    const channel = this.channel;
    return new Promise((resolve) => {
      const requestId = randomBytes(16).toString('hex');
      let settled = false;
      let removeMessage = () => {};
      let removeDisconnect = () => {};
      const finish = (result: DesktopStorageResult) => {
        if (settled) { result.key?.fill(0); return; }
        settled = true;
        clearTimeout(timer);
        removeMessage(); removeDisconnect(); this.pending.delete(cancel);
        resolve(result);
      };
      const cancel = () => finish(unavailable());
      const timer = setTimeout(cancel, this.timeoutMs);
      this.pending.add(cancel);
      removeMessage = channel.onMessage((message) => {
        if (!message || typeof message !== 'object') return;
        const value = message as Record<string, unknown>;
        if (value.type !== 'mingle.account-key' || value.requestId !== requestId) return;
        const info = value.storage;
        if (!info || typeof info !== 'object') return cancel();
        const storage = info as Record<string, unknown>;
        const backend = storage.backend === null ? null : typeof storage.backend === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(storage.backend) ? storage.backend : undefined;
        if (backend === undefined || typeof storage.retryable !== 'boolean') return cancel();
        if (storage.status === 'available' && storage.reason === null && backend !== 'basic_text' && backend !== 'unknown' &&
          typeof value.key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value.key)) {
          const key = Buffer.from(value.key, 'base64');
          if (key.length !== 32 || key.toString('base64') !== value.key) { key.fill(0); return cancel(); }
          return finish({ key, storage: { status: 'available', backend, reason: null, retryable: false } });
        }
        if (storage.status === 'unavailable' && value.key === null && typeof storage.reason === 'string' && reasons.has(storage.reason)) {
          return finish({ key: null, storage: { status: 'unavailable', backend, reason: storage.reason as AccountStorageState['reason'], retryable: storage.retryable } });
        }
        cancel();
      });
      removeDisconnect = channel.onDisconnect(cancel);
      try { channel.send({ type: 'mingle.account-key.request', requestId }, cancel); } catch { cancel(); }
    });
  }
  close(): void { this.closed = true; for (const cancel of [...this.pending]) cancel(); }
}

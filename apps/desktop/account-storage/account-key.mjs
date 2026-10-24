import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const SECURE_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const REPORTED_BACKENDS = new Set(['basic_text', 'unknown', ...SECURE_LINUX_BACKENDS]);
export const MAX_WRAPPED_ACCOUNT_KEY_BYTES = 64 * 1024;

export function isCanonicalAccountKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

/** Returns the established per-workspace wrapped-key path without touching disk. */
export function accountKeyFilePath(userData, workspaceDataDir, hash = createHash) {
  const scope = hash('sha256').update(workspaceDataDir).digest('hex').slice(0, 16);
  return join(userData, `account-key-${scope}.enc`);
}

function status(backend, reason, retryable) {
  return {
    key: null,
    storage: { status: 'unavailable', backend, reason, retryable },
  };
}

function available(key, backend) {
  return {
    key,
    storage: { status: 'available', backend, reason: null, retryable: false },
  };
}

function safeBackend(safeStorage, platform) {
  if (platform !== 'linux') return null;
  try {
    const selected = safeStorage.getSelectedStorageBackend();
    return typeof selected === 'string' && REPORTED_BACKENDS.has(selected) ? selected : null;
  } catch {
    return null;
  }
}

function readWrappedAccountKey(fileSystem, keyFile, platform) {
  const pathStats = fileSystem.lstatSync(keyFile);
  if (!pathStats.isFile() || pathStats.size > MAX_WRAPPED_ACCOUNT_KEY_BYTES) return null;

  const posixFlags = platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const descriptor = fileSystem.openSync(keyFile, fsConstants.O_RDONLY | posixFlags);
  try {
    const descriptorStats = fileSystem.fstatSync(descriptor);
    if (!descriptorStats.isFile() || descriptorStats.size > MAX_WRAPPED_ACCOUNT_KEY_BYTES) return null;
    if (pathStats.dev !== descriptorStats.dev || pathStats.ino !== descriptorStats.ino) return null;

    // The descriptor read is capped even if another writer grows the file after fstat.
    const buffer = Buffer.allocUnsafe(MAX_WRAPPED_ACCOUNT_KEY_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fileSystem.readSync(
        descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_WRAPPED_ACCOUNT_KEY_BYTES) return null;
    return buffer.subarray(0, bytesRead);
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

/**
 * Loads or creates the Electron-wrapped 256-bit account key. All failures return
 * bounded diagnostics; existing wrapped bytes are never removed or replaced on
 * an unavailable keyring or a failed/invalid decryption.
 */
export function createAccountKeyManager({
  userData,
  workspaceDataDir,
  safeStorage,
  platform = process.platform,
  fileSystem = {
    closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync,
  },
  random = randomBytes,
}) {
  const keyFile = accountKeyFilePath(userData, workspaceDataDir);
  let cached = null;

  return function getAccountKey() {
    if (cached !== null) {
      const backend = safeBackend(safeStorage, platform);
      return available(cached, backend);
    }

    const backend = safeBackend(safeStorage, platform);
    if (platform === 'linux' && !SECURE_LINUX_BACKENDS.has(backend)) {
      return status(backend, 'no-keyring', false);
    }

    let encryptionAvailable = false;
    try { encryptionAvailable = safeStorage.isEncryptionAvailable(); }
    catch { /* An unavailable native key provider is reported below. */ }
    if (!encryptionAvailable) return status(backend, 'keyring-unavailable', true);

    let existing;
    try { existing = fileSystem.existsSync(keyFile); }
    catch { return status(backend, 'key-unreadable', true); }

    if (existing) {
      let wrapped;
      try { wrapped = readWrappedAccountKey(fileSystem, keyFile, platform); }
      catch { return status(backend, 'key-unreadable', true); }
      if (wrapped === null) return status(backend, 'key-unreadable', false);
      let key;
      try { key = safeStorage.decryptString(wrapped); }
      catch { return status(backend, 'key-unreadable', true); }
      if (!isCanonicalAccountKey(key)) return status(backend, 'key-unreadable', false);
      cached = key;
      return available(cached, backend);
    }

    const key = random(32).toString('base64');
    if (!isCanonicalAccountKey(key)) return status(backend, 'keyring-unavailable', true);

    let wrapped;
    try {
      wrapped = safeStorage.encryptString(key);
      if (!Buffer.isBuffer(wrapped) || wrapped.length === 0) return status(backend, 'keyring-unavailable', true);
    } catch {
      return status(backend, 'keyring-unavailable', true);
    }

    const temporaryFile = `${keyFile}.${random(16).toString('hex')}.tmp`;
    try {
      fileSystem.mkdirSync(userData, { recursive: true, mode: 0o700 });
      fileSystem.writeFileSync(temporaryFile, wrapped, { mode: 0o600, flag: 'wx' });
      fileSystem.renameSync(temporaryFile, keyFile);
    } catch {
      return status(backend, 'storage-write-failed', true);
    } finally {
      try { fileSystem.rmSync(temporaryFile, { force: true }); }
      catch { /* The random temporary name is never reused; diagnostics stay bounded. */ }
    }

    cached = key;
    return available(cached, backend);
  };
}

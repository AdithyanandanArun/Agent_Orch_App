import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountKeyFilePath, createAccountKeyManager, isCanonicalAccountKey } from './account-key.mjs';

function createFixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'mingle-account-key-test-'));
  const userData = join(root, 'user-data');
  const workspaceDataDir = join(root, 'workspace-data');
  const scope = createHash('sha256').update(workspaceDataDir).digest('hex').slice(0, 16);
  return { root, userData, workspaceDataDir, keyFile: join(userData, `account-key-${scope}.enc`) };
}

function secureStorage({ backend = 'gnome_libsecret', encryptionAvailable = true, decrypt } = {}) {
  return {
    getSelectedStorageBackend: () => backend,
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: value => Buffer.from(`wrapped:${value}`, 'utf8'),
    decryptString: bytes => decrypt ? decrypt(bytes) : bytes.toString('utf8').slice('wrapped:'.length),
  };
}

function manager(fixture, options = {}) {
  return createAccountKeyManager({
    userData: fixture.userData,
    workspaceDataDir: fixture.workspaceDataDir,
    safeStorage: options.safeStorage ?? secureStorage(),
    platform: options.platform ?? 'linux',
    fileSystem: options.fileSystem,
  });
}

function temporaryFiles(directory) {
  return fs.readdirSync(directory).filter(name => name.endsWith('.tmp'));
}

test('creates a private scoped key and loads the identical key on a later launch', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const first = manager(fixture)();

  assert.equal(first.storage.status, 'available');
  assert.equal(first.storage.backend, 'gnome_libsecret');
  assert.equal(first.storage.reason, null);
  assert.equal(isCanonicalAccountKey(first.key), true);
  assert.equal(fs.existsSync(fixture.keyFile), true);
  assert.equal(fs.statSync(fixture.keyFile).mode & 0o777, 0o600);
  assert.deepEqual(temporaryFiles(fixture.userData), []);

  const wrapped = fs.readFileSync(fixture.keyFile);
  const second = manager(fixture)();
  assert.deepEqual(second, first);
  assert.deepEqual(fs.readFileSync(fixture.keyFile), wrapped);
});

test('exposes the established wrapped-key path without touching it', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(accountKeyFilePath(fixture.userData, fixture.workspaceDataDir), fixture.keyFile);
  assert.equal(fs.existsSync(fixture.userData), false);
});

test('refuses basic_text instead of persisting a key with Electron plaintext encryption', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const unsafe = secureStorage({ backend: 'basic_text' });
  unsafe.encryptString = () => assert.fail('must not encrypt with basic_text');

  const result = manager(fixture, { safeStorage: unsafe })();
  assert.deepEqual(result, {
    key: null,
    storage: { status: 'unavailable', backend: 'basic_text', reason: 'no-keyring', retryable: false },
  });
  assert.equal(fs.existsSync(fixture.userData), false);
});

test('leaves the existing wrapped key untouched while the keyring is unavailable', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const original = manager(fixture)();
  const wrappedBefore = fs.readFileSync(fixture.keyFile);
  const locked = manager(fixture, { safeStorage: secureStorage({ encryptionAvailable: false }) })();

  assert.equal(locked.key, null);
  assert.equal(locked.storage.reason, 'keyring-unavailable');
  assert.equal(locked.storage.retryable, true);
  assert.deepEqual(fs.readFileSync(fixture.keyFile), wrappedBefore);
  assert.equal(manager(fixture)().key, original.key);
});

test('preserves existing bytes after wrapped-key decryption fails', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  manager(fixture)();
  const wrappedBefore = fs.readFileSync(fixture.keyFile);
  const failing = secureStorage({ decrypt: () => { throw new Error('sensitive native failure'); } });
  const result = manager(fixture, { safeStorage: failing })();

  assert.equal(result.key, null);
  assert.equal(result.storage.reason, 'key-unreadable');
  assert.equal(result.storage.retryable, false);
  assert.deepEqual(fs.readFileSync(fixture.keyFile), wrappedBefore);
  assert.deepEqual(temporaryFiles(fixture.userData), []);
});

test('preserves wrapped bytes if decryption returns a noncanonical key', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  manager(fixture)();
  const wrappedBefore = fs.readFileSync(fixture.keyFile);
  const corrupt = secureStorage({ decrypt: () => 'not-a-canonical-account-key' });
  const result = manager(fixture, { safeStorage: corrupt })();

  assert.equal(result.key, null);
  assert.equal(result.storage.reason, 'key-unreadable');
  assert.deepEqual(fs.readFileSync(fixture.keyFile), wrappedBefore);
  assert.deepEqual(temporaryFiles(fixture.userData), []);
});

test('reports write failures and removes the unpredictable temporary file', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const fileSystem = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    readFileSync: fs.readFileSync,
    renameSync: fs.renameSync,
    rmSync: fs.rmSync,
    writeFileSync: () => { throw new Error('private filesystem failure'); },
  };
  const result = manager(fixture, { fileSystem })();

  assert.equal(result.key, null);
  assert.equal(result.storage.status, 'unavailable');
  assert.equal(result.storage.reason, 'storage-write-failed');
  assert.equal(result.storage.retryable, true);
  assert.equal(fs.existsSync(fixture.keyFile), false);
  assert.deepEqual(temporaryFiles(fixture.userData), []);
});

test('reports an unavailable secure provider on non-Linux without changing platform behavior', t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const unavailable = secureStorage({ backend: null, encryptionAvailable: false });
  const result = manager(fixture, { platform: 'win32', safeStorage: unavailable })();

  assert.equal(result.storage.reason, 'keyring-unavailable');
  assert.equal(result.storage.backend, null);
  assert.equal(fs.existsSync(fixture.userData), false);
});

test('requires a canonical base64 encoding of exactly 32 bytes', () => {
  const canonical = Buffer.alloc(32, 7).toString('base64');
  assert.equal(isCanonicalAccountKey(canonical), true);
  assert.equal(isCanonicalAccountKey(Buffer.alloc(31).toString('base64')), false);
  assert.equal(isCanonicalAccountKey(`${canonical}=`), false);
  assert.equal(isCanonicalAccountKey(canonical.replace(/=$/, '')), false);
});

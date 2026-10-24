import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_KEY_IPC_COMPLETED_HISTORY_LIMIT,
  ACCOUNT_KEY_IPC_QUEUE_LIMIT,
  createAccountKeyIpcHandler,
  isAccountKeyRequest,
} from './account-key-ipc.mjs';

const requestId = '0123456789abcdef0123456789abcdef';
const accountKey = Buffer.alloc(32, 11).toString('base64');

test('accepts only correctly shaped account-key requests', () => {
  assert.equal(isAccountKeyRequest({ type: 'mingle.account-key.request', requestId }), true);
  assert.equal(isAccountKeyRequest({ type: 'mingle.account-key.request', requestId: requestId.toUpperCase() }), false);
  assert.equal(isAccountKeyRequest({ type: 'mingle.account-key.request', requestId: 'short' }), false);
  assert.equal(isAccountKeyRequest({ type: 'other', requestId }), false);
});

test('ignores malformed requests and responds once to a duplicate valid id', async () => {
  let calls = 0;
  const sent = [];
  const handle = createAccountKeyIpcHandler({
    getAccountKey: () => {
      calls++;
      return { key: accountKey, storage: { status: 'available', backend: 'kwallet6', reason: null, retryable: false } };
    },
    send: message => { sent.push(message); },
  });

  assert.equal(handle({ type: 'mingle.account-key.request', requestId: 'bad' }), false);
  assert.equal(handle({ type: 'mingle.account-key.request', requestId }), true);
  assert.equal(handle({ type: 'mingle.account-key.request', requestId }), false);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls, 1);
  assert.deepEqual(sent, [{
    type: 'mingle.account-key', requestId, key: accountKey,
    storage: { status: 'available', backend: 'kwallet6', reason: null, retryable: false },
  }]);
});

test('serializes keyring operations and returns bounded unavailable diagnostics', async () => {
  const order = [];
  let releaseFirst;
  const firstSend = new Promise(resolve => { releaseFirst = resolve; });
  const handle = createAccountKeyIpcHandler({
    getAccountKey: () => {
      order.push('get');
      if (order.length === 1) return { key: accountKey, storage: { status: 'available', backend: 'gnome_libsecret', reason: null, retryable: false } };
      throw new Error('must not leave this error in diagnostics');
    },
    send: async message => {
      order.push(`send:${message.requestId}`);
      if (message.requestId === requestId) await firstSend;
    },
  });
  const secondId = 'fedcba9876543210fedcba9876543210';

  handle({ type: 'mingle.account-key.request', requestId });
  handle({ type: 'mingle.account-key.request', requestId: secondId });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['get', `send:${requestId}`]);

  releaseFirst();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['get', `send:${requestId}`, 'get', `send:${secondId}`]);
});

test('does not return a malformed key even if the storage provider reports available', async () => {
  const sent = [];
  const handle = createAccountKeyIpcHandler({
    getAccountKey: () => ({ key: 'not-a-key', storage: { status: 'available', backend: null, reason: null, retryable: false } }),
    send: message => { sent.push(message); },
  });

  handle({ type: 'mingle.account-key.request', requestId });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [{
    type: 'mingle.account-key', requestId, key: null,
    storage: { status: 'unavailable', backend: null, reason: 'keyring-unavailable', retryable: false },
  }]);
});

test('bounds queued work and responds with a sanitized retryable failure on overflow', async () => {
  const firstId = requestId;
  const queuedIds = Array.from({ length: ACCOUNT_KEY_IPC_QUEUE_LIMIT }, (_, index) => (index + 1).toString(16).padStart(32, '0'));
  const overflowId = 'fffffffffffffffffffffffffffffffe';
  const sent = [];
  let getCount = 0;
  let releaseFirst;
  const firstSend = new Promise(resolve => { releaseFirst = resolve; });
  const handle = createAccountKeyIpcHandler({
    getAccountKey: () => {
      getCount++;
      return { key: accountKey, storage: { status: 'available', backend: 'kwallet6', reason: null, retryable: false } };
    },
    send: async message => {
      sent.push(message);
      if (message.requestId === firstId) await firstSend;
    },
  });

  assert.equal(handle({ type: 'mingle.account-key.request', requestId: firstId }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getCount, 1);

  for (const id of queuedIds) assert.equal(handle({ type: 'mingle.account-key.request', requestId: id }), true);
  assert.equal(handle({ type: 'mingle.account-key.request', requestId: firstId }), false);
  assert.equal(handle({ type: 'mingle.account-key.request', requestId: queuedIds[0] }), false);
  assert.equal(handle({ type: 'mingle.account-key.request', requestId: overflowId }), true);
  assert.equal(handle({ type: 'mingle.account-key.request', requestId: overflowId }), false);

  const overflow = sent.find(message => message.requestId === overflowId);
  assert.deepEqual(overflow, {
    type: 'mingle.account-key', requestId: overflowId, key: null,
    storage: { status: 'unavailable', backend: null, reason: 'ipc-unavailable', retryable: true },
  });
  assert.equal(getCount, 1, 'overflow does not enter keyring work');

  releaseFirst();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getCount, 1 + ACCOUNT_KEY_IPC_QUEUE_LIMIT);
  assert.equal(sent.length, 2 + ACCOUNT_KEY_IPC_QUEUE_LIMIT);
});

test('bounds completed-ID history while suppressing recent late duplicates', async () => {
  const sent = [];
  let resolveResponse;
  const handle = createAccountKeyIpcHandler({
    getAccountKey: () => ({ key: accountKey, storage: { status: 'available', backend: null, reason: null, retryable: false } }),
    send: message => {
      sent.push(message);
      resolveResponse?.(message);
    },
  });
  const idFor = index => index.toString(16).padStart(32, '0');

  for (let index = 0; index < ACCOUNT_KEY_IPC_COMPLETED_HISTORY_LIMIT + 2; index++) {
    const response = new Promise(resolve => { resolveResponse = resolve; });
    const id = idFor(index);
    assert.equal(handle({ type: 'mingle.account-key.request', requestId: id }), true);
    assert.equal((await response).requestId, id);
    resolveResponse = null;
    await new Promise(resolve => setImmediate(resolve));
  }

  const recentId = idFor(ACCOUNT_KEY_IPC_COMPLETED_HISTORY_LIMIT + 1);
  assert.equal(handle({ type: 'mingle.account-key.request', requestId: recentId }), false);

  const evictedId = idFor(0);
  const retryResponse = new Promise(resolve => { resolveResponse = resolve; });
  assert.equal(handle({ type: 'mingle.account-key.request', requestId: evictedId }), true);
  assert.equal((await retryResponse).requestId, evictedId);
  assert.equal(sent.length, ACCOUNT_KEY_IPC_COMPLETED_HISTORY_LIMIT + 3);
});

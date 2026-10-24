import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountKeyIpcHandler, isAccountKeyRequest } from './account-key-ipc.mjs';

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

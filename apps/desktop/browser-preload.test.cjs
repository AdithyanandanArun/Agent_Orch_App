const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const preloadSource = readFileSync(join(__dirname, 'browser-preload.cjs'), 'utf8');

function loadPreload() {
  const ipcListeners = new Map();
  const exposed = new Map();
  const ipcRenderer = {
    on(channel, listener) { ipcListeners.set(channel, listener); },
    invoke() { return Promise.resolve(false); },
  };
  const contextBridge = { exposeInMainWorld(name, value) { exposed.set(name, value); } };
  vm.runInNewContext(preloadSource, {
    Buffer,
    require: name => name === 'electron' ? { contextBridge, ipcRenderer } : assert.fail(`Unexpected import: ${name}`),
  }, { filename: 'browser-preload.cjs' });
  return {
    exposed,
    emit: (token) => ipcListeners.get('mingle.project-invitation')({}, token),
  };
}

test('preload queues canonical invitations until subscribe, ignores invalid payloads, and unsubscribes', () => {
  const { exposed, emit } = loadPreload();
  const api = exposed.get('mingleProjectInvitations');
  assert.deepEqual([...Object.keys(api)], ['onInvitation']);
  assert.equal('ipcRenderer' in api, false);

  const firstToken = 'A'.repeat(32);
  emit(firstToken);
  emit(firstToken); // A duplicate is coalesced while no UI listener exists.
  emit('not-an-invitation-token');
  emit('A'.repeat(33)); // Invalid base64url length.
  emit(null);

  const received = [];
  const unsubscribe = api.onInvitation(value => received.push(value));
  assert.deepEqual(received, [firstToken]);
  const liveToken = 'B'.repeat(32);
  emit(liveToken);
  assert.deepEqual(received, [firstToken, liveToken]);

  unsubscribe();
  const queuedAfterUnsubscribe = 'C'.repeat(32);
  emit(queuedAfterUnsubscribe);
  const laterReceived = [];
  api.onInvitation(value => laterReceived.push(value));
  assert.deepEqual(laterReceived, [queuedAfterUnsubscribe]);
});

test('preload invitation queue is bounded to unique pending tokens', () => {
  const { exposed, emit } = loadPreload();
  const api = exposed.get('mingleProjectInvitations');
  const expected = Array.from({ length: 16 }, (_, index) => Buffer.alloc(24, index).toString('base64url'));
  for (const token of expected) emit(token);
  for (let count = 0; count < 100; count++) emit(expected[0]);
  emit(Buffer.alloc(24, 99).toString('base64url'));

  const received = [];
  api.onInvitation(token => received.push(token));
  assert.deepEqual(received, expected);
});

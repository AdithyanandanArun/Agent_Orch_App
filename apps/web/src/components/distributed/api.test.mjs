import test from 'node:test';
import assert from 'node:assert/strict';
import { distributedApi } from './api.ts';

test('distributed snapshot is read through the local API and encodes team IDs', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ teams: [], transport: {}, execution: {}, git: {}, commands: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const snapshot = await distributedApi.snapshot('team/with space');
    assert.equal(captured.url, '/api/distributed/snapshot?teamId=team%2Fwith%20space');
    assert.equal(captured.init.method, 'GET');
    assert.deepEqual(snapshot.teams, []);
  } finally { globalThis.fetch = originalFetch; }
});

test('approval decisions use their scoped route and JSON decision body', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const expectedDigest = 'a'.repeat(64);
    await distributedApi.decideGit('request/42', { decision: 'approved', expectedDigest });
    assert.equal(captured.url, '/api/distributed/git/request%2F42/decision');
    assert.equal(captured.init.method, 'POST');
    assert.deepEqual(JSON.parse(captured.init.body), { decision: 'approved', expectedDigest });
  } finally { globalThis.fetch = originalFetch; }
});

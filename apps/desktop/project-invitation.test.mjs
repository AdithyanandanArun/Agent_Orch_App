import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProjectInvitationDispatcher,
  createProjectInvitationUrl,
  MAX_PENDING_PROJECT_INVITATIONS,
  parseProjectInvitationUrl,
} from './project-invitation.mjs';

const token = 'A'.repeat(32);
const invitation = value => `mingle://join?token=${value}`;

test('accepts canonical base64url invitation links at both token-length bounds', () => {
  assert.equal(parseProjectInvitationUrl(invitation(token)), token);
  assert.equal(parseProjectInvitationUrl(invitation('A'.repeat(512))), 'A'.repeat(512));
});

test('rejects malformed links, authorities, paths, duplicate/extra parameters, and controls', () => {
  const invalid = [
    `https://join?token=${token}`,
    `MINGLE://join?token=${token}`,
    `mingle://other?token=${token}`,
    `mingle://user@join?token=${token}`,
    `mingle://join:443?token=${token}`,
    `mingle://join/../join?token=${token}`,
    `mingle://join/path?token=${token}`,
    `mingle://join?token=${token}&next=elsewhere`,
    `mingle://join?token=${token}&token=${token}`,
    `mingle://join?token=%41${'A'.repeat(31)}`,
    `mingle://join?token=${token}#fragment`,
    `mingle://join?token=${token}\n`,
    `mingle://join?token=${token}\u2028`,
    invitation('A'.repeat(31)),
    invitation('A'.repeat(513)),
    invitation('A'.repeat(33)), // Base64url lengths congruent to 1 mod 4 are invalid.
    invitation(`${'A'.repeat(31)}!`),
  ];
  for (const value of invalid) assert.equal(parseProjectInvitationUrl(value), null, value.replace(token, '<token>'));
  assert.equal(parseProjectInvitationUrl(null), null);
  assert.equal(parseProjectInvitationUrl(`mingle://join?token=${token}\u0000`), null);
});

test('builds the UI handoff only on Mingle’s local loopback origin', () => {
  assert.equal(createProjectInvitationUrl('http://127.0.0.1:4310', token), `http://127.0.0.1:4310/?join=${encodeURIComponent(token)}`);
  assert.equal(createProjectInvitationUrl('https://example.com', token), null);
  assert.equal(createProjectInvitationUrl('http://localhost:4310', token), null);
  assert.equal(createProjectInvitationUrl('http://user@127.0.0.1:4310', token), null);
});

test('holds links until the workspace is ready and navigates queued links serially', async () => {
  const window = {};
  let windowReady = false;
  let focused = 0;
  const navigations = [];
  const completeNavigation = [];
  const dispatcher = createProjectInvitationDispatcher({
    getWorkspaceUrl: () => 'http://127.0.0.1:4310',
    getWindow: () => windowReady ? window : null,
    focusWindow: () => { focused++; },
    navigate: (_window, url) => {
      navigations.push(url);
      return new Promise(resolve => completeNavigation.push(resolve));
    },
  });

  assert.equal(dispatcher.accept(invitation(token)), true);
  assert.equal(dispatcher.accept(invitation('B'.repeat(32))), true);
  assert.equal(navigations.length, 0);
  assert.equal(focused, 0);
  assert.equal(dispatcher.getPendingCount(), 2);

  windowReady = true;
  dispatcher.markWorkspaceReady();
  assert.deepEqual(navigations, [`http://127.0.0.1:4310/?join=${token}`]);
  assert.equal(focused, 1);

  completeNavigation.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(navigations, [
    `http://127.0.0.1:4310/?join=${token}`,
    `http://127.0.0.1:4310/?join=${'B'.repeat(32)}`,
  ]);
  completeNavigation.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatcher.getPendingCount(), 0);
});

test('rejects invalid links and bounds queued dispatch without native handler mutation', () => {
  const dispatcher = createProjectInvitationDispatcher({
    getWorkspaceUrl: () => null,
    getWindow: () => null,
    focusWindow: () => assert.fail('No window should be focused'),
    navigate: () => assert.fail('No navigation should start before a workspace is ready'),
  });
  assert.equal(dispatcher.accept('https://example.com'), false);
  for (let index = 0; index < MAX_PENDING_PROJECT_INVITATIONS; index++) {
    assert.equal(dispatcher.accept(invitation(token)), true);
  }
  assert.equal(dispatcher.accept(invitation(token)), false);
  assert.equal(dispatcher.getPendingCount(), MAX_PENDING_PROJECT_INVITATIONS);
});

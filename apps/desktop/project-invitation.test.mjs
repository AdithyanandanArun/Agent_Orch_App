import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProjectInvitationDispatcher,
  createProjectInvitationUrl,
  isProjectInvitationWorkspaceUrl,
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

test('allows IPC only for the exact local workspace origin', () => {
  const workspaceUrl = 'http://127.0.0.1:4310';
  assert.equal(isProjectInvitationWorkspaceUrl('http://127.0.0.1:4310/?join=secret', workspaceUrl), true);
  assert.equal(isProjectInvitationWorkspaceUrl('http://user@127.0.0.1:4310/', workspaceUrl), false);
  assert.equal(isProjectInvitationWorkspaceUrl('http://127.0.0.1:4311/', workspaceUrl), false);
  assert.equal(isProjectInvitationWorkspaceUrl('https://127.0.0.1:4310/', workspaceUrl), false);
  assert.equal(isProjectInvitationWorkspaceUrl('file:///tmp/index.html', workspaceUrl), false);
});

test('uses the first queued link for cold startup and sends warm links without reloading', () => {
  const sent = [];
  const window = { webContents: { send: (_channel, value) => sent.push(value) } };
  let windowReady = false;
  let focused = 0;
  const loadedUrls = [];
  window.loadURL = url => loadedUrls.push(url);
  const dispatcher = createProjectInvitationDispatcher({
    getWorkspaceUrl: () => 'http://127.0.0.1:4310',
    getWindow: () => windowReady ? window : null,
    focusWindow: () => { focused++; },
    sendInvitation: (_window, value) => window.webContents.send('mingle.project-invitation', value),
  });

  assert.equal(dispatcher.accept(invitation(token)), true);
  assert.equal(dispatcher.accept(invitation('B'.repeat(32))), true);
  assert.equal(dispatcher.accept(invitation('B'.repeat(32))), true);
  assert.equal(sent.length, 0);
  assert.equal(focused, 0);
  assert.equal(dispatcher.getPendingCount(), 2);

  const coldStartUrl = dispatcher.getStartupUrl();
  assert.equal(coldStartUrl, `http://127.0.0.1:4310/?join=${token}`);
  windowReady = true;
  window.loadURL(coldStartUrl); // The one initial cold-start navigation.
  dispatcher.markWorkspaceReady();
  assert.deepEqual(sent, ['B'.repeat(32)]);
  assert.equal(focused, 1);

  assert.equal(dispatcher.accept(invitation('C'.repeat(32))), true);
  assert.deepEqual(sent, ['B'.repeat(32), 'C'.repeat(32)]);
  assert.equal(loadedUrls.length, 1);
  assert.equal(dispatcher.getPendingCount(), 0);
});

test('rejects invalid links and bounds queued dispatch without native handler mutation', () => {
  const dispatcher = createProjectInvitationDispatcher({
    getWorkspaceUrl: () => null,
    getWindow: () => null,
    focusWindow: () => assert.fail('No window should be focused'),
    sendInvitation: () => assert.fail('No invitation should dispatch before a workspace is ready'),
  });
  assert.equal(dispatcher.accept('https://example.com'), false);
  const distinctTokens = Array.from({ length: MAX_PENDING_PROJECT_INVITATIONS + 1 }, (_, index) => Buffer.alloc(24, index).toString('base64url'));
  for (let index = 0; index < MAX_PENDING_PROJECT_INVITATIONS; index++) {
    assert.equal(dispatcher.accept(invitation(distinctTokens[index])), true);
  }
  for (let count = 0; count < 100; count++) assert.equal(dispatcher.accept(invitation(distinctTokens[0])), true);
  assert.equal(dispatcher.accept(invitation(distinctTokens[MAX_PENDING_PROJECT_INVITATIONS])), false);
  assert.equal(dispatcher.getPendingCount(), MAX_PENDING_PROJECT_INVITATIONS);
});

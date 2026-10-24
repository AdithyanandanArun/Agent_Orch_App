import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendGmailInvitation } from './gmail-smtp.ts';

const input = { user: 'sender@gmail.com', password: 'abcdefghijklmnop', to: 'teammate@example.test', subject: 'Join your Mingle project', text: 'A project invitation\n.hello', html: '<p>A project invitation</p>', messageId: 'invitation-123' };

function fixture({ auth = 235, accepted = 250, fragment = 7, partialWrite = 13 } = {}) {
  const replies = ['220 smtp.gmail.com ready\r\n', '250-smtp.gmail.com\r\n250-AUTH LOGIN PLAIN XOAUTH2\r\n250 SIZE 35882577\r\n', `${auth} auth\r\n`, '250 sender\r\n', '250 recipient\r\n', '354 go\r\n', `${accepted} accepted\r\n`];
  let pending = new TextEncoder().encode(replies.join(''));
  let sent = '';
  let closed = false;
  return {
    get sent() { return sent; }, get closed() { return closed; },
    connect: async () => ({
      async read(buffer) { if (!pending.length) return null; const count = Math.min(fragment, buffer.length, pending.length); buffer.set(pending.subarray(0, count)); pending = pending.subarray(count); return count; },
      async write(buffer) { const count = Math.min(partialWrite, buffer.length); sent += new TextDecoder().decode(buffer.subarray(0, count)); return count; },
      close() { closed = true; },
    }),
  };
}

test('submits through bounded fragmented replies and partial writes, with MIME alternatives', async () => {
  const smtp = fixture();
  await sendGmailInvitation(input, smtp);
  assert.equal(smtp.closed, true);
  assert.match(smtp.sent, /^EHLO mingle.local\r\nAUTH PLAIN /);
  assert.match(smtp.sent, /MAIL FROM:<sender@gmail.com>\r\nRCPT TO:<teammate@example.test>\r\nDATA\r\n/);
  assert.match(smtp.sent, /multipart\/alternative/);
  assert.match(smtp.sent, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(smtp.sent, new RegExp(Buffer.from(input.text).toString('base64')));
  assert.ok(smtp.sent.endsWith('\r\n.\r\n'));
  assert.ok(!smtp.sent.includes(input.password));
});

test('bad Gmail authentication and rejected DATA never report sent or expose secrets', async () => {
  for (const options of [{ auth: 535 }, { accepted: 550 }]) {
    const smtp = fixture(options);
    await assert.rejects(sendGmailInvitation(input, smtp), error => {
      assert.ok(!error.message.includes(input.password));
      assert.ok(!error.message.includes(input.user));
      return /Gmail invitation submission failed/.test(error.message);
    });
    assert.equal(smtp.closed, true);
  }
});

test('header/address injection, invalid credentials and oversized mail never connect', async () => {
  let connections = 0;
  for (const patch of [{ to: 'x@example.test\r\nBcc: victim@example.test' }, { subject: 'join\r\nBcc: x' }, { user: 'not-gmail@example.test' }, { messageId: 'x>\r\nBcc:x' }, { password: 'not-an-app-password' }, { html: 'a'.repeat(129 * 1024) }]) {
    await assert.rejects(sendGmailInvitation({ ...input, ...patch }, { connect: async () => { connections++; throw new Error('must not connect'); } }));
  }
  assert.equal(connections, 0);
});

test('hung connection times out and a late socket is immediately closed', async () => {
  let resolve;
  let closed = false;
  const connection = new Promise(done => { resolve = done; });
  await assert.rejects(sendGmailInvitation(input, { connect: () => connection, timeoutMs: 10 }), /failed during connection/);
  resolve({ close() { closed = true; } });
  await new Promise(done => setTimeout(done, 0));
  assert.equal(closed, true);
});

test('auth challenges are supported without a plaintext channel', async () => {
  const smtp = fixture();
  let first = true;
  const socket = await smtp.connect();
  // A single chunk contains the challenge plus success, modeling AUTH PLAIN with a challenge.
  const replies = new TextEncoder().encode('220 hello\r\n250-AUTH PLAIN\r\n250 end\r\n334 continue\r\n235 ok\r\n250 sender\r\n250 recipient\r\n354 data\r\n250 accepted\r\n');
  await sendGmailInvitation(input, { connect: async () => ({ ...socket, async read(buffer) { if (!first) return null; first = false; buffer.set(replies); return replies.length; } }) });
  assert.match(smtp.sent, /AUTH PLAIN [A-Za-z0-9+/=]+\r\n[A-Za-z0-9+/=]+\r\nMAIL FROM:/);
});


test('long Unicode subjects are encoded and folded without splitting characters', async () => {
  const smtp = fixture();
  const subject = 'Join your project ' + '🌱'.repeat(60);
  await sendGmailInvitation({ ...input, subject }, smtp);
  const words = [...smtp.sent.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)];
  assert.equal(words.map(word => Buffer.from(word[1], 'base64').toString('utf8')).join(''), subject);
  assert.ok(words.every(word => word[0].length <= 75));
});

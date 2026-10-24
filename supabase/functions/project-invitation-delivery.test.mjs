import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const token = 'A'.repeat(43);
const invitationId = '31000000-0000-4000-8000-000000000001';
const userId = '31000000-0000-4000-8000-000000000002';

// Execute the production handler with an explicit cloud/SMTP boundary fixture.
// Nothing connects to Supabase, Gmail, or a provider executable.
async function fixture(overrides = {}) {
  const state = {
    verified: true, owner: true, claim: true, sends: [], clients: [], claims: [],
    invitation: {
      id: invitationId, team_id: 'example-team', shared_project_id: 'example-project',
      email: 'teammate@example.test', role: 'member', invited_by: userId,
      token_hash: createHash('sha256').update(token).digest('hex'),
      expires_at: new Date(Date.now() + 60_000).toISOString(), accepted_at: null, revoked_at: null,
    },
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'example-publishable-key' }),
      SMTP_USER: 'example-sender@gmail.com', SMTP_PASSWORD: 'example-not-a-real-password',
      MINGLE_INVITE_FROM: 'Example invitations <example-sender@gmail.com>',
      MINGLE_INVITE_EMAIL_PROVIDER: 'smtp', MINGLE_INVITE_JOIN_URL: 'https://example.test/join/',
    },
    ...overrides,
  };
  let handler;
  const client = {
    auth: { async getUser() { return state.verified
      ? { data: { user: { id: userId, email: 'leader@example.test', email_confirmed_at: '2026-01-01', is_anonymous: false } }, error: null }
      : { data: { user: null }, error: { message: 'Example invalid account' } }; } },
    from(table) {
      const filters = {};
      const query = {
        select() { return query; }, eq(key, value) { filters[key] = value; return query; }, is() { return query; },
        async maybeSingle() {
          if (table === 'mingle_project_invitations') return { data: filters.id === state.invitation.id && filters.invited_by === state.invitation.invited_by ? state.invitation : null, error: null };
          if (table === 'mingle_members') return { data: state.owner ? { role: 'owner' } : null, error: null };
          if (table === 'mingle_projects') return { data: { name: 'Example <project>', repository_url: 'https://github.com/example/project.git' }, error: null };
          throw new Error('Unexpected example fixture query');
        },
      };
      return query;
    },
    async rpc(name, args) { state.claims.push({ name, args }); return { data: { claimed: state.claim, reason: 'owner_daily_limit' }, error: null }; },
  };
  const source = await readFile(new URL('./project-invitation-delivery/index.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source.replace(/^import .*;\r?\n/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
  }).outputText;
  vm.runInNewContext(compiled, {
    Request, Response, URL, TextEncoder, crypto: webcrypto, AbortSignal,
    createClient(...args) { state.clients.push(args); return client; },
    async sendGmailInvitation(input) {
      if (state.smtpFailure) throw new Error('Example private SMTP diagnostic must never escape');
      state.sends.push(input);
    },
    Deno: { env: { get: name => state.env[name] }, serve(callback) { handler = callback; } },
  });
  return {
    state,
    async request(body, authenticated = true) {
      const response = await handler(new Request('https://example.supabase.co/functions/v1/project-invitation-delivery', {
        method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer example-user-token' } : {}) }, body: JSON.stringify(body),
      }));
      return { status: response.status, body: await response.json() };
    },
  };
}

test('requires a freshly verified account and supports managed publishable keys', async () => {
  const f = await fixture();
  assert.equal((await f.request({ action: 'status' }, false)).status, 401);
  f.state.verified = false;
  assert.equal((await f.request({ action: 'status' })).status, 401);
  f.state.verified = true;
  assert.equal((await f.request({ action: 'status' })).body.configured, true);
  assert.equal(f.state.clients.at(-1)[1], 'example-publishable-key');
  delete f.state.env.MINGLE_INVITE_JOIN_URL;
  assert.equal((await f.request({ action: 'status' })).body.configured, false);
});

test('delivery binds recipient/template to the pending invitation and atomically claims before SMTP', async () => {
  const f = await fixture();
  const result = await f.request({ action: 'send', invitationId, token, email: 'attacker@example.test', html: 'ignored attacker template' });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'sent');
  assert.equal(f.state.claims.length, 1);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.sends[0].to, 'teammate@example.test');
  assert.match(f.state.sends[0].html, /Example &lt;project&gt;/);
  assert.match(f.state.sends[0].text, /https:\/\/example.test\/join\/#token=/);
  assert.equal(JSON.stringify(result.body).includes(token), false);
});

test('wrong token, owner, revoked/expired invitation and aggregate quota never send', async () => {
  for (const change of [
    f => { f.state.invitation.token_hash = '0'.repeat(64); },
    f => { f.state.invitation.invited_by = 'another-account'; },
    f => { f.state.owner = false; },
    f => { f.state.invitation.revoked_at = new Date().toISOString(); },
    f => { f.state.invitation.expires_at = new Date(0).toISOString(); },
    f => { f.state.claim = false; },
  ]) {
    const f = await fixture(); change(f);
    const result = await f.request({ action: 'send', invitationId, token });
    assert.ok(result.status >= 400);
    assert.equal(f.state.sends.length, 0);
  }
});

test('uncertain SMTP delivery returns a sanitized failure without credential or token disclosure', async () => {
  const f = await fixture({ smtpFailure: true });
  const result = await f.request({ action: 'send', invitationId, token });
  assert.equal(result.status, 502);
  assert.equal(result.body.status, 'failed');
  const serialized = JSON.stringify(result.body);
  for (const privateValue of [token, f.state.env.SMTP_PASSWORD, 'private SMTP diagnostic']) assert.equal(serialized.includes(privateValue), false);
});

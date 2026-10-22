import { it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
it('enforces real PostgreSQL team, invitation, device, relay and revocation policies', async () => {
const pg = new PGlite();
try {
let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; };
await pg.exec(`
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
`);
await pg.exec(readFileSync(process.env.MINGLE_TEST_TEAM_MIGRATION ?? new URL('../../../../supabase/migrations/20261022100932_mingle_teams.sql', import.meta.url), 'utf8'));
check(true, 'migration applies to PostgreSQL');
const ids = [
  '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
];
const emails = ['owner@example.test','member@example.test','admin-one@example.test','admin-two@example.test','outsider@example.test'];
for (let i=0;i<ids.length;i++) await pg.query('INSERT INTO auth.users VALUES ($1,$2,now())', [ids[i],emails[i]]);
async function user(i: number, fn: () => Promise<unknown>) {
  await pg.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[ids[i],JSON.stringify({sub:ids[i],email:emails[i]})]);
  await pg.exec('SET ROLE authenticated');
  try { return await fn(); } finally { await pg.exec('RESET ROLE'); }
}
let team = "";
await user(0, async () => {
  const r=await pg.query<{id:string}>('INSERT INTO mingle_teams(name,owner_id) VALUES ($1,$2) RETURNING id',['Fixture team',ids[0]]);
  team=r.rows[0]!.id as string;
  check(!!team,'owner can create a team and read RETURNING row');
  check((await pg.query('SELECT * FROM mingle_members WHERE team_id=$1',[team])).rows.length===1,'team owner membership created atomically');
});
await user(4,async()=>check((await pg.query('SELECT * FROM mingle_teams WHERE id=$1',[team])).rows.length===0,'outsider cannot read team'));
await pg.exec('SET ROLE anon');
try {
  await assert.rejects(pg.query('SELECT * FROM mingle_teams'));
  check(true, 'anonymous clients have no team-table grants');
} finally { await pg.exec('RESET ROLE'); }
const tokenHash='a'.repeat(64);
await user(0,async()=> {
  await pg.query("INSERT INTO mingle_invitations(team_id,email,role,token_hash,expires_at) VALUES ($1,$2,'member',$3,now()+interval '1 day')",[team,emails[1],tokenHash]);
  check(true,'owner can invite verified account email');
});
await user(4,async()=> {
  await assert.rejects(pg.query('SELECT accept_mingle_invitation($1)',[tokenHash]));
  check(true,'wrong verified account cannot accept invitation');
});
await user(1,async()=> {
  const r=await pg.query<{team:string}>('SELECT accept_mingle_invitation($1) AS team',[tokenHash]);
  check(r.rows[0]!.team===team,'invited verified account joins team');
  await assert.rejects(pg.query('SELECT accept_mingle_invitation($1)',[tokenHash]));
  check(true,'invitation cannot be replayed');
});
const expiredTokenHash='b'.repeat(64);
await user(0,async()=>await pg.query("INSERT INTO mingle_invitations(team_id,email,role,token_hash,expires_at) VALUES ($1,$2,'member',$3,now()+interval '25 milliseconds')",[team,emails[1],expiredTokenHash]));
await new Promise((resolve)=>setTimeout(resolve,60));
await user(1,async()=> {
  await assert.rejects(pg.query('SELECT accept_mingle_invitation($1)',[expiredTokenHash]));
  check(true,'expired invitation cannot be accepted');
});
const adminOneTokenHash='c'.repeat(64),adminTwoTokenHash='d'.repeat(64);
await user(0,async()=> {
  await pg.query("INSERT INTO mingle_invitations(team_id,email,role,token_hash,expires_at) VALUES ($1,$2,'admin',$3,now()+interval '1 day')",[team,emails[2],adminOneTokenHash]);
  await pg.query("INSERT INTO mingle_invitations(team_id,email,role,token_hash,expires_at) VALUES ($1,$2,'admin',$3,now()+interval '1 day')",[team,emails[3],adminTwoTokenHash]);
});
await user(2,async()=> {
  await pg.query('SELECT accept_mingle_invitation($1)',[adminOneTokenHash]);
  check((await pg.query<{role:string}>('SELECT role FROM mingle_members WHERE team_id=$1 AND user_id=$2',[team,ids[2]])).rows[0]?.role==='admin','owner-issued admin invitation grants admin role');
});
await user(3,async()=> {
  await pg.query('SELECT accept_mingle_invitation($1)',[adminTwoTokenHash]);
  check((await pg.query<{role:string}>('SELECT role FROM mingle_members WHERE team_id=$1 AND user_id=$2',[team,ids[3]])).rows[0]?.role==='admin','second verified invitee receives admin role');
});
await user(2,async()=> {
  const changed=await pg.query('UPDATE mingle_members SET revoked_at=now() WHERE team_id=$1 AND user_id=$2 RETURNING user_id',[team,ids[3]]);
  check(changed.rows.length===0,'admin cannot revoke another admin');
});
await user(0,async()=> {
  const row=await pg.query<{revoked_at:string|null}>('SELECT revoked_at FROM mingle_members WHERE team_id=$1 AND user_id=$2',[team,ids[3]]);
  check(row.rows[0]?.revoked_at===null,'denied admin revocation leaves membership active');
});
await user(1,async()=> {
  await assert.rejects(pg.query('UPDATE mingle_members SET role=$1 WHERE team_id=$2 AND user_id=$3',['owner',team,ids[1]]));
  check(true,'member cannot elevate role');
});
const a='20000000-0000-4000-8000-000000000001',b='20000000-0000-4000-8000-000000000002';
const fpA='SHA-256:'+'1'.repeat(64),fpB='SHA-256:'+'2'.repeat(64);
for (const [i,id,fp] of [[0,a,fpA],[1,b,fpB]] as const) await user(i,async()=> {
  await pg.query('INSERT INTO mingle_devices(id,team_id,owner_id,name,signing_public_key,encryption_public_key,fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7)',[id,team,ids[i],`Device ${i}`,'s'.repeat(80),'e'.repeat(80),fp]);
  check(true,'member registers own device');
});
await user(1, async () => {
  await assert.rejects(pg.query('INSERT INTO mingle_devices(id,team_id,owner_id,name,signing_public_key,encryption_public_key,fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    ['20000000-0000-4000-8000-000000000099',team,ids[0],'Impersonator','s'.repeat(80),'e'.repeat(80),fpB]));
  check(true, 'members cannot register devices owned by another account');
  await assert.rejects(pg.query('UPDATE mingle_devices SET signing_public_key=$1 WHERE id=$2', ['x'.repeat(80),b]));
  check(true, 'registered device public keys are immutable');
});
await user(0,async()=> {
  await assert.rejects(pg.query('INSERT INTO mingle_device_links(team_id,device_id,peer_device_id,peer_fingerprint) VALUES ($1,$2,$3,$4)',[team,a,b,fpA]));
  check(true,'wrong peer fingerprint cannot be pinned');
  await pg.query('INSERT INTO mingle_device_links(team_id,device_id,peer_device_id,peer_fingerprint) VALUES ($1,$2,$3,$4)',[team,a,b,fpB]);
  await assert.rejects(pg.query('INSERT INTO mingle_envelopes(team_id,from_device_id,to_device_id,idempotency_key,kind,ciphertext,nonce,signature,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now()+interval \'1 minute\')',
    [team,a,b,'one-sided','collaboration.message','encrypted','n'.repeat(24),'s'.repeat(88)]));
  check(true, 'one-sided device trust cannot deliver envelopes');
});
await user(1,async()=>await pg.query('INSERT INTO mingle_device_links(team_id,device_id,peer_device_id,peer_fingerprint) VALUES ($1,$2,$3,$4)',[team,b,a,fpA]));
const envelope='30000000-0000-4000-8000-000000000001',created=new Date(Date.now()-1000).toISOString(),expires=new Date(Date.now()+60_000).toISOString();
await user(0,async()=> {
  await pg.query('INSERT INTO mingle_envelopes(id,team_id,from_device_id,to_device_id,idempotency_key,kind,ciphertext,nonce,signature,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[envelope,team,a,b,'fixture','collaboration.message','encrypted','n'.repeat(24),'s'.repeat(88),created,expires]);
  check(true,'mutually pinned sender can insert encrypted mailbox envelope');
  await assert.rejects(pg.query('INSERT INTO mingle_envelopes(team_id,from_device_id,to_device_id,idempotency_key,kind,ciphertext,nonce,signature,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now()+interval \'1 minute\')',
    [team,b,a,'forged-sender','collaboration.message','encrypted','n'.repeat(24),'s'.repeat(88)]));
  check(true, 'even team owners cannot forge another device sender');
  await assert.rejects(pg.query('INSERT INTO mingle_envelopes(team_id,from_device_id,to_device_id,idempotency_key,kind,ciphertext,nonce,signature,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now()+interval \'8 days\')',
    [team,a,b,'too-long','collaboration.message','encrypted','n'.repeat(24),'s'.repeat(88)]));
  check(true, 'mailbox payload lifetime is bounded by server policy');
});
await user(1,async()=> {
  const rows=(await pg.query<{created_at:string}>('SELECT * FROM mingle_envelopes WHERE id=$1',[envelope])).rows;
  check(rows.length===1,'only intended peer receives envelope');
  check(new Date(rows[0]!.created_at as string).toISOString()===created,'relay preserves signed creation timestamp');
});
await user(4,async()=>check((await pg.query('SELECT * FROM mingle_envelopes')).rows.length===0,'outsider cannot read encrypted mailbox'));
await user(0,async()=> {
  await pg.query('UPDATE mingle_members SET revoked_at=now() WHERE team_id=$1 AND user_id=$2',[team,ids[1]]);
  check(true,'owner can revoke member');
});
await user(1,async()=> {
  check((await pg.query('SELECT * FROM mingle_teams')).rows.length===0,'revoked member loses team access');
  check((await pg.query('SELECT * FROM mingle_envelopes')).rows.length===0,'revoked member loses queued envelope access');
});
assert.equal(checks, 30);
} finally { await pg.close(); }
}, 30_000);

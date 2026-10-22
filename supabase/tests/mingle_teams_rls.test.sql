begin;
select plan(40);

select ok((select relrowsecurity from pg_class where oid = 'public.mingle_teams'::regclass), 'teams enforce RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.mingle_members'::regclass), 'members enforce RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.mingle_invitations'::regclass), 'invitations enforce RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.mingle_projects'::regclass), 'projects enforce RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.mingle_devices'::regclass), 'devices enforce RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.mingle_device_links'::regclass), 'device links enforce RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.mingle_envelopes'::regclass), 'mailbox enforces RLS');

select ok(not has_table_privilege('anon', 'public.mingle_teams', 'select'), 'anon cannot read teams');
select ok(not has_table_privilege('anon', 'public.mingle_members', 'select'), 'anon cannot read memberships');
select ok(not has_table_privilege('anon', 'public.mingle_invitations', 'select'), 'anon cannot read invitations');
select ok(not has_table_privilege('anon', 'public.mingle_projects', 'select'), 'anon cannot read shared projects');
select ok(not has_table_privilege('anon', 'public.mingle_devices', 'select'), 'anon cannot read devices');
select ok(not has_table_privilege('anon', 'public.mingle_device_links', 'select'), 'anon cannot read device links');
select ok(not has_table_privilege('anon', 'public.mingle_envelopes', 'select'), 'anon cannot read ciphertext');

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'owner@example.com', '', now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'member@example.com', '', now(), now(), now()),
  ('33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'stranger@example.com', '', now(), now(), now());

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into public.mingle_teams (id, name, owner_id)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Shared workspace', '11111111-1111-1111-1111-111111111111');
select results_eq(
  $$select role from public.mingle_members where team_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '11111111-1111-1111-1111-111111111111'$$,
  array['owner'::text],
  'team creation atomically creates its owner membership'
);
select results_eq(
  $$insert into public.mingle_invitations (id, team_id, email, role, token_hash, expires_at)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member@example.com', 'member', repeat('a', 64), now() + interval '5 days')
    returning id$$,
  array['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid],
  'owner can create an expiring invitation'
);
select throws_ok(
  $$insert into public.mingle_invitations (team_id, email, role, token_hash, expires_at)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'other@example.com', 'member', repeat('c', 64), now() + interval '8 days')$$,
  '22023', null,
  'invitation expiry cannot be extended beyond seven days'
);

set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select is_empty(
  $$select id from public.mingle_teams where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  'nonmember cannot read a team and membership policy does not recurse'
);
select throws_ok(
  $$select public.accept_mingle_invitation(repeat('a', 64))$$,
  'P0001', null,
  'invitation cannot be accepted by the wrong account'
);

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select results_eq(
  $$select public.accept_mingle_invitation(repeat('a', 64))$$,
  array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid],
  'intended verified email can atomically accept the invitation'
);
select throws_ok(
  $$select public.accept_mingle_invitation(repeat('a', 64))$$,
  'P0001', null,
  'invitation replay is rejected'
);
select results_eq(
  $$select role from public.mingle_members where team_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '22222222-2222-2222-2222-222222222222' and revoked_at is null$$,
  array['member'::text],
  'accepted invite creates the invited member role'
);
select results_eq(
  $$select count(*)::integer from public.mingle_teams where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  array[1],
  'active member can read its team without recursive membership RLS'
);

set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$insert into public.mingle_devices (id, team_id, owner_id, name, signing_public_key, encryption_public_key, fingerprint)
    values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Owner laptop', repeat('s', 64), repeat('e', 64), 'sha256:owner-fingerprint-0001')
    returning id$$,
  array['dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid],
  'member can register their own device'
);

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select results_eq(
  $$insert into public.mingle_devices (id, team_id, owner_id, name, signing_public_key, encryption_public_key, fingerprint)
    values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'Member desktop', repeat('t', 64), repeat('f', 64), 'sha256:member-fingerprint-0001')
    returning id$$,
  array['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid],
  'second member can register their own device'
);

set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select throws_ok(
  $$insert into public.mingle_device_links (team_id, device_id, peer_device_id, peer_fingerprint)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'sha256:wrong-fingerprint-0001')$$,
  '42501', null,
  'owner cannot pin a mismatched peer fingerprint'
);
select results_eq(
  $$insert into public.mingle_device_links (team_id, device_id, peer_device_id, peer_fingerprint)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'sha256:member-fingerprint-0001')
    returning peer_device_id$$,
  array['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid],
  'device owner can pin a matching peer fingerprint'
);

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select results_eq(
  $$insert into public.mingle_device_links (team_id, device_id, peer_device_id, peer_fingerprint)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'sha256:owner-fingerprint-0001')
    returning peer_device_id$$,
  array['dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid],
  'peer owner supplies the reciprocal pin'
);

set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$insert into public.mingle_envelopes (id, team_id, from_device_id, to_device_id, idempotency_key, kind, ciphertext, nonce, signature, created_at, expires_at)
    values ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'delivery-1', 'execution.request', 'encrypted-payload', repeat('n', 24), repeat('g', 64), now() - interval '1 minute', now() + interval '1 day')
    returning (created_at = now() - interval '1 minute' and received_at <= now())$$,
  array[true],
  'active sender can enqueue; signed creation time is preserved and server receipt time is stamped'
);
select is_empty(
  $$select id from public.mingle_envelopes where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'$$,
  'sender cannot read the recipient mailbox'
);

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select results_eq(
  $$select ciphertext from public.mingle_envelopes where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'$$,
  array['encrypted-payload'::text],
  'only the active recipient owner can read the ciphertext'
);
select is_empty(
  $$update public.mingle_members set revoked_at = now() where team_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '11111111-1111-1111-1111-111111111111' returning user_id$$,
  'ordinary member cannot revoke the team owner'
);
select throws_ok(
  $$insert into public.mingle_projects (id, team_id, name)
    values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'not allowed')$$,
  '42501', null,
  'ordinary member cannot create shared projects'
);
select is_empty(
  $$delete from public.mingle_device_links where team_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and device_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' returning peer_device_id$$,
  'peer cannot delete another device owner’s pin'
);

set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select results_eq(
  $$delete from public.mingle_device_links where team_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and device_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' returning peer_device_id$$,
  array['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid],
  'device owner can revoke their explicit pin'
);
select throws_ok(
  $$insert into public.mingle_envelopes (team_id, from_device_id, to_device_id, idempotency_key, kind, ciphertext, nonce, signature, expires_at)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'delivery-2', 'execution.request', 'encrypted-payload', repeat('n', 24), repeat('g', 64), now() + interval '1 day')$$,
  '42501', null,
  'revoked pin blocks subsequent delivery'
);
insert into public.mingle_device_links (team_id, device_id, peer_device_id, peer_fingerprint)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'sha256:member-fingerprint-0001');

select results_eq(
  $$update public.mingle_members set revoked_at = now() where team_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and user_id = '22222222-2222-2222-2222-222222222222' and revoked_at is null returning user_id$$,
  array['22222222-2222-2222-2222-222222222222'::uuid],
  'owner can revoke a member'
);
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select is_empty(
  $$select id from public.mingle_teams where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  'revoked member cannot read the team'
);
select is_empty(
  $$select id from public.mingle_envelopes where id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'$$,
  'revoked member cannot receive a previously queued envelope'
);
select throws_ok(
  $$insert into public.mingle_envelopes (team_id, from_device_id, to_device_id, idempotency_key, kind, ciphertext, nonce, signature, expires_at)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'delivery-3', 'execution.request', 'encrypted-payload', repeat('n', 24), repeat('g', 64), now() + interval '1 day')$$,
  '42501', null,
  'revoked member cannot send even with old device links'
);

select * from finish();
rollback;

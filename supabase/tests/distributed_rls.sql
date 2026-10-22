-- RLS regression suite. Run only against a disposable local Supabase database:
--   supabase db reset && supabase test db
-- The enclosing transaction leaves no fixture rows behind.
begin;
select plan(30);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner@example.test', '', now()),
  ('10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'member@example.test', '', now()),
  ('10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'outsider@example.test', '', now()),
  ('10000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'invitee@example.test', '', now())
on conflict (id) do nothing;

-- Creating a team under the real authenticated role exercises the owner guard
-- and owner-membership trigger; team B is unrelated to the shared fixture.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"owner@example.test","email_verified":true}', true);
insert into public.mingle_teams (id, name, owner_id)
values ('20000000-0000-4000-8000-000000000001', 'Shared fixture team', '10000000-0000-4000-8000-000000000001');
insert into public.mingle_projects (id, team_id, name, repository_url)
values ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Shared fixture', null);
insert into public.mingle_invitations (id, team_id, email, role, token_hash, expires_at)
values ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  'invitee@example.test', 'member', repeat('a', 64), now() + interval '1 day');
insert into public.mingle_invitations (id, team_id, email, role, token_hash, expires_at)
values ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001',
  'invitee@example.test', 'member', repeat('c', 64), now() - interval '1 day');

reset role;
insert into public.mingle_members (team_id, user_id, role)
values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'member');

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","email":"outsider@example.test","email_verified":true}', true);
insert into public.mingle_teams (id, name, owner_id)
values ('20000000-0000-4000-8000-000000000002', 'Unrelated fixture team', '10000000-0000-4000-8000-000000000003');
insert into public.mingle_projects (id, team_id, name, repository_url)
values ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'Private fixture', null);

-- Active member can read shared records but not another team's records.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","email":"member@example.test","email_verified":true}', true);
select is((select count(*) from public.mingle_teams where id = '20000000-0000-4000-8000-000000000001'), 1::bigint, 'active member can read its team');
select is((select count(*) from public.mingle_members where team_id = '20000000-0000-4000-8000-000000000001' and revoked_at is null), 2::bigint, 'active member can see only the current team roster');
select is((select count(*) from public.mingle_projects where id = '30000000-0000-4000-8000-000000000001'), 1::bigint, 'active member can read a shared project');
select is((select count(*) from public.mingle_projects where id = '30000000-0000-4000-8000-000000000002'), 0::bigint, 'membership in one team does not reveal another team project');

-- A wrong account cannot accept a one-time invitation even when it knows the
-- token hash. Acceptance uses verified auth.users email inside the RPC.
select throws_ok(
  $$select public.accept_mingle_invitation(repeat('a', 64))$$,
  'P0001', 'wrong verified account cannot accept an invitation'
);

-- Nonmember C owns a different team. It cannot enumerate, join, invite into,
-- or register a device against team A.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","email":"outsider@example.test","email_verified":true}', true);
select is((select count(*) from public.mingle_teams where id = '20000000-0000-4000-8000-000000000001'), 0::bigint, 'nonmember cannot read another team');
select is((select count(*) from public.mingle_members where team_id = '20000000-0000-4000-8000-000000000001'), 0::bigint, 'nonmember cannot enumerate another team roster');
select is((select count(*) from public.mingle_projects where team_id = '20000000-0000-4000-8000-000000000001'), 0::bigint, 'nonmember cannot read another team project');
select is((select count(*) from public.mingle_invitations where team_id = '20000000-0000-4000-8000-000000000001'), 0::bigint, 'nonmember cannot inspect another team invitations');
select throws_ok(
  $$insert into public.mingle_members (team_id, user_id, role)
    values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'member')$$,
  '42501', 'nonmembers cannot self-enroll by inserting a membership row'
);
select throws_ok(
  $$insert into public.mingle_invitations (team_id, email, role, token_hash, expires_at)
    values ('20000000-0000-4000-8000-000000000001', 'outsider@example.test', 'member', repeat('b', 64), now() + interval '1 day')$$,
  '42501', 'nonmembers cannot mint invitations for another team'
);
select throws_ok(
  $$insert into public.mingle_devices (id, team_id, owner_id, name, signing_public_key, encryption_public_key, fingerprint)
    values ('50000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000003', 'Outsider', repeat('s', 40), repeat('e', 40), repeat('f', 64))$$,
  '42501', 'nonmember cannot register a device in another team'
);

-- Device registration must be self-owned. The two active team members can
-- register their own independent device identities.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"owner@example.test","email_verified":true}', true);
insert into public.mingle_devices (id, team_id, owner_id, name, signing_public_key, encryption_public_key, fingerprint)
values ('50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001', 'Owner device', repeat('s', 40), repeat('e', 40), 'SHA-256:' || repeat('a', 64));

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","email":"member@example.test","email_verified":true}', true);
insert into public.mingle_devices (id, team_id, owner_id, name, signing_public_key, encryption_public_key, fingerprint)
values ('50000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002', 'Member device', repeat('t', 40), repeat('f', 40), 'SHA-256:' || repeat('b', 64));

-- One-sided links cannot authorize cloud mailbox traffic. A pin must be
-- created by the device owner and match the target's actual fingerprint.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"owner@example.test","email_verified":true}', true);
insert into public.mingle_device_links (team_id, device_id, peer_device_id, peer_fingerprint)
values ('20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000002', 'SHA-256:' || repeat('b', 64));
select throws_ok(
  $$insert into public.mingle_device_links (team_id, device_id, peer_device_id, peer_fingerprint)
    values ('20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002', 'SHA-256:' || repeat('c', 64))$$,
  '42501', 'a device cannot pin a peer fingerprint that differs from the registered key'
);
select throws_ok(
  $$insert into public.mingle_envelopes (team_id, from_device_id, to_device_id, idempotency_key, kind, ciphertext, nonce, signature, expires_at)
    values ('20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002', 'one-sided', 'execution.request', 'ciphertext', 'nonce-123456789012',
      'signature-123456789012', now() + interval '1 day')$$,
  '42501', 'mailbox delivery is blocked until the recipient pins the sender too'
);

-- The receiver adds its reciprocal pin. A can now send, but cannot read its
-- outbound envelope back from the recipient mailbox.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","email":"member@example.test","email_verified":true}', true);
insert into public.mingle_device_links (team_id, device_id, peer_device_id, peer_fingerprint)
values ('20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000001', 'SHA-256:' || repeat('a', 64));
select is((select count(*) from public.mingle_device_links where team_id = '20000000-0000-4000-8000-000000000001'), 2::bigint, 'linked device owner can inspect the reciprocal trust pins');

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"owner@example.test","email_verified":true}', true);
insert into public.mingle_envelopes (id, team_id, from_device_id, to_device_id, idempotency_key, kind, ciphertext, nonce, signature, expires_at)
values ('60000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 'message-1',
  'collaboration.message', 'opaque-ciphertext', 'nonce-123456789012', 'signature-123456789012', now() + interval '1 day');
select is((select count(*) from public.mingle_envelopes where id = '60000000-0000-4000-8000-000000000001'), 0::bigint, 'sender cannot read its own outbound mailbox item');

-- The recipient sees only a message addressed to its owned active device and
-- cannot forge a row claiming another device as sender.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","email":"member@example.test","email_verified":true}', true);
select is((select count(*) from public.mingle_envelopes where id = '60000000-0000-4000-8000-000000000001'), 1::bigint, 'recipient can read the mutually pinned envelope');
select throws_ok(
  $$insert into public.mingle_envelopes (team_id, from_device_id, to_device_id, idempotency_key, kind, ciphertext, nonce, signature, expires_at)
    values ('20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000002', 'forged-sender', 'execution.request', 'ciphertext', 'nonce-123456789012',
      'signature-123456789012', now() + interval '1 day')$$,
  '42501', 'recipient cannot send a mailbox row as another device'
);
update public.mingle_devices set revoked_at = now()
  where id = '50000000-0000-4000-8000-000000000001';
select is((select revoked_at from public.mingle_devices where id = '50000000-0000-4000-8000-000000000001'), null::timestamptz, 'member cannot revoke a device owned by another account');

-- D can see its own invitation without seeing the team, then accept once using
-- its verified auth.users email; membership and team visibility become active.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated","email":"invitee@example.test","email_verified":true}', true);
select is((select count(*) from public.mingle_invitations where id = '40000000-0000-4000-8000-000000000001'), 1::bigint, 'verified invitation target can see only its invite');
select is((select count(*) from public.mingle_teams where id = '20000000-0000-4000-8000-000000000001'), 0::bigint, 'invitation visibility does not grant team access before acceptance');
select is((select public.accept_mingle_invitation(repeat('a', 64))::text), '20000000-0000-4000-8000-000000000001', 'verified target accepts its invitation');
select is((select count(*) from public.mingle_teams where id = '20000000-0000-4000-8000-000000000001'), 1::bigint, 'accepted invitation grants only the new active membership');
select throws_ok(
  $$select public.accept_mingle_invitation(repeat('a', 64))$$,
  'P0001', 'accepted invitation cannot be replayed'
);
select throws_ok(
  $$select public.accept_mingle_invitation(repeat('c', 64))$$,
  'P0001', 'expired invitation cannot be accepted'
);

-- Owner revocation hides pending mailbox traffic immediately and cannot be
-- undone by the revoked device owner.
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated","email":"owner@example.test","email_verified":true}', true);
update public.mingle_devices set revoked_at = now()
  where id = '50000000-0000-4000-8000-000000000001';
select is((select (revoked_at is not null) from public.mingle_devices where id = '50000000-0000-4000-8000-000000000001'), true, 'device owner can revoke its own device');
update public.mingle_devices set revoked_at = null
  where id = '50000000-0000-4000-8000-000000000001';
select is((select (revoked_at is not null) from public.mingle_devices where id = '50000000-0000-4000-8000-000000000001'), true, 'device revocation cannot be reversed by restoring the old identity');

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated","email":"member@example.test","email_verified":true}', true);
select is((select count(*) from public.mingle_envelopes where id = '60000000-0000-4000-8000-000000000001'), 0::bigint, 'revoking the sender device hides its pending envelope from the recipient');
select throws_ok(
  $$insert into public.mingle_envelopes (team_id, from_device_id, to_device_id, idempotency_key, kind, ciphertext, nonce, signature, expires_at)
    values ('20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000001', 'revoked-peer', 'execution.request', 'ciphertext', 'nonce-123456789012',
      'signature-123456789012', now() + interval '1 day')$$,
  '42501', 'a revoked peer cannot receive new mailbox messages'
);

reset role;
select is((select count(*) from public.mingle_members where team_id = '20000000-0000-4000-8000-000000000001' and user_id = '10000000-0000-4000-8000-000000000003' and revoked_at is null), 0::bigint, 'failed self-enrollment left no membership behind');
select finish();
rollback;

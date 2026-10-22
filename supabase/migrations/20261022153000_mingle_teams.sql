-- Team metadata and the authenticated-device mailbox only. Source trees,
-- transcripts, provider credentials and local paths are deliberately absent.
create table public.mingle_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 100),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.mingle_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.mingle_teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint mingle_members_revocation_order check (revoked_at is null or revoked_at >= created_at)
);
create unique index mingle_members_one_active_idx on public.mingle_members(team_id, user_id) where revoked_at is null;
create index mingle_members_user_active_idx on public.mingle_members(user_id, team_id) where revoked_at is null;

create table public.mingle_invitations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.mingle_teams(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and length(email) between 3 and 254),
  role text not null check (role in ('admin', 'member')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index mingle_invitations_team_created_idx on public.mingle_invitations(team_id, created_at desc);
create index mingle_invitations_email_idx on public.mingle_invitations(email, expires_at) where accepted_at is null;

create table public.mingle_projects (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.mingle_teams(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  repository_url text check (
    repository_url is null or (
      length(repository_url) <= 2048
      and (repository_url ~ '^https://' or repository_url ~ '^ssh://')
      and repository_url !~ '^[a-z]+://[^/]*@'
      and repository_url !~ '[?#]'
    )
  ),
  created_at timestamptz not null default now()
);
create index mingle_projects_team_idx on public.mingle_projects(team_id, created_at);

create table public.mingle_devices (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.mingle_teams(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  signing_public_key text not null check (length(signing_public_key) between 32 and 4096),
  encryption_public_key text not null check (length(encryption_public_key) between 32 and 4096),
  fingerprint text not null check (length(fingerprint) between 16 and 200),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, team_id)
);
create index mingle_devices_team_owner_idx on public.mingle_devices(team_id, owner_id) where revoked_at is null;

create table public.mingle_device_links (
  team_id uuid not null references public.mingle_teams(id) on delete cascade,
  device_id uuid not null,
  peer_device_id uuid not null,
  peer_fingerprint text not null check (length(peer_fingerprint) between 16 and 200),
  created_at timestamptz not null default now(),
  primary key (team_id, device_id, peer_device_id),
  check (device_id <> peer_device_id),
  foreign key (device_id, team_id) references public.mingle_devices(id, team_id) on delete cascade,
  foreign key (peer_device_id, team_id) references public.mingle_devices(id, team_id) on delete cascade
);
create index mingle_device_links_peer_idx on public.mingle_device_links(team_id, peer_device_id);

create table public.mingle_envelopes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.mingle_teams(id) on delete cascade,
  from_device_id uuid not null,
  to_device_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  kind text not null check (length(kind) between 1 and 100),
  ciphertext text not null check (octet_length(ciphertext) between 1 and 2097152),
  nonce text not null check (length(nonce) between 16 and 256),
  signature text not null check (length(signature) between 16 and 1024),
  created_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (team_id, from_device_id, to_device_id, idempotency_key),
  foreign key (from_device_id, team_id) references public.mingle_devices(id, team_id) on delete cascade,
  foreign key (to_device_id, team_id) references public.mingle_devices(id, team_id) on delete cascade,
  check (from_device_id <> to_device_id)
);
create index mingle_envelopes_recipient_expiry_idx on public.mingle_envelopes(team_id, to_device_id, received_at, expires_at);
create index mingle_envelopes_sender_idx on public.mingle_envelopes(team_id, from_device_id, received_at);

create schema if not exists mingle_private;
revoke all on schema mingle_private from public, anon, authenticated;
grant usage on schema mingle_private to authenticated;

-- Every policy helper checks the current authenticated identity. They read
-- membership rows as their tightly-scoped owner to avoid recursive RLS.
create function mingle_private.has_active_member(p_team_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from public.mingle_members m
      where m.team_id = p_team_id and m.user_id = p_user_id and m.revoked_at is null
    );
$$;

create function mingle_private.is_active_team_member(p_team_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and mingle_private.has_active_member(p_team_id, (select auth.uid()));
$$;

create function mingle_private.has_team_role(p_team_id uuid, p_roles text[])
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from public.mingle_members m
      where m.team_id = p_team_id and m.user_id = (select auth.uid())
        and m.revoked_at is null and m.role = any(p_roles)
    );
$$;

create function mingle_private.can_revoke_member(p_team_id uuid, p_user_id uuid, p_target_role text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and p_user_id <> (select auth.uid())
    and p_target_role <> 'owner'
    and (
      mingle_private.has_team_role(p_team_id, array['owner'])
      or (p_target_role = 'member' and mingle_private.has_team_role(p_team_id, array['admin']))
    );
$$;

create function mingle_private.can_manage_device(p_team_id uuid, p_device_id uuid, p_owner_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and mingle_private.is_active_team_member(p_team_id)
    and (
      p_owner_id = (select auth.uid())
      or mingle_private.has_team_role(p_team_id, array['owner', 'admin'])
    )
    and exists (
      select 1 from public.mingle_devices d
      where d.id = p_device_id and d.team_id = p_team_id and d.owner_id = p_owner_id
    );
$$;

create function mingle_private.can_view_device_link(p_team_id uuid, p_device_id uuid, p_peer_device_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and mingle_private.is_active_team_member(p_team_id)
    and exists (
      select 1 from public.mingle_devices d
      where d.team_id = p_team_id and d.id in (p_device_id, p_peer_device_id)
        and d.owner_id = (select auth.uid())
    );
$$;

create function mingle_private.can_insert_device_link(
  p_team_id uuid, p_device_id uuid, p_peer_device_id uuid, p_peer_fingerprint text
)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and mingle_private.is_active_team_member(p_team_id)
    and exists (
      select 1 from public.mingle_devices own_device
      join public.mingle_devices peer on peer.team_id = own_device.team_id
      where own_device.team_id = p_team_id and own_device.id = p_device_id
        and own_device.owner_id = (select auth.uid()) and own_device.revoked_at is null
        and peer.id = p_peer_device_id and peer.revoked_at is null
        and peer.fingerprint = p_peer_fingerprint
        and mingle_private.has_active_member(p_team_id, peer.owner_id)
    );
$$;

create function mingle_private.has_mutual_device_pins(p_team_id uuid, p_device_a uuid, p_device_b uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and mingle_private.is_active_team_member(p_team_id)
    and exists (
      select 1
      from public.mingle_devices a
      join public.mingle_devices b on b.team_id = a.team_id
      join public.mingle_device_links ab on ab.team_id = a.team_id and ab.device_id = a.id and ab.peer_device_id = b.id
      join public.mingle_device_links ba on ba.team_id = a.team_id and ba.device_id = b.id and ba.peer_device_id = a.id
      where a.team_id = p_team_id and a.id = p_device_a and b.id = p_device_b
        and a.revoked_at is null and b.revoked_at is null
        and ab.peer_fingerprint = b.fingerprint and ba.peer_fingerprint = a.fingerprint
        and mingle_private.has_active_member(p_team_id, a.owner_id)
        and mingle_private.has_active_member(p_team_id, b.owner_id)
    );
$$;

create function mingle_private.can_send_envelope(p_team_id uuid, p_from_device_id uuid, p_to_device_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from public.mingle_devices sender
      join public.mingle_devices recipient on recipient.team_id = sender.team_id
      where sender.team_id = p_team_id and sender.id = p_from_device_id
        and sender.owner_id = (select auth.uid()) and sender.revoked_at is null
        and recipient.id = p_to_device_id and recipient.revoked_at is null
        and mingle_private.has_active_member(p_team_id, sender.owner_id)
        and mingle_private.has_active_member(p_team_id, recipient.owner_id)
        and mingle_private.has_mutual_device_pins(p_team_id, sender.id, recipient.id)
    );
$$;

create function mingle_private.can_receive_envelope(p_team_id uuid, p_from_device_id uuid, p_to_device_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from public.mingle_devices sender
      join public.mingle_devices recipient on recipient.team_id = sender.team_id
      where sender.team_id = p_team_id and sender.id = p_from_device_id
        and sender.revoked_at is null and recipient.id = p_to_device_id
        and recipient.owner_id = (select auth.uid()) and recipient.revoked_at is null
        and mingle_private.has_active_member(p_team_id, sender.owner_id)
        and mingle_private.has_active_member(p_team_id, recipient.owner_id)
        and mingle_private.has_mutual_device_pins(p_team_id, sender.id, recipient.id)
    );
$$;

create function mingle_private.can_delete_envelope(p_team_id uuid, p_from_device_id uuid, p_to_device_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from public.mingle_devices d
      where d.team_id = p_team_id and d.id in (p_from_device_id, p_to_device_id)
        and d.owner_id = (select auth.uid())
    );
$$;

-- The public RPC is intentionally narrow: only authenticated users may invoke
-- it, its identity comes from auth.uid(), and it consumes a random-token hash
-- atomically. It is not a service-role or anonymous API.
create function public.accept_mingle_invitation(p_token_hash text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_confirmed boolean;
  v_invitation public.mingle_invitations%rowtype;
  v_existing_revoked_at timestamptz;
begin
  if v_user_id is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;

  select lower(u.email), u.email_confirmed_at is not null
    into v_email, v_confirmed
    from auth.users u where u.id = v_user_id;
  if v_email is null or not coalesce(v_confirmed, false) then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;

  select i.* into v_invitation
    from public.mingle_invitations i
    where i.token_hash = p_token_hash
    for update;
  if not found or v_invitation.accepted_at is not null or v_invitation.expires_at <= now()
    or v_invitation.email <> v_email then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;

  select m.revoked_at into v_existing_revoked_at
    from public.mingle_members m
    where m.team_id = v_invitation.team_id and m.user_id = v_user_id
    order by m.created_at desc limit 1;
  if found and v_existing_revoked_at is null then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;

  insert into public.mingle_members(id, team_id, user_id, role, created_at)
    values (gen_random_uuid(), v_invitation.team_id, v_user_id, v_invitation.role, now());
  update public.mingle_invitations set accepted_at = now() where id = v_invitation.id;
  return v_invitation.team_id;
end;
$$;

-- Small trigger guards are invoker functions; the invitation RPC above is the
-- only operation that can create a member after a team has been created.
create function mingle_private.stamp_team() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.owner_id is distinct from old.owner_id
      or new.created_at is distinct from old.created_at then
      raise exception using errcode = '42501', message = 'team ownership is immutable';
    end if;
    return new;
  end if;
  if new.owner_id is distinct from (select auth.uid()) then
    raise exception using errcode = '42501', message = 'team owner must be the authenticated user';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create function mingle_private.seed_team_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or new.owner_id is distinct from (select auth.uid()) then
    raise exception using errcode = '42501', message = 'team owner must be the authenticated user';
  end if;
  insert into public.mingle_members(id, team_id, user_id, role, created_at)
    values (gen_random_uuid(), new.id, new.owner_id, 'owner', now());
  return new;
end;
$$;

create function mingle_private.stamp_invitation() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.email := lower(btrim(new.email));
  new.created_at := now();
  if new.expires_at <= now() or new.expires_at > now() + interval '7 days' then
    raise exception using errcode = '22023', message = 'invitation expiry must be within seven days';
  end if;
  return new;
end;
$$;

create function mingle_private.stamp_project() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.name := btrim(new.name);
  new.created_at := now();
  return new;
end;
$$;

create function mingle_private.guard_device() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.last_seen_at := now();
    new.revoked_at := null;
    return new;
  end if;
  if old.revoked_at is not null
    or new.id is distinct from old.id
    or new.team_id is distinct from old.team_id
    or new.owner_id is distinct from old.owner_id
    or new.signing_public_key is distinct from old.signing_public_key
    or new.encryption_public_key is distinct from old.encryption_public_key
    or new.fingerprint is distinct from old.fingerprint
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '42501', message = 'device identity is immutable';
  end if;
  if new.last_seen_at is distinct from old.last_seen_at and old.owner_id <> (select auth.uid()) then
    raise exception using errcode = '42501', message = 'only the device owner can update its heartbeat';
  end if;
  if old.owner_id = (select auth.uid()) then
    new.last_seen_at := now();
  else
    new.last_seen_at := old.last_seen_at;
  end if;
  if new.revoked_at is distinct from old.revoked_at then
    if new.revoked_at is null then
      raise exception using errcode = '42501', message = 'device revocation cannot be undone';
    end if;
    new.revoked_at := now();
  end if;
  return new;
end;
$$;

create function mingle_private.stamp_device_link() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.created_at := now();
  return new;
end;
$$;

create function mingle_private.stamp_envelope() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  -- created_at is covered by the device signature and must be preserved as
  -- sent. received_at is the server-assigned queue cursor/order.
  if new.created_at < now() - interval '24 hours' or new.created_at > now() + interval '5 minutes'
    or new.expires_at <= now() or new.expires_at <= new.created_at
    or new.expires_at > new.created_at + interval '7 days'
    or new.expires_at > now() + interval '7 days' then
    raise exception using errcode = '22023', message = 'envelope expiry must be within seven days';
  end if;
  new.received_at := now();
  return new;
end;
$$;

create trigger mingle_teams_stamp before insert or update on public.mingle_teams
  for each row execute function mingle_private.stamp_team();
create trigger mingle_teams_seed_owner after insert on public.mingle_teams
  for each row execute function mingle_private.seed_team_owner();
create trigger mingle_invitations_stamp before insert on public.mingle_invitations
  for each row execute function mingle_private.stamp_invitation();
create trigger mingle_projects_stamp before insert on public.mingle_projects
  for each row execute function mingle_private.stamp_project();
create trigger mingle_devices_guard before insert or update on public.mingle_devices
  for each row execute function mingle_private.guard_device();
create trigger mingle_device_links_stamp before insert on public.mingle_device_links
  for each row execute function mingle_private.stamp_device_link();
create trigger mingle_envelopes_stamp before insert on public.mingle_envelopes
  for each row execute function mingle_private.stamp_envelope();

-- A verified, one-time invitation is the only insert path for memberships.
revoke all on function public.accept_mingle_invitation(text) from public, anon;
grant execute on function public.accept_mingle_invitation(text) to authenticated;
revoke all on all functions in schema mingle_private from public, anon, authenticated;
grant execute on function mingle_private.is_active_team_member(uuid) to authenticated;
grant execute on function mingle_private.has_team_role(uuid, text[]) to authenticated;
grant execute on function mingle_private.can_revoke_member(uuid, uuid, text) to authenticated;
grant execute on function mingle_private.can_manage_device(uuid, uuid, uuid) to authenticated;
grant execute on function mingle_private.can_view_device_link(uuid, uuid, uuid) to authenticated;
grant execute on function mingle_private.can_insert_device_link(uuid, uuid, uuid, text) to authenticated;
grant execute on function mingle_private.can_send_envelope(uuid, uuid, uuid) to authenticated;
grant execute on function mingle_private.can_receive_envelope(uuid, uuid, uuid) to authenticated;
grant execute on function mingle_private.can_delete_envelope(uuid, uuid, uuid) to authenticated;

alter table public.mingle_teams enable row level security;
alter table public.mingle_members enable row level security;
alter table public.mingle_invitations enable row level security;
alter table public.mingle_projects enable row level security;
alter table public.mingle_devices enable row level security;
alter table public.mingle_device_links enable row level security;
alter table public.mingle_envelopes enable row level security;

revoke all on public.mingle_teams, public.mingle_members, public.mingle_invitations,
  public.mingle_projects, public.mingle_devices, public.mingle_device_links,
  public.mingle_envelopes from anon, authenticated;
grant select, insert, delete on public.mingle_teams to authenticated;
grant update (name) on public.mingle_teams to authenticated;
grant select on public.mingle_members to authenticated;
grant update (revoked_at) on public.mingle_members to authenticated;
grant select, insert, delete on public.mingle_invitations to authenticated;
grant select, insert, delete on public.mingle_projects to authenticated;
grant update (name, repository_url) on public.mingle_projects to authenticated;
grant select, insert on public.mingle_devices to authenticated;
grant update (last_seen_at, revoked_at) on public.mingle_devices to authenticated;
grant select, insert, delete on public.mingle_device_links to authenticated;
grant select, delete on public.mingle_envelopes to authenticated;
grant insert (id, team_id, from_device_id, to_device_id, idempotency_key, kind, ciphertext, nonce, signature, created_at, expires_at)
  on public.mingle_envelopes to authenticated;

create policy mingle_teams_read_member on public.mingle_teams for select to authenticated
  using (owner_id = (select auth.uid()) or (select mingle_private.is_active_team_member(id)));
create policy mingle_teams_insert_owner on public.mingle_teams for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy mingle_teams_update_admin on public.mingle_teams for update to authenticated
  using ((select mingle_private.has_team_role(id, array['owner', 'admin'])))
  with check ((select mingle_private.has_team_role(id, array['owner', 'admin'])));
create policy mingle_teams_delete_owner on public.mingle_teams for delete to authenticated
  using ((select mingle_private.has_team_role(id, array['owner'])));

create policy mingle_members_read_member on public.mingle_members for select to authenticated
  using ((select mingle_private.is_active_team_member(team_id)));
create policy mingle_members_revoke_admin on public.mingle_members for update to authenticated
  using (revoked_at is null and (select mingle_private.can_revoke_member(team_id, user_id, role)))
  with check (revoked_at is not null and (select mingle_private.can_revoke_member(team_id, user_id, role)));

create policy mingle_invitations_read_manager_or_invitee on public.mingle_invitations for select to authenticated
  using (
    (select mingle_private.has_team_role(team_id, array['owner', 'admin']))
    or (lower(email) = lower(coalesce((select auth.jwt())->>'email', '')))
  );
create policy mingle_invitations_create_admin on public.mingle_invitations for insert to authenticated
  with check ((select mingle_private.has_team_role(team_id, array['owner', 'admin'])));
create policy mingle_invitations_delete_admin on public.mingle_invitations for delete to authenticated
  using ((select mingle_private.has_team_role(team_id, array['owner', 'admin'])));

create policy mingle_projects_read_member on public.mingle_projects for select to authenticated
  using ((select mingle_private.is_active_team_member(team_id)));
create policy mingle_projects_create_admin on public.mingle_projects for insert to authenticated
  with check ((select mingle_private.has_team_role(team_id, array['owner', 'admin'])));
create policy mingle_projects_update_admin on public.mingle_projects for update to authenticated
  using ((select mingle_private.has_team_role(team_id, array['owner', 'admin'])))
  with check ((select mingle_private.has_team_role(team_id, array['owner', 'admin'])));
create policy mingle_projects_delete_admin on public.mingle_projects for delete to authenticated
  using ((select mingle_private.has_team_role(team_id, array['owner', 'admin'])));

create policy mingle_devices_read_member on public.mingle_devices for select to authenticated
  using ((select mingle_private.is_active_team_member(team_id)));
create policy mingle_devices_register_self on public.mingle_devices for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select mingle_private.is_active_team_member(team_id)));
create policy mingle_devices_update_owner_or_admin on public.mingle_devices for update to authenticated
  using (revoked_at is null and (select mingle_private.can_manage_device(team_id, id, owner_id)))
  with check ((select mingle_private.can_manage_device(team_id, id, owner_id)));

create policy mingle_device_links_read_participant on public.mingle_device_links for select to authenticated
  using ((select mingle_private.can_view_device_link(team_id, device_id, peer_device_id)));
create policy mingle_device_links_create_owner_pin on public.mingle_device_links for insert to authenticated
  with check ((select mingle_private.can_insert_device_link(team_id, device_id, peer_device_id, peer_fingerprint)));
create policy mingle_device_links_delete_owner_pin on public.mingle_device_links for delete to authenticated
  using (exists (
    select 1 from public.mingle_devices d
    where d.id = device_id and d.team_id = team_id and d.owner_id = (select auth.uid()) and d.revoked_at is null
  ));

create policy mingle_envelopes_send_mutually_pinned on public.mingle_envelopes for insert to authenticated
  with check ((select mingle_private.can_send_envelope(team_id, from_device_id, to_device_id)));
create policy mingle_envelopes_receive_mutually_pinned on public.mingle_envelopes for select to authenticated
  using (expires_at > now() and (select mingle_private.can_receive_envelope(team_id, from_device_id, to_device_id)));
create policy mingle_envelopes_delete_participant on public.mingle_envelopes for delete to authenticated
  using ((select mingle_private.can_delete_envelope(team_id, from_device_id, to_device_id)));

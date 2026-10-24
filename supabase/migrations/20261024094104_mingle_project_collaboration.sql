-- Project-scoped invitation metadata and one-time device enrollment grants.
-- Existing team visibility remains team-wide for active members; this migration
-- does not create a second team or widen any existing team policy.

alter table public.mingle_projects
  add constraint mingle_projects_id_team_unique unique (id, team_id);

create table public.mingle_project_collaboration_scopes (
  team_id uuid primary key references public.mingle_teams(id) on delete cascade,
  shared_project_id uuid not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  foreign key (shared_project_id, team_id) references public.mingle_projects(id, team_id) on delete cascade
);

create table public.mingle_project_member_profiles (
  team_id uuid not null references public.mingle_teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and length(email) between 3 and 254),
  display_name text check (display_name is null or length(display_name) <= 200),
  updated_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index mingle_project_member_profiles_user_idx on public.mingle_project_member_profiles(user_id, team_id);

create table public.mingle_project_invitations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  shared_project_id uuid not null,
  email text not null check (email = lower(btrim(email)) and length(email) between 3 and 254),
  role text not null check (role in ('admin', 'member')),
  invited_by uuid not null references auth.users(id) on delete cascade,
  leader_device_id uuid not null,
  leader_fingerprint text not null check (leader_fingerprint ~ '^SHA-256:[0-9a-f]{64}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (shared_project_id, team_id) references public.mingle_projects(id, team_id) on delete cascade,
  foreign key (leader_device_id, team_id) references public.mingle_devices(id, team_id) on delete cascade,
  check ((accepted_at is null) = (accepted_by is null)),
  check (revoked_at is null or accepted_at is null)
);
create index mingle_project_invitations_scope_idx on public.mingle_project_invitations(team_id, shared_project_id, created_at desc);
create index mingle_project_invitations_email_idx on public.mingle_project_invitations(email, expires_at) where accepted_at is null and revoked_at is null;

create table public.mingle_project_invitation_enrollments (
  invitation_id uuid primary key references public.mingle_project_invitations(id) on delete cascade,
  team_id uuid not null references public.mingle_teams(id) on delete cascade,
  invited_account_id uuid not null references auth.users(id) on delete cascade,
  leader_account_id uuid not null references auth.users(id) on delete cascade,
  leader_device_id uuid not null,
  leader_fingerprint text not null check (leader_fingerprint ~ '^SHA-256:[0-9a-f]{64}$'),
  invitee_device_id uuid,
  invitee_fingerprint text check (invitee_fingerprint is null or invitee_fingerprint ~ '^SHA-256:[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  completed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (leader_device_id, team_id) references public.mingle_devices(id, team_id) on delete cascade,
  foreign key (invitee_device_id, team_id) references public.mingle_devices(id, team_id) on delete cascade,
  check ((invitee_device_id is null) = (invitee_fingerprint is null))
);
create index mingle_project_invitation_enrollments_team_idx on public.mingle_project_invitation_enrollments(team_id, expires_at);

-- Server-only rolling send caps prevent a compromised desktop account from
-- using repeated resend requests as an unbounded shared Gmail relay.
create table public.mingle_project_invitation_delivery_limits (
  team_id uuid not null references public.mingle_teams(id) on delete cascade,
  invited_by uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null check (recipient_email = lower(btrim(recipient_email)) and length(recipient_email) between 3 and 254),
  window_started_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  last_attempt_at timestamptz,
  primary key (team_id, invited_by, recipient_email)
);
create table public.mingle_project_invitation_owner_limits (
  team_id uuid not null references public.mingle_teams(id) on delete cascade,
  invited_by uuid not null references auth.users(id) on delete cascade,
  daily_window_started_at timestamptz not null,
  daily_attempt_count integer not null default 0 check (daily_attempt_count between 0 and 50),
  hourly_window_started_at timestamptz not null,
  hourly_attempt_count integer not null default 0 check (hourly_attempt_count between 0 and 10),
  primary key (team_id, invited_by)
);

create function mingle_private.stamp_project_member_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
begin
  if new.user_id is distinct from (select auth.uid()) then
    raise exception using errcode = '42501', message = 'member profile owner must be the authenticated user';
  end if;
  select lower(u.email) into v_email from auth.users u
    where u.id = new.user_id and u.email_confirmed_at is not null;
  if v_email is null or lower(btrim(new.email)) <> v_email then
    raise exception using errcode = '42501', message = 'member profile email must be the verified account email';
  end if;
  new.email := v_email;
  new.display_name := nullif(btrim(new.display_name), '');
  new.updated_at := now();
  return new;
end;
$$;

create function mingle_private.guard_scoped_team_project() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_scoped_project_id uuid;
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    -- Team/account deletion cascades the whole scoped team; direct deletion of
    -- the one shared project remains forbidden below.
    return old;
  end if;
  if tg_op = 'INSERT' then
    perform 1 from public.mingle_teams t where t.id = new.team_id for update;
    select s.shared_project_id into v_scoped_project_id from public.mingle_project_collaboration_scopes s
      where s.team_id = new.team_id;
    if found and v_scoped_project_id <> new.id then
      raise exception using errcode = '42501', message = 'a project-first Mingle team is restricted to its original shared project';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and new.team_id is distinct from old.team_id then
    raise exception using errcode = '42501', message = 'a shared project cannot be reassigned to another team';
  end if;

  perform 1 from public.mingle_teams t where t.id = old.team_id for update;
  select s.shared_project_id into v_scoped_project_id from public.mingle_project_collaboration_scopes s
    where s.team_id = old.team_id;
  if not found then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'the shared project for a project-first team cannot be deleted';
  end if;
  if new.id is distinct from v_scoped_project_id or new.team_id is distinct from old.team_id
    or new.repository_url is distinct from old.repository_url then
    raise exception using errcode = '42501', message = 'the project identity and repository for a project-first team are immutable';
  end if;
  return new;
end;
$$;

create trigger mingle_projects_scope_guard before insert or update or delete on public.mingle_projects
  for each row execute function mingle_private.guard_scoped_team_project();

create function mingle_private.stamp_project_invitation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_device public.mingle_devices%rowtype;
  v_project public.mingle_projects%rowtype;
  v_email text;
  v_token_changed boolean;
  v_acceptance_changed boolean;
  v_revocation_changed boolean;
begin
  if tg_op = 'INSERT' then
    new.email := lower(btrim(new.email));
    new.invited_by := (select auth.uid());
    new.created_at := now();
    if new.expires_at <= now() or new.expires_at > now() + interval '7 days' then
      raise exception using errcode = '22023', message = 'project invitation expiry must be within seven days';
    end if;
    select d.* into v_device from public.mingle_devices d
      where d.id = new.leader_device_id and d.team_id = new.team_id and d.owner_id = new.invited_by
        and d.fingerprint = new.leader_fingerprint and d.revoked_at is null;
    if not found then
      raise exception using errcode = '42501', message = 'project invitation requires the leader’s active verified device';
    end if;
    select p.* into v_project from public.mingle_projects p
      where p.id = new.shared_project_id and p.team_id = new.team_id and p.repository_url is not null;
    if not found then
      raise exception using errcode = '22023', message = 'project invitation requires a shared Git project';
    end if;
    if v_project.repository_url !~ '^https://' and v_project.repository_url !~ '^ssh://' then
      raise exception using errcode = '22023', message = 'project repository URL is not shareable';
    end if;
    if v_project.repository_url ~ '^[a-z]+://[^/]*@' or v_project.repository_url ~ '[?#]' then
      raise exception using errcode = '22023', message = 'project repository URL contains credentials or URL parameters';
    end if;
    if not exists (select 1 from public.mingle_project_collaboration_scopes s
      where s.team_id = new.team_id and s.shared_project_id = new.shared_project_id) then
      raise exception using errcode = '42501', message = 'project invitations require an explicitly scoped project-first team';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id or new.team_id is distinct from old.team_id
    or new.shared_project_id is distinct from old.shared_project_id or new.email is distinct from old.email
    or new.role is distinct from old.role or new.invited_by is distinct from old.invited_by
    or new.leader_device_id is distinct from old.leader_device_id
    or new.leader_fingerprint is distinct from old.leader_fingerprint
    or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at then
    raise exception using errcode = '42501', message = 'project invitation metadata is immutable';
  end if;
  v_token_changed := new.token_hash is distinct from old.token_hash;
  v_acceptance_changed := new.accepted_at is distinct from old.accepted_at or new.accepted_by is distinct from old.accepted_by;
  v_revocation_changed := new.revoked_at is distinct from old.revoked_at;
  if (v_token_changed::integer + v_acceptance_changed::integer + v_revocation_changed::integer) > 1 then
    raise exception using errcode = '42501', message = 'project invitation transitions must be performed separately';
  end if;

  if v_acceptance_changed then
    if old.accepted_at is not null or old.accepted_by is not null or old.revoked_at is not null
      or new.accepted_at is null or new.accepted_by is distinct from (select auth.uid())
      or new.token_hash is distinct from old.token_hash or new.revoked_at is distinct from old.revoked_at
      or old.expires_at <= now() then
      raise exception using errcode = '42501', message = 'project invitation acceptance is not valid';
    end if;
    select lower(u.email) into v_email from auth.users u
      where u.id = new.accepted_by and u.email_confirmed_at is not null;
    if v_email is null or v_email <> new.email
      or not exists (select 1 from public.mingle_members m where m.team_id = new.team_id
        and m.user_id = new.invited_by and m.role = 'owner' and m.revoked_at is null)
      or not exists (select 1 from public.mingle_devices d where d.id = new.leader_device_id
        and d.team_id = new.team_id and d.owner_id = new.invited_by
        and d.fingerprint = new.leader_fingerprint and d.revoked_at is null) then
      raise exception using errcode = '42501', message = 'project invitation acceptance authority is unavailable';
    end if;
    new.accepted_at := now();
    return new;
  end if;

  if v_token_changed then
    if old.accepted_at is not null or old.accepted_by is not null or old.revoked_at is not null
      or old.expires_at <= now()
      or not exists (select 1 from public.mingle_members m where m.team_id = old.team_id
        and m.user_id = old.invited_by and m.role = 'owner' and m.revoked_at is null)
      or not exists (select 1 from public.mingle_devices d where d.id = old.leader_device_id
        and d.team_id = old.team_id and d.owner_id = old.invited_by
        and d.fingerprint = old.leader_fingerprint and d.revoked_at is null) then
      raise exception using errcode = '42501', message = 'only an active pending leader invitation token can be rotated';
    end if;
    return new;
  end if;

  if v_revocation_changed then
    if old.revoked_at is not null or new.revoked_at is null or old.accepted_at is not null
      or not exists (select 1 from public.mingle_members m where m.team_id = old.team_id
        and m.user_id = old.invited_by and m.role = 'owner' and m.revoked_at is null) then
      raise exception using errcode = '42501', message = 'project invitation revocation cannot be reversed';
    end if;
    new.revoked_at := now();
    return new;
  end if;
  return new;
end;
$$;

create trigger mingle_project_member_profiles_stamp before insert or update
  on public.mingle_project_member_profiles for each row execute function mingle_private.stamp_project_member_profile();
create trigger mingle_project_invitations_stamp before insert or update
  on public.mingle_project_invitations for each row execute function mingle_private.stamp_project_invitation();

create function mingle_private.can_reenroll_project_collaborator(p_team_id uuid, p_shared_project_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.mingle_project_invitations i
    left join public.mingle_project_invitation_enrollments e on e.invitation_id = i.id
    where i.team_id = p_team_id and i.shared_project_id = p_shared_project_id
      and i.accepted_by = p_user_id and i.accepted_at is not null and i.revoked_at is null
      and (
        e.invitation_id is null or e.completed_at is null or e.revoked_at is not null
        or not exists (
          select 1 from public.mingle_devices leader
          join public.mingle_devices invitee on invitee.id = e.invitee_device_id and invitee.team_id = e.team_id
          join public.mingle_device_links leader_link on leader_link.team_id = e.team_id
            and leader_link.device_id = leader.id and leader_link.peer_device_id = invitee.id
            and leader_link.peer_fingerprint = invitee.fingerprint
          join public.mingle_device_links invitee_link on invitee_link.team_id = e.team_id
            and invitee_link.device_id = invitee.id and invitee_link.peer_device_id = leader.id
            and invitee_link.peer_fingerprint = leader.fingerprint
          where leader.id = e.leader_device_id and leader.team_id = e.team_id
            and leader.owner_id = e.leader_account_id and leader.fingerprint = e.leader_fingerprint
            and invitee.owner_id = e.invited_account_id and invitee.fingerprint = e.invitee_fingerprint
            and leader.revoked_at is null and invitee.revoked_at is null
        )
      )
  );
$$;

create function public.create_mingle_project_invitation(
  p_shared_project_id uuid, p_email text, p_role text, p_leader_device_id uuid,
  p_leader_fingerprint text, p_token_hash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_project public.mingle_projects%rowtype;
  v_device public.mingle_devices%rowtype;
  v_id uuid := gen_random_uuid();
  v_expires_at timestamptz := now() + interval '7 days';
  v_target_user_id uuid;
begin
  if v_user_id is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_role not in ('member', 'admin')
    or length(v_email) < 3 or length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'invalid project invitation';
  end if;
  if not exists (select 1 from public.mingle_members m where m.team_id in
    (select p.team_id from public.mingle_projects p where p.id = p_shared_project_id)
    and m.user_id = v_user_id and m.role = 'owner' and m.revoked_at is null) then
    raise exception using errcode = '42501', message = 'only an active team leader can invite project collaborators';
  end if;
  select p.* into v_project from public.mingle_projects p where p.id = p_shared_project_id;
  if not found or v_project.repository_url is null or not exists (
    select 1 from public.mingle_project_collaboration_scopes s
      where s.team_id = v_project.team_id and s.shared_project_id = p_shared_project_id
  ) then
    raise exception using errcode = '22023', message = 'a source Git project is required';
  end if;
  select d.* into v_device from public.mingle_devices d where d.id = p_leader_device_id
    and d.team_id = v_project.team_id and d.owner_id = v_user_id and d.fingerprint = p_leader_fingerprint and d.revoked_at is null;
  if not found then raise exception using errcode = '42501', message = 'leader device is unavailable'; end if;
  select u.id into v_target_user_id from auth.users u where lower(u.email) = v_email limit 1;
  if v_target_user_id is not null and exists (select 1 from public.mingle_members m
    where m.team_id = v_project.team_id and m.user_id = v_target_user_id and m.revoked_at is null)
    and not mingle_private.can_reenroll_project_collaborator(v_project.team_id, p_shared_project_id, v_target_user_id) then
    raise exception using errcode = 'P0001', message = 'target account is already an active team member';
  end if;
  insert into public.mingle_project_invitations(
    id, team_id, shared_project_id, email, role, invited_by, leader_device_id,
    leader_fingerprint, token_hash, expires_at
  ) values (
    v_id, v_project.team_id, p_shared_project_id, v_email, p_role, v_user_id,
    p_leader_device_id, p_leader_fingerprint, p_token_hash, v_expires_at
  );
  insert into public.mingle_project_member_profiles(team_id, user_id, email, display_name)
    select v_project.team_id, u.id, lower(u.email), nullif(left(u.raw_user_meta_data->>'full_name', 200), '')
      from auth.users u where u.id = v_user_id and u.email_confirmed_at is not null
    on conflict (team_id, user_id) do update set email = excluded.email, display_name = excluded.display_name;
  return jsonb_build_object(
    'id', v_id, 'team_id', v_project.team_id, 'shared_project_id', p_shared_project_id,
    'email', v_email, 'role', p_role, 'expires_at', v_expires_at,
    'created_at', now(), 'invited_by', v_user_id
  );
end;
$$;

create function public.scope_mingle_team_to_project(p_shared_project_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_project public.mingle_projects%rowtype;
  v_existing uuid;
  v_project_count integer;
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'verified account required'; end if;
  select p.* into v_project from public.mingle_projects p where p.id = p_shared_project_id;
  if not found then raise exception using errcode = 'P0001', message = 'shared project unavailable'; end if;
  perform 1 from public.mingle_teams t where t.id = v_project.team_id for update;
  if not exists (select 1 from public.mingle_members m where m.team_id = v_project.team_id
    and m.user_id = v_user_id and m.role = 'owner' and m.revoked_at is null) then
    raise exception using errcode = '42501', message = 'only the active team leader can establish a project-first team scope';
  end if;
  select s.shared_project_id into v_existing from public.mingle_project_collaboration_scopes s
    where s.team_id = v_project.team_id for update;
  if found then
    if v_existing <> p_shared_project_id then
      raise exception using errcode = '42501', message = 'this team is already scoped to another shared project';
    end if;
    return true;
  end if;
  select count(*) into v_project_count from public.mingle_projects p where p.team_id = v_project.team_id;
  if v_project_count <> 1 or not exists (select 1 from public.mingle_projects p
    where p.team_id = v_project.team_id and p.id = p_shared_project_id and p.repository_url is not null) then
    raise exception using errcode = '42501', message = 'a project-first team must contain exactly one shareable Git project';
  end if;
  insert into public.mingle_project_collaboration_scopes(team_id, shared_project_id, created_by)
    values (v_project.team_id, p_shared_project_id, v_user_id);
  return true;
end;
$$;

create function public.rotate_mingle_project_invitation(
  p_invitation_id uuid, p_token_hash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_invitation public.mingle_project_invitations%rowtype;
begin
  if v_user_id is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;
  select i.* into v_invitation from public.mingle_project_invitations i
    where i.id = p_invitation_id and i.invited_by = v_user_id for update;
  if not found or v_invitation.revoked_at is not null or v_invitation.accepted_at is not null
    or v_invitation.expires_at <= now()
    or not exists (select 1 from public.mingle_members m where m.team_id = v_invitation.team_id
      and m.user_id = v_user_id and m.role = 'owner' and m.revoked_at is null)
    or not exists (select 1 from public.mingle_devices d where d.id = v_invitation.leader_device_id
      and d.team_id = v_invitation.team_id and d.owner_id = v_user_id
      and d.fingerprint = v_invitation.leader_fingerprint and d.revoked_at is null) then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;
  update public.mingle_project_invitations set token_hash = p_token_hash where id = v_invitation.id;
  return jsonb_build_object('id', v_invitation.id, 'expires_at', v_invitation.expires_at);
end;
$$;

create function public.claim_mingle_project_invitation_delivery(
  p_invitation_id uuid, p_token_hash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_email text;
  v_invitation public.mingle_project_invitations%rowtype;
  v_limit public.mingle_project_invitation_delivery_limits%rowtype;
  v_owner_limit public.mingle_project_invitation_owner_limits%rowtype;
  v_wait integer;
begin
  if v_user_id is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;
  select lower(u.email) into v_email from auth.users u
    where u.id = v_user_id and u.email_confirmed_at is not null;
  select i.* into v_invitation from public.mingle_project_invitations i
    where i.id = p_invitation_id for update;
  if not found or v_invitation.invited_by <> v_user_id or v_invitation.token_hash <> p_token_hash
    or v_invitation.revoked_at is not null or v_invitation.accepted_at is not null
    or v_invitation.expires_at <= now() or v_email is null
    or not exists (select 1 from public.mingle_members m where m.team_id = v_invitation.team_id
      and m.user_id = v_user_id and m.role = 'owner' and m.revoked_at is null)
    or not exists (select 1 from public.mingle_devices d where d.id = v_invitation.leader_device_id
      and d.team_id = v_invitation.team_id and d.owner_id = v_user_id
      and d.fingerprint = v_invitation.leader_fingerprint and d.revoked_at is null) then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;
  insert into public.mingle_project_invitation_owner_limits(
    team_id, invited_by, daily_window_started_at, daily_attempt_count, hourly_window_started_at, hourly_attempt_count
  ) values (v_invitation.team_id, v_user_id, now(), 0, now(), 0)
  on conflict (team_id, invited_by) do nothing;
  select l.* into v_owner_limit from public.mingle_project_invitation_owner_limits l
    where l.team_id = v_invitation.team_id and l.invited_by = v_user_id for update;
  if v_owner_limit.daily_window_started_at <= now() - interval '24 hours' then
    update public.mingle_project_invitation_owner_limits set daily_window_started_at = now(), daily_attempt_count = 0
      where team_id = v_invitation.team_id and invited_by = v_user_id;
    v_owner_limit.daily_attempt_count := 0;
    v_owner_limit.daily_window_started_at := now();
  end if;
  if v_owner_limit.hourly_window_started_at <= now() - interval '1 hour' then
    update public.mingle_project_invitation_owner_limits set hourly_window_started_at = now(), hourly_attempt_count = 0
      where team_id = v_invitation.team_id and invited_by = v_user_id;
    v_owner_limit.hourly_attempt_count := 0;
    v_owner_limit.hourly_window_started_at := now();
  end if;
  if v_owner_limit.hourly_attempt_count >= 10 then
    v_wait := greatest(1, ceil(extract(epoch from (v_owner_limit.hourly_window_started_at + interval '1 hour' - now())))::integer);
    return jsonb_build_object('claimed', false, 'reason', 'owner_hourly_limit', 'retry_after_seconds', v_wait);
  end if;
  if v_owner_limit.daily_attempt_count >= 50 then
    v_wait := greatest(1, ceil(extract(epoch from (v_owner_limit.daily_window_started_at + interval '24 hours' - now())))::integer);
    return jsonb_build_object('claimed', false, 'reason', 'owner_daily_limit', 'retry_after_seconds', v_wait);
  end if;
  insert into public.mingle_project_invitation_delivery_limits(
    team_id, invited_by, recipient_email, window_started_at, attempt_count, last_attempt_at
  ) values (v_invitation.team_id, v_user_id, v_invitation.email, now(), 0, null)
  on conflict (team_id, invited_by, recipient_email) do nothing;
  select l.* into v_limit from public.mingle_project_invitation_delivery_limits l
    where l.team_id = v_invitation.team_id and l.invited_by = v_user_id
      and l.recipient_email = v_invitation.email for update;
  if v_limit.window_started_at <= now() - interval '24 hours' then
    update public.mingle_project_invitation_delivery_limits set window_started_at = now(), attempt_count = 0, last_attempt_at = null
      where team_id = v_invitation.team_id and invited_by = v_user_id and recipient_email = v_invitation.email;
    v_limit.attempt_count := 0;
    v_limit.last_attempt_at := null;
  end if;
  if v_limit.last_attempt_at is not null and v_limit.last_attempt_at > now() - interval '60 seconds' then
    v_wait := greatest(1, ceil(extract(epoch from (v_limit.last_attempt_at + interval '60 seconds' - now())))::integer);
    return jsonb_build_object('claimed', false, 'reason', 'cooldown', 'retry_after_seconds', v_wait);
  end if;
  if v_limit.attempt_count >= 5 then
    return jsonb_build_object('claimed', false, 'reason', 'daily_limit', 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_limit.window_started_at + interval '24 hours' - now())))::integer));
  end if;
  update public.mingle_project_invitation_delivery_limits set attempt_count = attempt_count + 1, last_attempt_at = now()
    where team_id = v_invitation.team_id and invited_by = v_user_id and recipient_email = v_invitation.email;
  update public.mingle_project_invitation_owner_limits set daily_attempt_count = daily_attempt_count + 1,
    hourly_attempt_count = hourly_attempt_count + 1 where team_id = v_invitation.team_id and invited_by = v_user_id;
  return jsonb_build_object('claimed', true, 'remaining_recipient_attempts', 4 - v_limit.attempt_count,
    'remaining_hourly_attempts', 9 - v_owner_limit.hourly_attempt_count,
    'remaining_daily_attempts', 49 - v_owner_limit.daily_attempt_count);
end;
$$;

create function public.revoke_mingle_project_invitation(p_invitation_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_invitation public.mingle_project_invitations%rowtype;
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'verified account required'; end if;
  select i.* into v_invitation from public.mingle_project_invitations i
    where i.id = p_invitation_id and i.invited_by = v_user_id for update;
  if not found or v_invitation.accepted_at is not null or v_invitation.revoked_at is not null
    or not exists (select 1 from public.mingle_members m where m.team_id = v_invitation.team_id
      and m.user_id = v_user_id and m.role = 'owner' and m.revoked_at is null) then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;
  update public.mingle_project_invitations set revoked_at = now() where id = v_invitation.id;
  update public.mingle_project_invitation_enrollments set revoked_at = now()
    where invitation_id = v_invitation.id and revoked_at is null;
  return true;
end;
$$;

create function public.preview_mingle_project_invitation(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_email text;
  v_confirmed boolean;
  v_result jsonb;
begin
  if v_user_id is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;
  select lower(u.email), u.email_confirmed_at is not null into v_email, v_confirmed
    from auth.users u where u.id = v_user_id;
  if v_email is null or not coalesce(v_confirmed, false) then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;
  select jsonb_build_object(
      'invitation_id', i.id, 'team_id', i.team_id, 'shared_project_id', i.shared_project_id,
      'project_name', p.name, 'repository_url', p.repository_url, 'email', i.email,
      'role', i.role, 'expires_at', i.expires_at, 'accepted_by', i.accepted_by,
      'accepted_at', i.accepted_at, 'revoked_at', i.revoked_at,
      'invited_by', i.invited_by, 'leader_device_id', i.leader_device_id,
      'leader_fingerprint', i.leader_fingerprint
    ) into v_result
    from public.mingle_project_invitations i
    join public.mingle_projects p on p.id = i.shared_project_id and p.team_id = i.team_id
    where i.token_hash = p_token_hash and i.email = v_email
      and i.revoked_at is null and i.expires_at > now()
      and exists (select 1 from public.mingle_members m where m.team_id = i.team_id
        and m.user_id = i.invited_by and m.role = 'owner' and m.revoked_at is null)
      and exists (select 1 from public.mingle_devices d where d.id = i.leader_device_id
        and d.team_id = i.team_id and d.owner_id = i.invited_by
        and d.fingerprint = i.leader_fingerprint and d.revoked_at is null)
      and (i.accepted_at is null or i.accepted_by = v_user_id);
  if v_result is null then raise exception using errcode = 'P0001', message = 'invitation unavailable'; end if;
  return v_result;
end;
$$;

create function public.accept_mingle_project_invitation(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_email text;
  v_confirmed boolean;
  v_invitation public.mingle_project_invitations%rowtype;
  v_project public.mingle_projects%rowtype;
  v_active boolean;
  v_already boolean := false;
begin
  if v_user_id is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;
  select lower(u.email), u.email_confirmed_at is not null into v_email, v_confirmed
    from auth.users u where u.id = v_user_id;
  if v_email is null or not coalesce(v_confirmed, false) then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;
  select i.* into v_invitation from public.mingle_project_invitations i
    where i.token_hash = p_token_hash for update;
  if not found or v_invitation.email <> v_email or v_invitation.revoked_at is not null
    or v_invitation.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'invitation unavailable';
  end if;
  if v_invitation.accepted_at is not null then
    if v_invitation.accepted_by is distinct from v_user_id then
      raise exception using errcode = 'P0001', message = 'invitation unavailable';
    end if;
    v_already := true;
  else
    if not exists (select 1 from public.mingle_members m where m.team_id = v_invitation.team_id
      and m.user_id = v_invitation.invited_by and m.role = 'owner' and m.revoked_at is null)
      or not exists (select 1 from public.mingle_devices d where d.id = v_invitation.leader_device_id
        and d.team_id = v_invitation.team_id and d.owner_id = v_invitation.invited_by
        and d.fingerprint = v_invitation.leader_fingerprint and d.revoked_at is null) then
      raise exception using errcode = 'P0001', message = 'invitation unavailable';
    end if;
    select exists(select 1 from public.mingle_members m where m.team_id = v_invitation.team_id
      and m.user_id = v_user_id and m.revoked_at is null) into v_active;
    if v_active then
      if not mingle_private.can_reenroll_project_collaborator(v_invitation.team_id, v_invitation.shared_project_id, v_user_id) then
        raise exception using errcode = 'P0001', message = 'invitation unavailable';
      end if;
    else
      insert into public.mingle_members(team_id, user_id, role)
        values (v_invitation.team_id, v_user_id, v_invitation.role);
    end if;
    update public.mingle_project_invitations set accepted_at = now(), accepted_by = v_user_id
      where id = v_invitation.id;
    insert into public.mingle_project_invitation_enrollments(
      invitation_id, team_id, invited_account_id, leader_account_id, leader_device_id,
      leader_fingerprint, expires_at
    ) values (
      v_invitation.id, v_invitation.team_id, v_user_id, v_invitation.invited_by,
      v_invitation.leader_device_id, v_invitation.leader_fingerprint,
      v_invitation.expires_at
    );
  end if;
  insert into public.mingle_project_member_profiles(team_id, user_id, email, display_name)
    select v_invitation.team_id, u.id, lower(u.email), nullif(left(u.raw_user_meta_data->>'full_name', 200), '')
      from auth.users u where u.id = v_user_id and u.email_confirmed_at is not null
    on conflict (team_id, user_id) do update set email = excluded.email, display_name = excluded.display_name;
  select p.* into v_project from public.mingle_projects p
    where p.id = v_invitation.shared_project_id and p.team_id = v_invitation.team_id;
  return jsonb_build_object(
    'invitation_id', v_invitation.id, 'team_id', v_invitation.team_id,
    'shared_project_id', v_invitation.shared_project_id, 'project_name', v_project.name,
    'repository_url', v_project.repository_url, 'email', v_invitation.email,
    'role', v_invitation.role, 'expires_at', v_invitation.expires_at,
    'accepted_by', v_user_id, 'already_accepted', v_already,
    'leader_device_id', v_invitation.leader_device_id,
    'leader_fingerprint', v_invitation.leader_fingerprint
  );
end;
$$;

create function public.complete_mingle_project_invitation_enrollment(
  p_invitation_id uuid, p_invitee_device_id uuid, p_invitee_fingerprint text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := (select auth.uid());
  v_enrollment public.mingle_project_invitation_enrollments%rowtype;
  v_invitation public.mingle_project_invitations%rowtype;
  v_leader public.mingle_devices%rowtype;
  v_invitee public.mingle_devices%rowtype;
  v_link_count integer;
begin
  if v_user_id is null or p_invitee_fingerprint !~ '^SHA-256:[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invitation enrollment unavailable';
  end if;
  select e.* into v_enrollment from public.mingle_project_invitation_enrollments e
    where e.invitation_id = p_invitation_id for update;
  select i.* into v_invitation from public.mingle_project_invitations i
    where i.id = p_invitation_id;
  if not found or v_enrollment.invited_account_id <> v_user_id or v_enrollment.revoked_at is not null
    or v_invitation.accepted_by <> v_user_id or v_invitation.revoked_at is not null
    or not exists (select 1 from public.mingle_members m where m.team_id = v_enrollment.team_id
      and m.user_id = v_user_id and m.revoked_at is null)
    or not exists (select 1 from public.mingle_members m where m.team_id = v_enrollment.team_id
      and m.user_id = v_enrollment.leader_account_id and m.role = 'owner' and m.revoked_at is null) then
    raise exception using errcode = 'P0001', message = 'invitation enrollment unavailable';
  end if;
  select d.* into v_leader from public.mingle_devices d where d.id = v_enrollment.leader_device_id
    and d.team_id = v_enrollment.team_id and d.owner_id = v_enrollment.leader_account_id
    and d.fingerprint = v_enrollment.leader_fingerprint and d.revoked_at is null;
  select d.* into v_invitee from public.mingle_devices d where d.id = p_invitee_device_id
    and d.team_id = v_enrollment.team_id and d.owner_id = v_user_id
    and d.fingerprint = p_invitee_fingerprint and d.revoked_at is null;
  if v_leader.id is null or v_invitee.id is null or v_leader.id = v_invitee.id then
    raise exception using errcode = 'P0001', message = 'invitation enrollment unavailable';
  end if;
  if v_enrollment.completed_at is not null then
    if v_enrollment.invitee_device_id <> p_invitee_device_id
      or v_enrollment.invitee_fingerprint <> p_invitee_fingerprint then
      raise exception using errcode = 'P0001', message = 'invitation enrollment unavailable';
    end if;
    select count(*) into v_link_count from public.mingle_device_links l
      where l.team_id = v_enrollment.team_id and (
        (l.device_id = v_leader.id and l.peer_device_id = v_invitee.id and l.peer_fingerprint = v_invitee.fingerprint)
        or (l.device_id = v_invitee.id and l.peer_device_id = v_leader.id and l.peer_fingerprint = v_leader.fingerprint)
      );
    if v_link_count <> 2 then raise exception using errcode = 'P0001', message = 'invitation enrollment unavailable'; end if;
    return true;
  end if;
  if v_enrollment.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'invitation enrollment unavailable';
  end if;
  if v_enrollment.invitee_device_id is not null and (v_enrollment.invitee_device_id <> p_invitee_device_id
    or v_enrollment.invitee_fingerprint <> p_invitee_fingerprint) then
    raise exception using errcode = 'P0001', message = 'invitation enrollment unavailable';
  end if;
  update public.mingle_project_invitation_enrollments set invitee_device_id = p_invitee_device_id,
    invitee_fingerprint = p_invitee_fingerprint where invitation_id = p_invitation_id;
  insert into public.mingle_device_links(team_id, device_id, peer_device_id, peer_fingerprint)
    values (v_enrollment.team_id, v_leader.id, v_invitee.id, v_invitee.fingerprint)
    on conflict (team_id, device_id, peer_device_id) do nothing;
  insert into public.mingle_device_links(team_id, device_id, peer_device_id, peer_fingerprint)
    values (v_enrollment.team_id, v_invitee.id, v_leader.id, v_leader.fingerprint)
    on conflict (team_id, device_id, peer_device_id) do nothing;
  select count(*) into v_link_count from public.mingle_device_links l
    where l.team_id = v_enrollment.team_id and (
      (l.device_id = v_leader.id and l.peer_device_id = v_invitee.id and l.peer_fingerprint = v_invitee.fingerprint)
      or (l.device_id = v_invitee.id and l.peer_device_id = v_leader.id and l.peer_fingerprint = v_leader.fingerprint)
    );
  if v_link_count <> 2 then raise exception using errcode = 'P0001', message = 'invitation enrollment unavailable'; end if;
  update public.mingle_project_invitation_enrollments set completed_at = now()
    where invitation_id = p_invitation_id;
  return true;
end;
$$;

revoke all on public.mingle_project_member_profiles, public.mingle_project_invitations,
  public.mingle_project_invitation_enrollments, public.mingle_project_invitation_delivery_limits,
  public.mingle_project_invitation_owner_limits from anon, authenticated;
grant select, insert, update on public.mingle_project_member_profiles to authenticated;
grant select, insert on public.mingle_project_invitations to authenticated;
grant update (revoked_at, token_hash) on public.mingle_project_invitations to authenticated;

alter table public.mingle_project_member_profiles enable row level security;
alter table public.mingle_project_invitations enable row level security;
alter table public.mingle_project_invitation_enrollments enable row level security;

create policy mingle_project_member_profiles_read_active_member on public.mingle_project_member_profiles
  for select to authenticated using ((select mingle_private.is_active_team_member(team_id)));
create policy mingle_project_member_profiles_write_self on public.mingle_project_member_profiles
  for insert to authenticated with check (user_id = (select auth.uid())
    and (select mingle_private.is_active_team_member(team_id)));
create policy mingle_project_member_profiles_update_self on public.mingle_project_member_profiles
  for update to authenticated using (user_id = (select auth.uid())
    and (select mingle_private.is_active_team_member(team_id)))
  with check (user_id = (select auth.uid()) and (select mingle_private.is_active_team_member(team_id)));

alter table public.mingle_project_collaboration_scopes enable row level security;
revoke all on public.mingle_project_collaboration_scopes from anon, authenticated;
grant select on public.mingle_project_collaboration_scopes to authenticated;
create policy mingle_project_collaboration_scopes_read_active_member on public.mingle_project_collaboration_scopes
  for select to authenticated using ((select mingle_private.is_active_team_member(team_id)));

create policy mingle_project_invitations_read_leadership on public.mingle_project_invitations
  for select to authenticated using ((select mingle_private.has_team_role(team_id, array['owner', 'admin'])));
create policy mingle_project_invitations_create_leader on public.mingle_project_invitations
  for insert to authenticated with check (invited_by = (select auth.uid())
    and (select mingle_private.has_team_role(team_id, array['owner'])));
create policy mingle_project_invitations_revoke_leader on public.mingle_project_invitations
  for update to authenticated using (invited_by = (select auth.uid())
    and (select mingle_private.has_team_role(team_id, array['owner'])))
  with check (invited_by = (select auth.uid())
    and (select mingle_private.has_team_role(team_id, array['owner'])));

revoke all on function public.create_mingle_project_invitation(uuid, text, text, uuid, text, text) from public, anon;
revoke all on function public.rotate_mingle_project_invitation(uuid, text) from public, anon;
revoke all on function public.scope_mingle_team_to_project(uuid) from public, anon;
revoke all on function public.claim_mingle_project_invitation_delivery(uuid, text) from public, anon;
revoke all on function public.revoke_mingle_project_invitation(uuid) from public, anon;
revoke all on function public.preview_mingle_project_invitation(text) from public, anon;
revoke all on function public.accept_mingle_project_invitation(text) from public, anon;
revoke all on function public.complete_mingle_project_invitation_enrollment(uuid, uuid, text) from public, anon;
grant execute on function public.create_mingle_project_invitation(uuid, text, text, uuid, text, text) to authenticated;
grant execute on function public.rotate_mingle_project_invitation(uuid, text) to authenticated;
grant execute on function public.scope_mingle_team_to_project(uuid) to authenticated;
grant execute on function public.claim_mingle_project_invitation_delivery(uuid, text) to authenticated;
grant execute on function public.revoke_mingle_project_invitation(uuid) to authenticated;
grant execute on function public.preview_mingle_project_invitation(text) to authenticated;
grant execute on function public.accept_mingle_project_invitation(text) to authenticated;
grant execute on function public.complete_mingle_project_invitation_enrollment(uuid, uuid, text) to authenticated;

revoke all on function mingle_private.stamp_project_member_profile() from public, anon, authenticated;
revoke all on function mingle_private.stamp_project_invitation() from public, anon, authenticated;
revoke all on function mingle_private.guard_scoped_team_project() from public, anon, authenticated;
revoke all on function mingle_private.can_reenroll_project_collaborator(uuid, uuid, uuid) from public, anon, authenticated;

-- Mingle account identity is auth.users.id, never an email, local session ID or provider login.
-- No projects, repository paths, transcripts or provider credentials are uploaded by this schema.
create table public.account_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferences jsonb not null,
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  constraint account_preferences_shape check (
    jsonb_typeof(preferences) = 'object'
    and octet_length(preferences::text) <= 10000
    and preferences ?& array['theme','defaultProvider','defaultCodexModel','defaultClaudeModel','defaultEffort','autoCompactPercent']
    and preferences - array['theme','defaultProvider','defaultCodexModel','defaultClaudeModel','defaultAntigravityModel','defaultOpencodeModel','defaultEffort','autoCompactPercent'] = '{}'::jsonb
    and preferences->>'theme' in ('light','dark')
    and preferences->>'defaultProvider' in ('codex','claude','antigravity','opencode')
    and jsonb_typeof(preferences->'defaultCodexModel') = 'string'
    and length(preferences->>'defaultCodexModel') between 1 and 150
    and jsonb_typeof(preferences->'defaultClaudeModel') = 'string'
    and length(preferences->>'defaultClaudeModel') between 1 and 150
    and jsonb_typeof(preferences->'defaultEffort') = 'string'
    and length(preferences->>'defaultEffort') between 1 and 100
    and (not preferences ? 'defaultAntigravityModel' or (jsonb_typeof(preferences->'defaultAntigravityModel') = 'string' and length(preferences->>'defaultAntigravityModel') between 1 and 150))
    and (not preferences ? 'defaultOpencodeModel' or (jsonb_typeof(preferences->'defaultOpencodeModel') = 'string' and length(preferences->>'defaultOpencodeModel') between 1 and 150))
    and (preferences->'autoCompactPercent' = 'null'::jsonb or (
      jsonb_typeof(preferences->'autoCompactPercent') = 'number'
      and (preferences->>'autoCompactPercent')::numeric between 1 and 95
      and trunc((preferences->>'autoCompactPercent')::numeric) = (preferences->>'autoCompactPercent')::numeric
    ))
  )
);

alter table public.account_preferences enable row level security;
revoke all on public.account_preferences from anon, authenticated;
grant select, insert, update, delete on public.account_preferences to authenticated;
create policy "Read own preferences" on public.account_preferences for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Create own preferences" on public.account_preferences for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Update own preferences" on public.account_preferences for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Delete own preferences" on public.account_preferences for delete to authenticated
  using ((select auth.uid()) = user_id);

-- No elevated privileges. Server timestamps and revisions make concurrent saves detect stale data.
create schema if not exists mingle_private;
revoke all on schema mingle_private from public, anon, authenticated;
create function mingle_private.stamp_preferences() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 then raise exception 'Initial preference revision must be 1'; end if;
  else
    if new.user_id <> old.user_id or new.revision <> old.revision + 1 then
      raise exception 'Preference revision must advance by one';
    end if;
  end if;
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function mingle_private.stamp_preferences() from public, anon, authenticated;
create trigger stamp_preferences before insert or update on public.account_preferences
  for each row execute function mingle_private.stamp_preferences();

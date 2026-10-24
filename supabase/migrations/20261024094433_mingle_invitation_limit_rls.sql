-- Internal counters are accessed only by guarded SECURITY DEFINER RPCs.
-- Keep RLS enabled as defense in depth in the exposed public schema.
alter table public.mingle_project_invitation_delivery_limits enable row level security;
alter table public.mingle_project_invitation_owner_limits enable row level security;

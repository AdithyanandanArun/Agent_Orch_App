# Distributed teams: server API and cloud schema

This document describes the server-only team service for the distributed-workspace implementation. It is deliberately independent of the HTTP routes; the route owner wires these methods under the existing local Host/Origin guard. Cloud requests run with the signed-in user's Supabase client, never a service-role key. Local device keys and project data remain outside Supabase.

## TypeScript APIs

`apps/server/src/distributed/teams.ts` exports `TeamService`. Construct it with `{ account, changed }`, where `account` provides `snapshot()` and `withAuthenticatedClient(callback)`. `changed` is called after a successful mutation. An optional `now()` clock is available for deterministic tests.

| Method | Input | Result | Authorization |
| --- | --- | --- | --- |
| `snapshot()` | none | `Promise<TeamSnapshot>` | Re-verifies the account; returns a stable empty snapshot plus `error` if unavailable. |
| `createTeam({ name })` | `CreateTeamInput` | `Promise<Team>` | Creates the signed-in account as immutable owner. SQL inserts the owner membership in the same transaction. |
| `invite({ teamId, email, role })` | `InviteTeamMemberInput`; role is `admin` or `member` | `Promise<CreatedTeamInvitation>` | Owner/admin only. Returns public invitation metadata plus a cryptographically random bearer token exactly once. |
| `acceptInvite({ token })` | `AcceptTeamInvitationInput` | `Promise<TeamMember>` | Requires a currently verified Supabase user with a confirmed email matching the invitation; SQL atomically consumes the hash once. |
| `revokeMember({ teamId, userId })` | `RevokeTeamMemberInput` | `Promise<TeamMember>` with `revokedAt` set | Owner can revoke admin/member; admin can revoke member only. Neither may revoke the owner or itself. |
| `createProject({ teamId, name, repositoryUrl })` | `CreateTeamProjectInput`; URL may be null/omitted | `Promise<SharedTeamProject>` | Owner/admin only. URL accepts HTTPS/SSH without embedded credentials, query or fragment. |
| `assertMember(teamId)` | team UUID | `Promise<TeamMember>` | Resolves membership from the current verified account and rejects inactive/nonmembers. Call on the receiving device before any distributed action. |
| `withClient(callback)` | `(client, user) => Promise<T>` | `Promise<T>` | Uses `AccountService.withAuthenticatedClient`; keep results server-side. |

Shared public camelCase contracts live in `packages/contracts/src/teams.ts`. The stable snapshot always contains `teams`, `members`, `invitations`, `projects`, `userId`, and `configured`; `error` is present on unavailable/error states. Snapshot rows omit token hashes and show only active memberships. Invitation plaintext is never persisted or included in a later snapshot.

`AccountService.withAuthenticatedClient<T>(fn)` waits for account initialization, serializes with account sign-in/sign-out, calls Supabase `auth.getUser()` for each operation, rejects missing/anonymous/non-Google users, and invokes `fn(client, user)` only after verification. The client/session/token must not be returned to HTTP or renderer code.

## Supabase schema (migration `20261022153000_mingle_teams.sql`)

Every table is in `public`, has RLS enabled, and revokes all `anon`/`authenticated` table grants before granting only its needed operations. Authorization checks use signed-in `auth.uid()` and active `mingle_members` rows. Membership lookup functions are owned security-definer helpers in the non-exposed `mingle_private` schema, with an empty pinned search path, public/anon/authenticated execution revoked by default, and only the helpers used by RLS granted to `authenticated`; these break membership-policy recursion without trusting client metadata. The one public RPC is `accept_mingle_invitation(text)`: execution is revoked from `PUBLIC`/`anon`, granted to `authenticated`, and it verifies `auth.uid()`, confirmed Auth email, a valid unexpired hash and one-time consumption.

Cloud table columns (SQL snake_case):

- `mingle_teams(id, name, owner_id, created_at)` — immutable owner; team creation inserts its owner membership atomically.
- `mingle_members(id, team_id, user_id, role, created_at, revoked_at)` — append-only membership identity with one active `(team_id,user_id)` row. Roles are `owner`, `admin`, `member`; revoked rows remain for audit/history.
- `mingle_invitations(id, team_id, email, role, token_hash, expires_at, accepted_at, created_at)` — SHA-256 of a random 256-bit token, never the plaintext. Expiry is server-checked and capped at seven days. Invitations are accepted atomically through the RPC and can be revoked by owner/admin deletion.
- `mingle_projects(id, team_id, name, repository_url, created_at)` — shared project label and optional HTTPS/SSH repository URL only; no local path or checkout state.
- `mingle_devices(id, team_id, owner_id, name, signing_public_key, encryption_public_key, fingerprint, last_seen_at, revoked_at, created_at)` — keys are public keys; key identity fields cannot be modified after registration. The owner alone can write a heartbeat, and SQL stamps its value; an owner/admin may revoke, but an admin cannot impersonate a device heartbeat.
- `mingle_device_links(team_id, device_id, peer_device_id, peer_fingerprint, created_at)` — one explicit trust pin written by the owner of `device_id`; both devices must be active in the team and the pinned fingerprint must match. Delivery requires reciprocal rows with matching live fingerprints.
- `mingle_envelopes(id, team_id, from_device_id, to_device_id, idempotency_key, kind, ciphertext, nonce, signature, created_at, received_at, expires_at)` — ciphertext-only mailbox; unique by `(team_id, from_device_id, to_device_id, idempotency_key)`. `created_at` and `expires_at` are signed client fields preserved as supplied (the trigger never overwrites them) after validating a bounded 24-hour past / five-minute future clock skew and a maximum seven-day lifetime. `received_at` is server-stamped and is the mailbox polling/order cursor. Sender ownership is required to insert, recipient ownership to read, and either endpoint owner may delete. Both devices and members must remain active, pins must be mutual, and rows expire within at most seven days. Update is not granted; deletion is the receiver acknowledgement. The recipient query orders by `received_at`, not the signed `created_at`.

Member/device/link revocation immediately blocks envelope reads and sends through RLS. A revoked sender's queued ciphertext is no longer visible to the recipient, and no client timestamp can extend device presence, invitation lifetime, or mailbox lifetime.

## Validation

`apps/server/src/distributed/teams.test.ts` covers service-side validation, invitation hashing/expiry, verified-email requirements, role restrictions, receiver-side membership assertions, unavailable snapshot shape, and concurrent/nested authenticated-client callbacks with account-generation fencing. `supabase/tests/mingle_teams_rls.test.sql` covers table grants, nonmember isolation, membership recursion, invite replay/account binding, role restrictions, mutual pins, sender/recipient ownership, signed timestamp preservation, and revocation. The separate PGlite PostgreSQL harness passed 19 policy checks against the migration; the pgTAP suite could not be launched because the Supabase CLI is unavailable. No production schema was applied.

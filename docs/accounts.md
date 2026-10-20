# Mingle accounts and Google sign-in

Mingle remains a local application. Settings → Account connects a Google identity to a Supabase account. It does not sign in to coding providers or grant remote access to this computer. Local sessions work while signed out.

## Current deployment

- Supabase project: `xpirzwppqyvbubqwsqzi` (Mingle), Mumbai (`ap-south-1`), in the owner's selected organization. Project creation was quoted at $0/month on the Free plan; future usage and plan changes follow Supabase's billing.
- Google Cloud project: `mingle-512217`, dedicated to Mingle authentication; no paid compute or billing account was enabled as part of this setup.
- Google OAuth client: **Mingle Google sign-in**, Web application. Its client secret is held in Supabase's Google provider settings, never in application source, settings, logs or this guide.
- Google consent screen: External, **Testing**. The owner's account is an allowed test user. Additional testers must be added in Google Auth Platform → Audience before signing in. Public launch, domains, privacy policy and Google verification remain separate release work.
- The project's public URL and **publishable** key are application configuration in `apps/server/src/account/public-connection.json`. This key is intentionally distributable; database policies, not key secrecy, protect account data. Never replace it with a secret/service-role key.

Google callback URI:

```
https://xpirzwppqyvbubqwsqzi.supabase.co/auth/v1/callback
```

Supabase Authentication → URL Configuration → Redirect URLs:

```
http://127.0.0.1:*/auth/callback/**
```

The callback uses a random port and a 256-bit one-time state in its path. Supabase's redirect rule permits only the loopback host and callback path. Mingle verifies the exact path and Host, accepts a single bounded authorization code, and rejects consumed/cancelled/expired attempts. PKCE binds the authorization code to a verifier retained only in the local runtime. Requests, codes, login links and tokens are not added to workspace events.

## Session lifecycle

1. Continue with Google checks that the configured Supabase service enables Google, starts a short-lived loopback listener, and asks Supabase for a PKCE authorization URL.
2. Mingle opens the system browser using native argument arrays, with an **Open Google sign-in** fallback in Settings if opening fails. This works independently of the agent's shared Chromium browser.
3. Supabase handles Google OAuth and redirects to the one-time callback. The local runtime exchanges the code, then calls `auth.getUser()` to verify the user and Google identity. Display metadata is never used for authorization.
4. The UI receives only account ID, name/email, status and storage information. Supabase access/refresh tokens stay in the Node runtime.
5. Supabase handles refresh rotation. Sign out requests revocation of this device's Supabase session, deletes local saved tokens and clears memory. If remote revocation fails, the UI says so; it still clears this device's access. It does not sign out Google or other devices, delete files, stop coding agents, or revoke provider logins.
6. Cancel, five-minute timeout and shutdown close the callback listener and remove its verifier. Shutdown aborts network requests and waits for an active callback before releasing credential storage.

### Desktop credential storage

Electron creates a random AES-256 key protected with `safeStorage` in its user-data directory. The backend requests the unwrapped key over a private parent/child IPC channel; the channel then disconnects. It never appears in argv, environment variables, renderer state or provider children. The key file is scoped to the selected workspace data directory.

The backend stores the Supabase session as AES-256-GCM authenticated ciphertext in `account-session.enc` in the private runtime data directory, using atomic writes and mode 0600. Google provider tokens and PKCE verifiers are excluded. On Linux, `basic_text` and `unknown` storage backends are rejected. An unavailable/locked keyring or running only the Node/web server uses memory-only sign-in and displays that limitation. This is not an OS sandbox against other software running as the same user. Platform keyring behavior on macOS/Windows still needs device verification.

### Custom deployment

Settings → Account → Account connection can save a custom HTTPS Supabase URL and publishable key on this device. Sign out/cancel before changing it. A loopback HTTP Supabase URL is accepted for local development. `MINGLE_SUPABASE_URL` plus `MINGLE_SUPABASE_PUBLISHABLE_KEY` override application/device configuration and make the form read-only. Environment variables must be supplied to the runtime; `.env` is not automatically loaded. Only modern `sb_publishable_…` keys are accepted. The configuration JSON outside tracked source contains public connection information only.

## Preferences

Sync is explicit in this first version:

- **Save device preferences** uploads the current theme, default provider, per-provider model defaults, reasoning effort and auto-compact threshold.
- **Use account preferences** fetches the latest saved version, validates it, and applies it through the existing settings endpoint. Existing sessions keep their own configuration. Unsupported model/effort choices return the existing provider validation error.
- **Reload** reloads the cloud version without changing local settings. Concurrent saves use optimistic revisions; a stale save asks for reload instead of silently overwriting another device.

Only these portable fields are accepted by shared Zod schemas and the cloud table allowlist. Permission grants, workspace isolation, service tiers, executable paths, repository data, transcripts, attachments, browser profiles and coding-provider credentials are not synchronized. No background preference uploads, offline upload queue or automatic first-sign-in overwrite occurs.

Migration `supabase/migrations/20261020170423_mingle_accounts.sql` creates `public.account_preferences`, keyed by `user_id → auth.users.id`. Anonymous users have no table grants. Authenticated reads/inserts/updates/deletes require the requesting `auth.uid()` to equal the row owner. Update policies check both existing and replacement ownership. A private, security-invoker trigger assigns server timestamps and enforces revision increments. The app uses the user's Supabase session; no service-role client exists.

## Team projects foundation

Future teams and project memberships must reference the stable Supabase user UUID. Emails and Google profile metadata are display/contact fields, not membership authority. This change provides account identity and per-user preferences only. Team invitations, organization/project membership, roles, shared repositories, remote machines, presence, billing and team project policies are not implemented or implied by signing in. Local multi-agent groups are not multi-user teams. Signing out leaves local data with the same OS user; accounts do not currently partition the local SQLite workspace.

Before shared project access is added, introduce server-owned membership records, invitation acceptance and explicit role checks/RLS for every team resource. An authenticated Google account alone must never authorize access to another user's project.

## Implementation checks and limits

The workspace type checker, production web/server build and Linux/Arch package build pass. Both release checksum files verified; the checked-in Arch recipe and .SRCINFO pin the rebuilt archive. The cloud schema was queried after migration: RLS enabled, all four owner-only policies present, authenticated-only grants and timestamp/revision triggers present. Supabase's security advisor reported no findings. Public auth metadata confirms Google is enabled. Browser configuration was performed through the owner's signed-in shared browser. No paid provider tasks or automated tests were run. The owner completed real Google consent in the shared browser; Mingle reported a verified signed-in Google account. Save device preferences succeeded through the UI, and a read-only cloud query confirmed one preferences row at revision 1. Use account preferences fetched and applied that version successfully; the UI reported success with no alert or horizontal overflow at 1280×800. This does not establish desktop keyring persistence or behavior on another device.

## References

Reviewed Supabase's current changelog and Google/PKCE/redirect documentation while implementing:

- [Google social login](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [Redirect URL rules](https://supabase.com/docs/guides/auth/redirect-urls)
- [Row level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

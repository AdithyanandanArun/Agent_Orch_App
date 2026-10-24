# Project invitation acceptance — 2026-10-24

The project-first invitation flow is integrated locally on `feature/project-collaboration-integration`. Automated acceptance and live deployment are recorded separately.

| Check | Result |
| --- | --- |
| Production build | Web TypeScript/Vite and server TypeScript passed; existing Zod annotation warnings remain. |
| Full server suite | 42 files, 267 tests passed. |
| Contracts TypeScript | Passed. |
| Desktop links, preload, landing parser, Gmail SMTP, delivery handler | 21 tests passed. |
| Project collaboration browser acceptance | 8 checks passed. |
| Existing distributed workspace browser acceptance | 24 checks passed. |
| Static join-page browser acceptance | Passed, including mobile layout and fragment-only token handling. |
| HTTP/WebSocket/SQLite/Git/worktree/task/PTY smoke | Passed; no model calls. |

The two-app acceptance test runs two real local HTTP applications with separate SQLite databases and device keys. Its authenticated cloud boundary executes the actual migrations, RLS and RPCs in PGlite; messages use production encryption and signatures. It verifies exact-account preview, mutual device enrollment, one idle agent under concurrent joins, both accounts' roster visibility, private-session exclusion, changed-intent rejection, and lost-acknowledgement replay with one cloud envelope. It submits no inference.

Browser positive account/cloud/email/clone responses are labeled Example fixtures. SMTP and delivery-handler tests inject mail/account/database boundaries. They do not establish real Gmail inbox delivery, physical-device operation or native Windows handler registration.

## Integration corrections

- Accepted joins now resolve an account/device-bound project snapshot and check active membership.
- Only explicitly published local sessions enter the shared roster; own sessions render once in the combined UI.
- An upsert conflict path failed sender-hidden mailbox RLS. Plain INSERT without RETURNING preserves recipient-only reads. Only the existing envelope primary-key and idempotency-key duplicate constraints count as delivered retries; unrelated uniqueness failures stay queued. Actual PostgreSQL-policy acceptance covers this correction.
- The new contract import now follows the existing convention supported by the web compiler.

The earlier review's project-scope, enrollment-expiry, aggregate-email-limit and repository-case findings were addressed. The database enforces one project per project-first team. Independent teams may intentionally share a Git origin, without receiving access or invitation authority in another team; repository URLs are not global ownership claims. The final independent OpenCode Luna review found no remaining blocker in the corrected mailbox retry path.

## Release state

The CLI-generated migration is `supabase/migrations/20261024093221_mingle_project_collaboration.sql`; it replaces an unpublished draft filename. Deployed migration history was not changed. The live project still records only the accounts and original teams migrations. The new migration, Edge Function and static page have not been deployed by these checks.

The SMTP username and app password were saved directly in Supabase; only setting names were inspected. The matching sender address and `smtp` selection were configured. No credentials are recorded here. Set the join-page URL after that page is published and verified.

The predeployment advisor flags the existing authenticated invitation SECURITY DEFINER RPC, whose guarded authenticated execution is intentional; see [the advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable). Its password-protection notice concerns password authentication; Mingle uses Google sign-in. See [Supabase password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

Google OAuth was last verified in Testing mode. Ordinary invited-account access, real email delivery and joining on another physical device remain release checks. Earlier temporary public installers predate this feature; a new desktop build is required for invitation links. No real invitation email, paid inference or production schema mutation was part of this run. Publishing requires the owner's final permission under AGENTS.md.

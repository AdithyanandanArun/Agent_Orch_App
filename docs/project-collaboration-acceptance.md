# Project invitation acceptance — 2026-10-24

The project-first invitation flow is integrated on `main`. Automated acceptance and live deployment are recorded separately.

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
- A live wrong-account preview exposed a generic 404 incorrectly labeled “revoked”. Generic failures now show “Invitation unavailable” with account-switch/resend guidance. Switching accounts retains the pending token in memory; all eight browser checks passed again.

The earlier review's project-scope, enrollment-expiry, aggregate-email-limit and repository-case findings were addressed. The database enforces one project per project-first team. Independent teams may intentionally share a Git origin, without receiving access or invitation authority in another team; repository URLs are not global ownership claims. The final independent OpenCode Luna review found no remaining blocker in the corrected mailbox retry path.

## Release state

The collaboration migration is recorded live as `20261024094104_mingle_project_collaboration`; its local filename follows the version assigned by Supabase during deployment. A follow-up `20261024094433_mingle_invitation_limit_rls` enables RLS on the internal delivery counters, whose direct client grants remain revoked. Policy and two-app tests load both migrations. Deployed history was not rewritten.

The SMTP username and app password were saved directly in Supabase; only setting names were inspected. The matching sender address, `smtp` selection and published join-page URL are configured. No credentials are recorded here.

The predeployment advisor flags the existing authenticated invitation SECURITY DEFINER RPC, whose guarded authenticated execution is intentional; see [the advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable). Its password-protection notice concerns password authentication; Mingle uses Google sign-in. See [Supabase password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

With the owner's publication approval, the source was pushed and passed GitHub validation. The public [homepage](https://adithyanandanarun.github.io/Mingle-dev/), privacy, terms and invitation pages returned HTTP 200. Google Auth Platform now reports **In production**, using basic identity scopes. The authenticated delivery Edge Function is active; an unauthenticated request returns 401.

## Live recipient acceptance

A leader signed in through Google and sent an invitation to the sender's separate test account. Gmail accepted it, and the actual message was opened in that account's inbox. Its HTTPS link opened the published page and was passed through the registered Linux `mingle://` handler to the installed application. The URL token was consumed by the join UI.

The recipient signed in with the exact invited account, explicitly cloned the displayed public repository through the UI into a disposable checkout, selected OpenCode / GPT-6 Luna / High, and joined successfully. The installed backend contained exactly one new idle supervised session and zero provider runs. The leader's live collaboration snapshot and Teammates UI showed the accepted member and the recipient's idle agent after cloud mailbox synchronization. A test project note sent from the leader's UI also arrived in the recipient's authenticated shared-conversation snapshot.

These were two real accounts, separate SQLite stores and separate device keys on **one physical Linux computer**. They establish live Gmail receipt, installed Linux link handling, authenticated join, device enrollment and encrypted cloud roster delivery. They do not establish behavior across physical computers/networks, paid provider recovery, Windows protocol activation or desktop keyring persistence. No paid inference ran.

The Linux archive and Arch package were rebuilt with the unavailable-invitation correction. Native Debian and Windows builds use source `6d71cf3`. [Debian packaging](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40084149695) and [Windows packaging](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40084153825) passed runtime/PTY, installation, installed desktop rendering and uninstall checks. Windows protocol registration remains a manual target-device check.

The updated [temporary download release](https://github.com/AdithyanandanArun/Mingle-dev/releases/tag/temporary-downloads-20261024) contains the Debian amd64 installer, Windows x64 setup and their checksum files. The [publication workflow](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40084563368) verified all four asset names, sizes and SHA-256 digests before publishing. Earlier downloads remain available; they predate project invitation links.

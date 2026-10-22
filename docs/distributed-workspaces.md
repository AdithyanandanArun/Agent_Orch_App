# Distributed workspaces: deployment and verification runbook

Distributed coordination is opt-in. An account, team, linked device, published agent, or idle remote provider does not start a model, transfer a request, or grant authority on the destination computer. Local provider credentials and workspaces stay on their own devices. Remote work requires either durable qualifying local failure evidence or an explicit human-requested unpublished-work recovery, followed by an exact approval on the receiving device. The receiver must separately consent to provider spend and, when necessary, acting on unverified quota. Unknown quota is unavailable for automatic fallback suggestions. Push, merge, and command execution require separate owner decisions.

The loopback Mingle HTTP server remains local. Devices make outbound authenticated mailbox requests; no inbound server port or shared provider credential is required. Enrollment pins the peer fingerprint and requires reciprocal trust before messages can be delivered. Revocation blocks future delivery and invalidates pending authority.

## Deployment prerequisites and boundaries

1. Use a dedicated Supabase project for the environment. Apply the reviewed migrations before enabling distributed routes. The account-preferences migration alone does not create team, device, mailbox, or shared-project tables. Never run destructive migration/reset commands against a production project.
2. Run database verification only against a disposable local PostgreSQL/Supabase-compatible database with the Supabase `auth` schema and repository migrations loaded. The server's focused PGlite policy tests provide local PostgreSQL-compatible RLS coverage; `distributed_rls.sql` is a separate pgTAP suite for the Supabase CLI. Neither flow targets a deployed project.
3. The current Google OAuth consent screen is in Testing mode. Add each real tester's Google account in Google Auth Platform → Audience before sign-in. Public consent-screen verification and production audience are separate release prerequisites.
4. Configure only the public Supabase URL and publishable key in Mingle. Never put a service-role/secret key in the app, a client environment, a test fixture, a command line, or logs. The runtime verifies account identity with `auth.getUser()`.
5. Keep runtime device keys, credentials, outbox/inbox state, and SQLite data in the private Mingle data directory. Do not copy either device's provider config or private key files to the other device. Start with clean disposable Mingle data directories for two-device tests.

Cloud schema application, OAuth production access, two-device operation, NAT reconnect behavior, OS key storage, revocation propagation, and actual provider execution remain separate validation gates. The test suite never applies cloud migrations and never invokes a paid model.

## Twelve-step functional and security runbook

Use two independent Mingle processes and data directories, Device A and Device B, signed into distinct test accounts. Use a disposable Git project with no secrets. Record event/request IDs, device fingerprints, and commit IDs for evidence; never record invitation tokens, mailbox plaintext, account tokens, or private keys.

| # | Procedure | Required result |
|---|---|---|
| 1 | Start both devices signed out, sign in to test accounts A and B, then restart each local server. | Local work remains available while signed out; each server restores only its own verified account session. No tokens are sent to the renderer or peer. |
| 2 | On A, create a team and invite B's exact verified email. Attempt acceptance on A, accept as B, then replay the invitation. | Wrong-account acceptance and replay fail; a valid invitation is one-time and expires. A display name/email value alone never grants membership. |
| 3 | Register a device per account, compare fingerprints out-of-band, and link A→B using B's displayed fingerprint. Attempt delivery before B links A, then link B→A. | A unilateral link, a fingerprint mismatch, or a revoked device blocks delivery. Both device owners must pin each other's current keys. |
| 4 | Create a shared project and bind each device to a different existing local project. Attempt a cross-account binding and supply a peer-provided filesystem path. | Team membership and local project binding are checked on every operation. Peer paths and URLs cannot select a local folder or cause a clone. |
| 5 | Send a shared message from A to B with an idempotency key; synchronize twice, restart B, and synchronize again. Reply from B, revoke a device, and retry. | B receives one durable message; ciphertext, not plaintext, is stored in the cloud. Sender attribution comes from authenticated device identity. Duplicate sync/restart does not repeat delivery; handler failure stays retryable; revocation blocks later delivery. |
| 6 | Publish an explicit idle roster from B. Send routine work from A without qualifying failure evidence or a human recovery action. | Routine work stays local. Publishing or seeing an agent online never starts inference or transfers work. |
| 7 | Record a current provider-unavailable/quota-exhausted run on A and propose fallback. Repeat with unknown quota, generic failure, stale evidence, and available local alternatives. | Only current qualifying evidence can produce an automatic suggestion. Unknown/stale quota and local alternatives that are available, busy, or unknown prevent automatic fallback. |
| 8 | Create an eligible request. Try to approve on A while B owns the target; then decide on B with missing/stale digest, without spend consent, and with unverified quota disallowed. Finally approve exact consent on B. | A cannot decide for B. B checks account/device ownership, project binding, agent/model, immutable digest, quota evidence, and explicit spend consent locally. A decision is consumed once; peer approval messages are not accepted. |
| 9 | Restart around an outbox send and after a durable remote dispatch reservation. Redeliver envelopes and reorder messages; make a handler fail once. | Outbox delivery retries without duplicate execution, duplicate/replay payload changes reject, ordering is deterministic or explicitly surfaced, and uncertain dispatched work is not automatically started again. |
| 10 | In disposable repos, create an unpublished source commit and target working-tree edits. Transfer the bundle, review/approve its digest on both devices, and inspect target state. Try stale HEAD, conflicting branch, invalid bundle/ref, and payload mutation. | The bundle imports under an isolated Mingle ref. Target HEAD, working files, index, and branches are not overwritten. Push/merge remain separate owner-approved operations. |
| 11 | Request an allowed structured Git inspection, then try shell metacharacters, absolute executables, `..`/absolute/backslash/symlink cwd escapes, and shell/interpreter operations. | Only the fixed read-only Git operation union runs in the bound project after receiver approval. Shell parsing/interpolation, arbitrary scripts, interpreters, peer-selected cwd/executable, and path escapes are rejected. This is restricted process execution, not an OS sandbox. |
| 12 | Review the timeline on both devices after message, approval, revocation, Git, and command success/failure. Search event payloads for tokens, invitation material, private keys, plaintext, provider credentials, and command output. | Outcomes, owner/device identity, denial, failure, interruption, and uncertainty are durable and truthful. Audit payloads contain bounded public metadata only. |

These steps are acceptance procedures, not proof of deployed cloud schema, production OAuth, or successful provider execution.

## Automated verification

From the repository root after distributed service modules have been integrated, run the focused two-device execution integration test:

```sh
pnpm --filter @mingle/server exec vitest run src/distributed/integration.test.ts
```

The integration file exercises the real remote execution service with separate local SQLite stores, a two-account cloud-query boundary, a deterministic two-device message boundary, and injected runtimes. It covers message attribution and duplicate delivery, failure-evidence/local-first eligibility, request idempotency, immutable digest checks, receiving-owner-only spend/quota consent, one-time dispatch, restart replay, and revocation. The injected transport is not an encryption test and must not be described as a deployed mailbox. The separate `transport.test.ts`, `git.test.ts`, and `commands.test.ts` suites exercise their production service classes, including cryptographic transport, temporary Git repositories, and typed read-only commands. None invokes a paid provider, and the integration test must fail rather than skip if a required service module is missing.

Run `supabase/tests/distributed_rls.sql` with the disposable Supabase database runner after applying the account and team migrations. Its 30 pgTAP assertions use `authenticated` JWT claims and cover membership/invitation constraints (including expiry and replay), device ownership, reciprocal fingerprint pins, mailbox sender/recipient authorization, and revocation. The local PGlite policy checks currently pass 30 assertions against the migrations, including invitation expiry and admin-role revocation constraints; that verifies local PostgreSQL-compatible policy behavior but does not establish deployed Supabase behavior. No production migration is run by either suite.

## Initial integration verification (2026-10-22)

All six OpenCode Luna implementation workers were integrated locally. The focused distributed suite passes 43 tests across eight files, including 25 real PostgreSQL-compatible assertions within the policy test. The full backend suite passes 240 tests across 34 files. UI client tests pass four checks. Workspace typechecks and the production build pass. No automated check invokes paid inference.

A browser acceptance run against a temporary, clearly labelled example workspace verifies the signed-out account action, explicit device IDs and reciprocal-link display, the actual ownership/assignment graph, provider/quota consent gating, progress sharing off by default, exact displayed-digest execution/Git payloads, and a 900px layout without page overflow or runtime errors. Team snapshots and approval responses for the positive UI scenarios are intercepted example fixtures; the signed-out response comes from the running local service. These checks do not establish live cloud or physical-device operation.

Mailbox polling and visible team snapshot refresh use five-second intervals. Already-shared local tasks and published agent metadata refresh periodically without inference; unpublished tasks remain local. Remote provider text/results are shared only after explicit receiving-owner consent. Recovery fails closed if the fresh source checkpoint cannot be captured, if uncommitted source edits remain, or if the destination lacks the source commits or has local edits.

## Current validation limits

- The team/mailbox schema is local source only until separately reviewed and deployed to the selected Supabase project.
- Actual device keyring behavior, reciprocal links, cloud RLS behavior, offline mailbox retries, NAT behavior, and revocation propagation require real cloud/device validation.
- Remote approval tests use an injected runtime; no provider process or inference runs in automated checks.
- The receiving device's displayed consent and provider-side spend metering are not equivalent: the request records explicit one-run authorization, while provider billing remains provider-controlled.

## Follow-up acceptance verification

Four OpenCode GPT-6 Luna high workers tested the browser, composed encrypted two-device services, Git/command/policy boundaries, and production recovery retries. Reproduced fixes and repeatable commands are recorded in [distributed acceptance verification](distributed-acceptance.md).

The complete backend regression now passes 256 tests across 38 files. The browser acceptance harness passes 24 checks from the integrated checkout, UI API/view-model checks pass four tests, and workspace typecheck, production build and the real-process smoke test pass. The new two-application HTTP acceptance combines real snapshots, approvals, encrypted persistent mailboxes, bounded multi-chunk Git transfer, isolated import, separately approved merge, fresh checkpoint capture, destination Git checks and exactly one injected provider run. No real provider executable or inference runs. That initial run left the cloud team/device/mailbox schema undeployed. A later corrective live pass applied the reviewed migration and verified actual team creation and roster loading; see the corrective live verification in the acceptance report. Multi-account and physical-device acceptance remains outstanding.

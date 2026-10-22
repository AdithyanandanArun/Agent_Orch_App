# Distributed acceptance verification

This verification exercises the distributed stage across browser interactions, complete local HTTP applications, encrypted device transport, persistent SQLite stores, real disposable Git repositories, restricted Git processes, and PostgreSQL-compatible policies. Test accounts, relay responses and injected provider runtimes are explicitly fixtures. No test invokes provider inference, reads private developer credentials, applies cloud SQL, installs the desktop app, or pushes to a public remote.

## Reproduce

From the repository root:

```sh
pnpm typecheck
pnpm build
pnpm --filter @mingle/server exec vitest run --maxWorkers=2 --pool=forks
node --test apps/web/src/components/distributed/*.test.mjs
node scripts/distributed-browser-acceptance.mjs
pnpm smoke
```

The browser harness uses disposable runtime data and explicitly labelled example snapshots for cloud-backed positive UI scenarios. Its signed-out path uses the actual local account service. Reserve local ports 4310 and 4451 for it. It requires an available Chromium executable; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an existing installation. It never silently installs a browser or uses a signed-in user profile.

## Recorded results (2026-10-22)

Four OpenCode GPT-6 Luna high workers reproduced failures, implemented fixes in isolated worktrees, and committed their changes. The orchestrator reviewed/integrated them and reran acceptance from the main checkout.

| Check | Result |
|---|---|
| Full backend regression | 256 passed across 38 files |
| Updated complete two-application HTTP workflow | Passed, including real snapshot routes and exactly one injected provider run |
| Browser acceptance from integrated checkout | 24 passed, 0 failed |
| UI API/view-model checks | 4 passed |
| Actual migration in local PGlite | 30 policy assertions passed within the policy test |
| Workspace typecheck, including desktop entry points | Passed |
| Production build | Passed |
| Real-process HTTP/WebSocket, PTY, Git/worktree and restart smoke | Passed |

Browser checks exercise all seven sections, keyboard form submissions, message/task publication, exact approval payloads, stale consent, wrong-device actions, delayed team/account responses, restricted command controls and 900px/desktop layouts. The final map rendered nine visible nodes and eight edges, including the explicit cross-device dependency. An ambiguous native task ID on a third device remains unlinked, and both device-scoped task rows remain distinct. A timestamp-only refresh preserved the map node instance. The shared T3 preview snapshot timed out twice, so the worker used preinstalled Playwright Chromium; the parent reran that committed harness successfully.

Session evidence is outside tracked source: `/tmp/mingle-rigor-full-server.log`, `/tmp/mingle-rigor-facade-green.log`, `/tmp/mingle-rigor-final-browser.log`, `/tmp/mingle-rigor-final-typecheck.log`, `/tmp/mingle-rigor-final-build.log`, `/tmp/mingle-rigor-final-web-typecheck.log`, `/tmp/mingle-rigor-final-web-build.log`, and `/tmp/mingle-rigor-smoke.log`. The final browser artifacts are in `/tmp/mingle-distributed-browser-acceptance-112362/`. Temporary test servers and browsers were stopped.

## Cross-layer regressions

- The progress adapter must report the approved recovery run's completion even when a subsequent local run starts before the coalesced progress read. A real application/runtime/SQLite regression holds only the 500 ms coalescer to reproduce this ordering deterministically. The observer follows the next durable run after subscription rather than whichever run is newest when the timer fires.
- The native approval HTTP route must retain destination-owner checks for remote work. A pending real runtime approval remains pending when the caller lacks that authority; interruption denies it rather than executing it.
- Execution listeners must allow authenticated Git and command messages to reach their respective handlers, while continuing to reject peer-supplied execution decisions.
- Binary Git chunks must fit the transport limit after base64 and JSON encoding. The bundle remains bounded at 16 MiB; 128 KiB binary chunks fit the 256 KiB plaintext envelope budget and require at most 128 chunks.
- Repeating recovery with freshly captured equivalent checkpoints must preserve the first approval digest and request payload. Changed instructions, source HEAD, task or configuration still reject. The same message key cannot be reused for a different message kind, conversation content, Git operation or command intent.
- Browser approval consent must reset when its digest, owner, device or account changes. Team switches and failed/late polls cannot keep another team's requests actionable. Member management controls follow the reported team role, and invitation states come from acceptance/expiry timestamps.
- Map node measurement must survive unrelated UI updates. Heartbeat timestamps are excluded from the graph identity so they cannot repeatedly reset the user's viewport. Explicit dependency IDs resolve within the team/project, prefer the originating device, and link across devices only when unique. Task list keys include the device/project scope to prevent collisions between independent native task IDs.

`facade-http.acceptance.test.ts` runs two complete local applications with separate data directories. Their verified-account/cloud boundary is replaced with an authenticated local relay fixture, and their provider boundary uses `FakeProviders`. Real HTTP routes, service composition, encrypted persistent mailboxes, repository locks, Git inspection processes, and a multi-chunk bundle are exercised together. A separate source approval, receiving approval, isolated import, and exact local merge decision are required. Before merge, the destination HEAD and working files remain unchanged.

The same test then publishes an explicit Supervised receiving session and requests human recovery of committed unpublished work. Production checkpoint capture, destination Git verification, approval routes, `SessionRuntime`, and completion reporting run together. Retry must retain the original request identity despite fresh checkpoint IDs. Missing spend consent and duplicate decisions cannot invoke the provider boundary. Exactly one local fake run completes after exact owner consent; no provider executable or paid inference runs.

`two-device.acceptance.test.ts` separately composes production transport and recovery services with independent persistent state and an injected controllable provider boundary. This does not prove actual provider execution or cloud authorization.

## Cloud boundary

A read-only inspection of the connected **Mingle** Supabase project on 2026-10-22 found only `public.account_preferences` in the public schema. The team/device/mailbox migration is absent there. No cloud schema or account settings were modified during this verification.

PGlite checks execute the actual migration and PostgreSQL-compatible RLS locally. The local relay fixture deliberately models authenticated accounts, membership, ownership and reciprocal device pins; it is not a deployed Supabase or PostgREST server. The browser's positive cloud fixtures do not establish live team collaboration.

Live acceptance still requires the reviewed migration in the chosen environment, two independently signed-in accounts, two physical computers on different networks, actual OAuth/session storage, real offline/reconnect behavior, and an explicitly approved provider recovery. Follow [the deployment runbook](distributed-workspaces.md) for those procedures.

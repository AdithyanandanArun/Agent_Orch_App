# Mingle project context

Handoff updated **2026-10-23**. This file summarizes the integrated project for a new developer or coding agent. [ONBOARDING.md](ONBOARDING.md) covers setup; [AGENTS.md](AGENTS.md) supplies contributor instructions. Source and dated validation records take precedence over older roadmap prose.

## Product and operating principles

Mingle is an original local development environment for independent coding-agent sessions and collaboration. The product title is **Mingle**; the repository is [Mingle-dev](https://github.com/AdithyanandanArun/Mingle-dev). Historical Relay identifiers remain where needed for database, worktree and conversation continuity. T3 Code is an architectural/UX research reference, never a source-code dependency or code to copy.

The local application owns workspace state, Git isolation, tasks, approvals and events. Provider runtimes own their conversations and credentials. The UI must show actual availability, failures, task states and progress; example workspaces and fixture data must be labeled.

Local work is the default. Remote provider execution is exceptional recovery, not routine scheduling onto another person's available computer. Automatic recovery suggestions require qualifying durable quota/provider-failure evidence and exhausted eligible local alternatives. Explicit recovery of unpublished committed work is human-requested. Every receiving device owner controls execution and provider spending; pushing or merging code requires separate approval.

## Repository map

| Location | Responsibility |
| --- | --- |
| `apps/web/src/` | React/TypeScript/Vite UI, workspace store, API client and distributed settings/views. |
| `apps/server/src/app.ts`, `config.ts`, `db.ts` | Local application composition, loopback configuration and SQLite persistence. |
| `apps/server/src/runtime.ts` | Session/run lifecycle, events and approvals. |
| `apps/server/src/providers/` | Codex, Claude, OpenCode and Antigravity runtime adapters and discovery. |
| `apps/server/src/groups/`, `team-mcp.ts` | Local group scheduling, shared conversations and scoped agent tools. |
| `apps/server/src/recovery/` | Local checkpoint and quota/failure recovery support. |
| `apps/server/src/distributed/` | Teams, encrypted transport, remote recovery, controlled Git and commands. |
| `apps/server/src/account/` | Verified account identity, public connection configuration and credential vault boundary. |
| `apps/server/src/browser/` | Shared Chromium host and run-scoped browser access. |
| `packages/contracts/src/` | Shared TypeScript interfaces and Zod validation schemas. Start with `index.ts`. |
| `apps/desktop/` | Electron wrapper, local server lifecycle and secure-storage IPC. |
| `supabase/migrations/`, `supabase/tests/` | Account/team cloud schema, RLS and policy checks. |
| `scripts/`, `packaging/`, `.github/workflows/` | Smoke/browser checks, native package staging, installers and CI/publication. |

The stack is React, TypeScript, Vite, Node, WebSockets, SQLite and Electron. The server binds to loopback; distributed transport uses outbound authenticated cloud mailboxes. Opening an inbound local API port is not the team protocol.

## Integrated behavior

Local sessions persist messages, provider conversation IDs, tool activity, approvals, tasks and saved run diffs. Git worktrees separate session edits by default. Local groups support Cowork, a separate orchestrator, or an existing agent as lead; scoped tools carry assignments, progress and committed artifact references. Plans, questions, attachments, file context, repository controls, project tracking and a shared browser are implemented. Provider-specific capability limits remain explicit.

The distributed stage implements the requested scope below. Implementation and fixture acceptance do not establish full live multi-device acceptance.

| Requested capability | Priority | Integrated implementation |
| --- | --- | --- |
| Team workspaces | P0 | Verified-account teams, invitations, roles and shared projects. |
| Device linking | P0 | Device identity, reciprocal fingerprint pins and encrypted/signed envelopes. |
| Cross-device agents | P0 | Explicitly published Claude/Codex/OpenCode roster with local project/session binding. |
| Shared conversations | P0 | Shared messages/tasks and consented recovery progress/results. |
| Remote task delegation | P0 | Recovery requests with evidence, immutable digest and receiving-owner approval. |
| Token/quota fallback | P0 | Local-first eligibility and recovery proposals; unknown quota is surfaced. |
| Permission system | P0 | Exact local owner decisions, spend/quota consent and separate Git approvals. |
| Cross-device Git sync | P0 | Bounded bundles, separate source/import consent, isolated refs, conflict inspection and controlled merge/push. |
| Remote commands | P1 | Approved typed read-only Git inspection operations with scope checks and audit records. |
| Availability/load balancing | P1 | Published online/busy/idle/capability/quota information and assignment guidance; remote execution still follows recovery policy. |
| Disconnection recovery | P0 | Durable inbox/outbox, reconnect/retry and duplicate suppression; uncertain dispatches are not replayed automatically. |
| Shared agent map | P1 | Developer/device/agent/task/dependency visualization with scoped identities. |

Git conflict inspection is conservative and may require manual review where textual merging could succeed. The restricted command runner and Git worktrees are not OS sandboxes. See [distributed implementation plan](docs/distributed-implementation-plan.md), [implementation contract](docs/implementation-contract.md), and [acceptance report](docs/distributed-acceptance.md).

## Cloud and account status

Google sign-in uses Supabase PKCE and verified identity. Account preferences synchronize only an allowlist of portable defaults. The Google consent screen was last verified in Testing mode, so additional testers need deployment-owner access. Provider authentication remains local and separate.

The dedicated Mingle deployment has both reviewed migrations recorded:

- `supabase/migrations/20261020170423_mingle_accounts.sql`
- `supabase/migrations/20261022100932_mingle_teams.sql`

On 2026-10-22, a missing team deployment was reproduced in the installed app, corrected, and verified through actual team creation and owner-roster loading after reload using Supabase/PostgREST. This is one-account live evidence. Two-account invitation acceptance, physical devices on different networks, cloud mailbox delivery/revocation propagation and live remote provider recovery still need acceptance. The automated tests never apply production migrations.

Electron uses OS-protected key material and authenticated encrypted account storage when secure storage is available. Node/web-only runtimes and desktops without a usable keyring retain sign-in in memory until exit. Cross-platform keyring/session persistence needs device verification. Switching Mingle accounts does not partition the local SQLite workspace or remove local data on sign-out. See [accounts](docs/accounts.md) and [corrective live verification](docs/distributed-acceptance.md#corrective-live-team-verification-2026-10-22).

## Desktop builds and GitHub evidence

The app is version **0.1.0**. Linux/Windows packaging stages Electron, a checksum-pinned official Node runtime, the web UI and backend. Provider tools remain separate. Package creation and publication are distinct actions.

| Check | Recorded result and evidence |
| --- | --- |
| Integrated validation at source `74095d7` | [Passed: typecheck, backend tests, build and smoke](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/39812465484). |
| Debian native packaging | [Passed on Ubuntu 22.04](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/39784288177): runtime, terminal, install, desktop rendering and removal checks. |
| Windows native packaging | [Passed on Windows Server 2022](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/39792501063): runtime/ConPTY, silent install, installed desktop rendering and uninstall checks. |
| Temporary release verification | [Passed](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/39812481457): native build evidence plus all four asset names, sizes and SHA-256 digests. |
| Distributed acceptance | [Recorded local, browser and live evidence](docs/distributed-acceptance.md), with fixtures and remaining live gates identified. |

The [temporary prerelease](https://github.com/AdithyanandanArun/Mingle-dev/releases/tag/temporary-downloads-20261022) contains `.deb`, `.exe` and checksum files. It was published for downloads and may be removed after the owner's confirmation. Do not delete it merely to clear old failed workflow history. Windows signing, automatic updates and public AUR publication remain unfinished. macOS distribution is unverified.

Earlier red publication runs are historical failures. The last failure used an API lookup that did not find the draft after upload. The corrected workflow uses draft-aware inspection. Publication reruns verify an existing prerelease without overwriting its assets; mismatches fail. Creating the tag/draft is an owner step. See [desktop distribution](docs/desktop-distribution.md).

## Continuing development

Read the [implementation contract](docs/implementation-contract.md) and [shared contracts](packages/contracts/src/index.ts) before implementing. Follow [AGENTS.md](AGENTS.md), keep each worker's edits/commits scoped to owned paths, use the configured Git identity, and obtain permission before pushing or publishing. Older worker branches can contain superseded or already cherry-picked work; do not merge all branches indiscriminately.

Normal checks are `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm smoke`. For distributed UI changes, include the committed view-model tests and browser acceptance harness in [ONBOARDING.md](ONBOARDING.md#verify-a-change). Automated checks must not run paid inference. Keep runtime data, databases, credentials, logs, browser profiles and device keys outside tracked source; `.env` is not loaded automatically.

Priorities for the next validation stage:

1. Complete the [two-device runbook](docs/distributed-workspaces.md) with distinct confirmed accounts and physical computers on different networks. Record observed outcomes separately from local fixture results.
2. Verify invitation expiry/replay and roles through the live API, reciprocal device linking, encrypted mailbox delivery, offline/reconnect recovery, duplicate suppression and revocation.
3. With explicit permission for provider use, verify one exact-owner-approved remote recovery, including local-alternative exhaustion, committed Git preparation, destination approval and progress/result delivery.
4. Verify secure session persistence and installer behavior on real target desktops, then address signing/update delivery and wider OAuth availability before public launch.

Historical architecture, roadmap and validation documents describe earlier stages. For current deployment claims, use the corrective live section in the distributed acceptance report and the dated desktop checks above.

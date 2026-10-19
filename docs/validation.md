# Foundation validation — 2026-10-19

This records the first implementation's observed behavior. It is not evidence that the distributed product or the full two-provider feature-integration demo is complete.

## Automated checks

Validated locally with Node 26.8.2 and pnpm 11.26.0:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | All workspace packages pass, including the Electron entry points. |
| `pnpm test` | 117 tests pass across 14 files. No model calls. |
| `pnpm build` | Web production build and runtime type check pass. |
| `pnpm smoke` | A real HTTP/WS server, SQLite process restart, isolated worktree edits, Git diffs, task dependencies, origin/path rejection and native PTY pass. No model calls. |
| `git diff --check` | Clean. |

The provider tests cover JSON-RPC handshakes, resume errors, streamed items, approval responses, interruption and escalation against fake children and a real fixture process. Server tests cover durable state, recovery, task graphs, file boundaries, approvals, concurrent requests, worktrees and terminal ownership.

Integration regressions additionally check snapshot/delta overlap, message offsets, retained handoff context after provider setup failure, session locking while an interrupted adapter is still cleaning up, explicit terminal startup errors and capacity reservations during concurrent starts.

## Manual application checks

The T3 collaborative browser was used against both the development UI and the built UI served by the local runtime:

- Created an isolated session and assigned it a new task through the actual forms.
- Opened a real file in Monaco, edited it and saved with Ctrl+S. Confirmed the file and Git diff through the API, then restored the original fixture content and reloaded the editor.
- Started the xterm terminal, sent a shell command and observed its actual output. Stopped the shell afterward.
- Selected an agent-map node and opened its actions; opened the keyboard command menu.
- Switched light/dark themes and restored dark; checked the 900px layout for page overflow.
- Recorded a handoff through the UI. Confirmed a full committed revision and durable receiving message in the Claude session without starting inference.
- Checked the production content-security policy and bundled Monaco workers in the browser.

A real Codex session using `gpt-6-luna` at high effort completed two small verification turns. The second turn resumed the same provider conversation identifier and recalled a word from the first turn. Both prompts requested no tools or file changes.

The Electron 44.9.0 development launcher was smoke-tested under a temporary Xvfb display and profile. Its renderer connected to the local server over WebSocket and the compiled UI was served. After terminating the test process group, the backend port closed within the bounded shutdown wait. The headless smoke invocation used `--no-sandbox`; the launcher does not add that flag for normal use. Packaged installers and desktop window-close automation were not tested.

## Corrections made during integration

- Prevented a second writer entering a session while an interrupted provider was still cleaning up.
- Kept handed-off context available for retry after failed or interrupted runs.
- Made streamed text idempotent against overlapping bootstrap snapshots.
- Added terminal error frames and reserved capacity before awaiting native terminal creation.
- Fixed a React update loop in the new-task form and development hot-refresh initialization.
- Corrected unsupported content-security policy source entries observed by the browser.

## Remaining limits

The initial Claude adapter was checked against SDK fixtures, not a live API turn: `ANTHROPIC_API_KEY` was absent. The subsequent local-login correction removes that API-key requirement and delegates authentication to Claude Code. A read-only CLI auth-status check found an existing Claude subscription login on the development machine. The running server's provider-refresh endpoint returned HTTP 200 and Claude `available: true` using `/home/adithyan/.npm-global/bin/claude` 2.1.292. Workspace type checking and the web production build passed. Existing authentication expectations were updated; the test suite and live model turns were not run for this correction. Remaining quota is unverified.

Remote computer membership, distributed delivery, voice, browser control leases, automatic scheduling, automatic integration and signed desktop releases remain future milestones. Real multi-agent speedup, quality and total task cost have not yet been benchmarked. The next decisive product test remains an integrated feature built by two independent providers against a versioned contract.

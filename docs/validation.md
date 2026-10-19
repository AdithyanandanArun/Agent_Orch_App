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

## Screenshot-directed design pass — 2026-10-19

Implemented the user's supplied design reference with neutral surfaces, white emphasis, rare blue accents, soft user bubbles, plain assistant responses without provider icons, and shared custom choice popovers. Settings is a full workspace page with General, Providers and Appearance sections. The sidebar, composer, dialogs, task assignment controls and activity filters follow the same design language.

- Workspace type checking passed after the final keyboard-focus corrections.
- Production build passed, including the server type check.
- Git whitespace checks passed.
- Native collaborative-browser screenshots were available for this pass. Inspected the actual conversation with existing messages, the full Settings page and its open model-choice popover; assistant response markup has no provider avatar or repeated model header.
- A read-only implementation review identified menu ArrowUp entry and Settings-page focus handoff issues. Both were corrected; menu Tab dismissal also restores the anchor before normal tab navigation.
- Existing application data and saved provider/model/effort preferences were retained. No model calls or synthetic production conversations were created for the design review.

Automated tests and paid/live provider turns were not run for this design pass. This evidence describes compilation and visual inspection, not exhaustive interaction or accessibility validation.


## Session context menu — 2026-10-19

- Workspace type checking and the production build passed after integration, including the server type check.
- Git whitespace checks passed.
- Reviewed the session action menu, Copy submenu and Project settings in the native collaborative browser. Keyboard menu entry focuses the first action. The Rename dialog receives the right-clicked row's name and focuses its input without selecting that conversation; the dialog was dismissed without saving.
- Corrected initial menu focus after hidden positioning, focus restoration when pinning changes groups, and project Settings focus/context handling.
- Pin/unread persistence uses schema migration 2 with default-false columns. The implementation preserves activity timestamps for organization changes and retains active-run/cleanup restrictions for run settings and archive.

Automated tests, persistence/restart exercises, clipboard writes, project renames, archive operations and live model calls were not run for this change. Browser review opened and dismissed UI surfaces without changing session or project data.


## Desktop and Arch packaging — 2026-10-19

Implemented a standalone Linux x86-64 Electron release and an Arch `relay-workspace-bin` package. The desktop launches its compiled backend using a pinned, checksum-verified official Node runtime, serves the bundled UI, and keeps user data outside its installation directory. Production dependencies deploy in an isolated workspace; symbolic links are constrained to the release and installer bookkeeping is omitted. Frontend and backend dependency license/notice files accompany the release.

- Workspace type checking passed, including the Electron entry-point syntax checks.
- The UI production build, server compilation/bundling, standalone archive creation and Arch `makepkg` packaging completed successfully. The combined `pnpm package:arch` command completed before the final notice-inventory addition; the standalone and Arch build steps were subsequently rebuilt with that addition.
- `makepkg` accepted the pinned source checksum. Package metadata and archive contents were inspected, including the root-owned mode-4755 Chromium sandbox helper, command symlink and desktop entry.
- The Arch recipe passes Bash syntax checking and `.SRCINFO` generation. The Git whitespace check passed.
- A manual GitHub workflow was added to build downloadable artifacts; the hosted workflow has not been executed.

No automated tests, package installation, packaged application launch, clean-machine/restart exercise or live provider calls were run for this change. The unsigned package is a local build, not a published GitHub release or an AUR registration. Relay's project license remains unspecified; it must be selected before publishing the package. The development checkout's `.relay` data was not copied into the desktop user-data directory.

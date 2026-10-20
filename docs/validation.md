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

Remote computer membership, distributed delivery, voice, distributed browser control leases, automatic scheduling, automatic integration and signed desktop releases remain future milestones. Real multi-agent speedup, quality and total task cost have not yet been benchmarked. The next decisive product test remains an integrated feature built by two independent providers against a versioned contract.

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

## Structured tool activity and run timing — 2026-10-19

Added durable run records and tool lifecycle records through additive schema migration 3. Codex app-server items/output deltas and Claude SDK tool-use/result/progress messages now feed compact activity disclosures with counts, live elapsed time, final duration and expandable details. Only provider-reported parent links create nesting; this is not a complete operating-system process monitor.

- Workspace type checking passed after final integration, including existing provider assertions updated to the new event contract and Electron entry-point syntax checks.
- Production web build and server compilation passed.
- The final `pnpm package:arch` command completed successfully with these changes. The standalone archive and Arch package were rebuilt locally, and the checked-in Arch recipe/`.SRCINFO` were updated to the new archive checksum. Bash syntax checking and `.SRCINFO` generation passed.
- The running local server returned healthy bootstrap responses containing the new run/tool collections. Source review covered stable invocation IDs, progress deduplication, bounded/redacted captured output, interrupted-run recovery, nested disclosure events and stale detail-request handling.
- Native collaborative-browser snapshots failed during final inspection. The available conversation initially had no structured tool history, so the new populated activity tree was not visually verified against a live provider run.

No automated tests, paid/live provider calls, synthetic production conversations, package installation or packaged application launch were performed for this change. Existing text-only history has no recoverable invocation identity, duration or parent metadata; its available output is grouped without inventing that information. Interrupted runs recovered after a server restart have unknown elapsed duration. Per-run detail loading is limited to 1,000 calls; captured output is bounded and truncation is labeled.

## Provider controls, commands and skills — 2026-10-19

Added capability-driven effort, speed and permission controls, saved defaults, command/skill completion, native skill dispatch and schema migration 4 for service tiers. The exact provider mappings and remaining client features are recorded in provider-feature-parity.md.

- Workspace type checking passed; the final production web build, server compilation and `pnpm package:arch` completed successfully. Existing protocol fixtures/assertions were aligned with the new metadata requests; no new test cases were added and no automated tests were run.
- Read-only native discovery returned seven Codex models and twelve Claude SDK model entries with supported effort/tier metadata and canonical aliases. Codex's session catalog returned five installed skills. The final Claude metadata-only catalog probe returned 64 commands and twelve skills without submitting a user message or model turn.
- Review/probing caught an SDK lifecycle issue: an immediately exhausted prompt iterator allowed the CLI to close before a fresh skill-control request. Metadata discovery now holds an open iterator yielding no messages, enforces a deadline, and aborts/closes it afterward. Command discovery survives an unsupported skill reload with a notice.
- In the native collaborative browser, inspected the permission popup and combined reasoning/speed popup. DOM inspection confirmed separate current-effort/current-tier selections, actual default badges and the compact option list. Typing `/` exposed eleven Relay actions; typing `$` exposed the five real Codex skills. These temporary drafts were cleared without sending a message. Transient proxy/WebSocket errors occurred during development server hot restarts; the settled local API returned healthy schema-4 state and zero active runs.
- The final standalone and Arch artifact checksums passed. The checked-in Arch source checksum and `.SRCINFO` match the rebuilt archive; recipe Bash syntax checking and `.SRCINFO` generation passed.

No inference, automatic-review request, provider skill execution, Fast-mode turn, package installation or packaged launch was performed for this change. Capability metadata is verified; end-to-end provider execution of the new settings remains unverified. Claude personal settings/skills are excluded by the current project-settings boundary. Full access deliberately changes native approval/sandbox behavior only when selected.

## Account usage and reset reporting — 2026-10-20

Added the local `/usage` action, a read-only session usage endpoint, native Codex and Claude quota readers, and a neutral usage dialog. Provider account limits are separate from local conversation token/cost totals. Remaining percentages, native reset dates and countdowns, reported credit balances, available reset counts and grant expiry dates are displayed without inferring missing values. Credit reset and reset-replenishment dates stay explicitly unreported when absent. Claude's experimental SDK exposes utilization windows but no spendable balance or reset-grant count.

- Workspace type checking passed after integration. The production build and Arch package build also completed; the final artifact refresh and checksums are recorded below.
- The real Codex usage endpoint returned HTTP 200 with two native quota windows, credit information and available reset grants with expiry dates. Only presence/status was retained in this record; account balances and detailed usage snapshots were not written to tracked files.
- A read-only Claude SDK usage request returned available five-hour and seven-day utilization/reset fields without submitting a user message. Optional null windows are omitted; unavailable plan limits are not converted into zero usage.
- In the native collaborative browser, entered `/usage` and clicked its local action. The actual quota dialog opened, the draft cleared, and the active-run count stayed zero. DOM inspection confirmed provider data and accessible meter values. Escape closed the dialog and returned focus to the composer; the page had no horizontal overflow at the attached 1280px viewport.
- Requests are coalesced and cached in bounded process memory, with a minimum refresh cooldown. The dialog's one-second countdown does not poll the provider. Metadata processes have bounded request deadlines and cleanup.
- The final `pnpm package:arch` rebuild completed after the last display/focus changes. Both artifact checksum files passed verification, and the staged UI contains the final credit reset wording. The checked-in Arch recipe and `.SRCINFO` were refreshed to the new archive checksum; Bash syntax, metadata generation and Git whitespace checks passed.

No automated tests, inference, reset redemption, package installation or packaged application launch were performed for this change. Existing controls were retained; Fast-mode turns, automatic review, and native skill execution remain unverified end to end. Attachments, mentions, planning, interactive questions, personal Claude settings/skills and MCP/plugin management remain outside this pass.

## Live website workflow — 2026-10-20

At the user's explicit request, created a separate Basic website project and an isolated Relay session using Codex `gpt-6-luna` at low effort, Standard tier and Supervised permissions. Submitted a real website request through Relay's composer. Two turns used the same provider conversation, wrote the website files, handled file/command approvals and finished with local commit `cc09a38` in the website worktree. Git metadata writes required approval outside the provider's read-only sandbox; the resumed turn requested that approval and committed successfully. Both runs completed and the worktree was clean.

Opened the resulting static site in the native collaborative browser. It loaded without external asset requests, had no horizontal overflow at 1280px or 390px, and its mobile menu opened through the actual button. The active working/tool shimmer stopped after completion. No tests, interruption/restart exercise, native skill execution, Fast-mode request or automatic review was performed in this workflow.

## Saved run change summaries — 2026-10-20

Implemented before/after workspace checkpoints, SQLite migration 5, saved diff retrieval and a compact response card with file counts, added/deleted line totals, compressed folder groups and a read-only diff dialog. Existing history is not reconstructed. Captures describe net workspace state, including committed edits and any concurrent shared-folder edits, without attributing unrelated activity to a particular provider tool.

- Workspace type checking and the production web/server build passed after final integration; Git whitespace checks passed.
- A direct read of actual repository changes through the checkpoint helper returned a native per-file summary and patch. A temporary, explicitly labeled visual preview used that real summary to inspect the card in the collaborative browser; the preview was removed and no conversation/run data was fabricated.
- The settled application returned healthy schema-5 state with zero active runs. A historical run without a snapshot returned HTTP 404 from the new endpoint, preserving its unknown history.
- Review corrected deleted-parent handling, symlink/denied-path boundaries, bounded reads, submodule handling, eager loading of large patches, truncation notices, card placement, folder defaults and dialog focus behavior. Snapshot code writes Git objects only, leaves the real index/refs untouched and disables clean filters/external diff/textconv commands.

No automated tests or additional provider runs were started for this feature, and the new checkpoint-to-persistence path was not exercised by a live inference turn. Desktop packages were not rebuilt or installed for this change. Capture/patch/viewer limits and crash-recovery limitations are recorded in implementation-contract.md.

## Shared Chromium browser and context compaction — 2026-10-20

Implemented an original Node browser host, a streamed React viewer, managed per-session profiles, explicit attachments to an existing Chromium browser, and a run-scoped MCP gateway for Codex and Claude. T3 Code was researched for architecture only. Settings now includes a Browser page and a native/default or 1–95% context compaction preference.

- Workspace type checking and the production web/server build passed. A final server type check also passed after tightening the selected debugging-metadata file read. Git whitespace checks passed. No new test files or automated test suites were added or run.
- Metadata-only native Codex app-server and Claude SDK connections each discovered all 19 browser tools through Relay's authenticated MCP endpoint. No user prompt or model turn was submitted in these checks. A revoked token returned HTTP 401. Cancelling an HTTP request while its approval was pending prevented a later approval from opening a tab.
- An isolated, explicitly labeled local fixture exercised real managed Chromium, PNG/accessibility snapshots, a scoped-ref click, stale-ref rejection, streamed JPEG frames and acknowledgement, human takeover, refusal of agent writes during human control, continued read-only observation, release, unknown-viewer refusal, and blocked file navigation. Real MCP click/snapshot/image calls operated that same page and rejected access after revocation.
- At a 2,000px page viewport, snapshot and stream images were capped at 1,280px while the reported viewport stayed 2,000px for correct input mapping. Large string/array evaluation results were truncated in the page. A synchronous infinite loop was stopped and the tab remained responsive. A JavaScript dialog was surfaced and explicitly dismissed.
- A separate owned Chromium profile with a fake login cookie exercised existing-browser attachment. Its original tab and cookie survived Relay disconnect. Attaching a second Relay session through a localhost/127.0.0.1 alias did not steal the first session's tab; each session retained its own tab after concurrent adoption.
- In the native T3 collaborative preview, inspected the built UI with its production CSP in an isolated example workspace: managed connection, address navigation, pointer clicks, keyboard input, expand/shrink, handoff, Escape dismissal and toolbar focus restoration. Connected the owned external browser through the actual manual-endpoint UI, inspected and dismissed its close-tab confirmation, and disconnected; the external browser and original tab remained open. Browser Settings loaded without console errors. A 75% compaction setting survived reload; invalid percent/remote endpoint settings returned 400 and an unknown session returned 404.
- Review tightened session/tab ownership, queued handoffs, native-page exclusion, snapshot invalidation on navigation, textbox-value hiding, streamed-frame bounds, stale polling, request cancellation and visible timeout errors. Temporary browser fixtures and profiles were outside tracked source; personal browser credential files were not accessed.

Platform execution was on Linux. Windows/macOS discovery paths are implemented but unexercised on those devices. Chrome's default-profile consent prompt was researched from official documentation, not exercised against a personal Chrome installation; attachment was checked against owned non-default Chromium profiles. Native compaction settings and metadata requests were checked, but actual threshold-triggered compaction was not exercised with a large paid conversation. Upload/download management, recordings and general MCP/plugin management remain outside this feature. Desktop packages were not rebuilt or installed, and no code was pushed.

## Repository controls and automatic tracking — 2026-10-20

Implemented SQLite migration 6, original repository controls, read-only GitHub check/workflow retrieval and bounded automatic project context/task tracking. Actual native provider plans update sourced tasks; successful work goes to Review, while checked repository items can be Done. Per-field manual overrides survive automatic updates. Components, sessions, tasks and genuinely reported agent invocations populate Agent Map.

- Workspace type checking and the production web/server build passed after integration. Git whitespace checks passed.
- The running local server returned healthy schema-6 state with zero active runs. Its existing project was indexed into real package/directory/config components, language counts and recent commits without a paid model task.
- Real read-only GitHub requests returned this repository's branch workflow history, including both failed and successful older runs. Local unpublished HEAD had no check runs; that unavailable/partial state stayed separate from history and was not treated as passing.
- Native T3 preview inspection covered the checkout footer and GitHub status popover, repository components and declared local dependency edges in Agent Map. A Vite dependency cache invalidation during development required restarting Vite with re-optimization; the map then loaded.
- The intelligence worker used disposable SQLite/Git smoke scripts before a later reminder to restrict worker validation to compilation; those files were deleted and no test files were added. Repository command sequences were inspected in disposable local repositories. Subsequent changes used type checks and static review.

No push, pull request creation, workflow mutation, new provider inference turn, desktop package rebuild or installation was performed. Native plan-to-runtime integration was not exercised by a live paid turn. Windows/macOS execution, signing-key interaction and remote publishing remain unexercised. Exact bounds and external Git concurrency limitations are documented in repository-automation.md.

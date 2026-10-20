# Foundation validation — 2026-10-19

> **Naming note:** Earlier entries were recorded under the former Relay name. Their commands, paths, tool names and artifact receipts are retained; the Mingle rename section records the later rebrand checks. See [current naming and data compatibility](mingle-rename.md).

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
- In the production preview with its normal CSP, the updated roadmap populated ten real sourced tasks (six implemented items and four existing backlog items). A manual Rescan left the count unchanged. Activity showed the corresponding task sync and real historical session tool calls. Agent Map rendered the package/component graph; no provider agents were fabricated.
- Used Relay’s actual commit dialog to commit only `docs/repository-automation.md` as `61f45c2`. Git confirmed the configured author identity, no coauthor trailer, and that the other two staged documentation files remained staged. No remote write occurred.
- The intelligence worker used disposable SQLite/Git smoke scripts; those files were deleted and no test files were added. Repository command sequences were inspected in disposable local repositories. Subsequent changes used type checks and static review.

No push, pull request creation, workflow mutation, new Relay provider inference turn, desktop package rebuild or installation was performed. Native plan-to-runtime integration was not exercised by a live paid turn. Windows/macOS execution, signing-key interaction and remote publishing remain unexercised. Exact bounds and external Git concurrency limitations are documented in repository-automation.md.

## Antigravity provider — 2026-10-20

Added Google Antigravity as an independent provider, including explicit runtime installation and Google sign-in, model/effort/permission settings, group identities/routing, scoped browser/team MCP, tool activity, native resume and guarded native quota reporting.

- Workspace TypeScript checks and the production web build passed. No tests were added or run, and no Antigravity inference or Google sign-in was started.
- The actual adapter discovery code connected to the cached official Linux ACP 1.4.1 binary using only `initialize`. It returned runtime availability, the native-default model placeholder and an explicit unverified-sign-in notice. It neither created a native session nor submitted a prompt.
- Google's six platform archives were downloaded/read outside tracked source to record local SHA-256 pins. Registry metadata and the public API definitions shipped in the official archive established protocol behavior; this does not constitute a live authenticated run.
- The native T3 preview loaded the Providers settings page from an isolated, clearly labeled example workspace with the production CSP. The Antigravity card reported Setup needed, the installer reported Not installed, and no browser console errors were observed. Install/sign-in actions were not clicked.
- Review corrected ACP prompt completion, permission reply structure, configuration confirmation, metadata workspace isolation, per-run capability redaction, cancellation and shutdown races. Existing project/session data requires no database migration.
- Built `pnpm package:arch`, verified the package checksum, reinstalled it through pacman and reopened the idle desktop app. The installed backend matched the staged bundle hash. Its health response retained four projects, five sessions and schema 8; Codex/Claude remained available, while Antigravity correctly reported not installed and its auth state remained idle. No provider setup action ran automatically. The collaborative preview host became unavailable after restart, so the installed settings endpoints were inspected through HTTP instead of claiming another visual check.

Live authenticated tool execution, model/effort changes, approvals, group delegation, browser use, resume and quota retrieval remain unexercised. Windows/macOS runtime execution is also unverified. Native history import, explicit skill attachment and custom compaction thresholds are intentionally unavailable for this provider. See provider-antigravity.md for exact boundaries.


## Attachments, team actions and workspace settings — 2026-10-20

Implementation source at `6fd4c18` includes direct member commands/skills, clipboard images and file selection in both composers, private attachment storage/history, visible per-provider executable paths, and reversible project removal. Claude Code Sonnet 5.5 high began the implementation; after its native session limit was reached, the authorized Luna high fallback completed its assigned work with orchestrator integration.

- `pnpm typecheck` passed across contracts, server, web and desktop; `git diff --check` passed. No tests were added or run, and no provider prompt was submitted for validation. Type checking includes existing test source without executing it.
- Installed public SDK declarations, native app-server schemas and ACP interface/source definitions established structured image and command mappings. This is interface inspection, not evidence of a live image-analysis turn.
- Review corrected upload serialization, scope changes, failed-upload retention, send acknowledgement, command recognition in ordinary prose, stale metadata/membership checks, queue budgets/stops, shutdown draining and image limits. Native provider runtime checks and failures remain authoritative.
- `pnpm package:arch` succeeded. The package checksum file verified from its release directory. Build warnings were limited to dependency annotation/deploy notices; the build completed successfully.
- Archive SHA-256: `f07a932db7c81c3ce9dee97d96ea601d9c01e06fc95a4160abab4a6be8119f9d`.
- Arch package SHA-256: `67896f247b06d4a6a4e8a95adf8b7972da7667210c4d9343b87286b710f8bd0c`.
- Staged backend SHA-256: `322cba08df1b4646c02a935a9b54c68d9b9bb8d073986520019019be0e685603`.
- Before installation, the running desktop was idle with four projects, six sessions and schema 8. Consistent SQLite backups were written to a private cache directory outside tracked source. No real project was removed and no provider path was changed for validation.

Native paid image/skill/command execution, Windows/macOS execution and live project-removal/restoration flows were not exercised in these checks. The desktop installation receipt is recorded separately when administrator authentication completes. Nothing was pushed or published.

### Installed desktop receipt

The package above was reinstalled through pacman after desktop administrator authentication, then the idle app was restarted. The installed backend SHA-256 exactly matched the staged `322cba08df1b4646c02a935a9b54c68d9b9bb8d073986520019019be0e685603`; the Electron sandbox helper retained root ownership and mode 4755. Health reported schema 10, the same four projects, six sessions and 134 tasks, with no active runs or terminals. Codex 0.160.1, Claude 2.1.292, Antigravity 1.4.1 and OpenCode 1.19.3 all reported availability. Native metadata exposed image modalities on seven Codex models and image/context transport support for Claude and both ACP providers. No inference turn established model-specific image behavior.

The T3 collaborative preview was retargeted to the installed server. Its screenshot/snapshot and click automation returned client execution errors even after reopening the preview, so no screenshot-based visual review is claimed. Native preview DOM inspection/evaluation did work: it confirmed four visible executable-path inputs, the project removal confirmation (cancelled without removing the project), and the enabled multi-file attachment picker in the existing group conversation. The inspected pages had no horizontal overflow at 1280×800. Provider settings, project contents and conversation drafts were not changed for inspection.


## Attachment preview layout — 2026-10-20

OpenCode implemented the four-file UI change in `3ae3859`. Its native session metadata confirmed provider `openai`, model `gpt-6-luna`, variant `high` for the implementation messages. The attachment tray and paperclip now render separately from the same existing controller: both composers place the tray in normal document flow above the textarea, after recipient chips when applicable. The tray wraps at full composer width and scrolls at a bounded height. Upload, retry/remove and send logic were retained.

- Focused web type checking and `git diff --check` passed. `pnpm package:arch` completed, including web/server type checking and production builds. No tests were added or run and no provider prompts were submitted for validation.
- Package checksum verified: `abce32b3e9fc5a4b08582cf3eb914dc376c92f79a4c0f30cbfefee46705b1a94`. The package was reinstalled through pacman and the idle app restarted. Installed/staged web entry hashes matched: `10588f324754844b5c8c0e3bb03d90fb27d57ee2c1ac1b9a4c5e6fd64758fe6f`. The backend remained unchanged; schema 10 opened with four projects and eight sessions, with all four providers available.
- Native T3 preview DOM inspection confirmed the installed full-width wrapping tray rule, one paperclip/file picker and no horizontal overflow at 1280×800. No attachment drafts were present during inspection; one/many-image runtime flows and narrow viewport behavior were not exercised. Existing conversation drafts were not modified for inspection.

Nothing was pushed or published.


## Mingle rename, logo and package — 2026-10-20

OpenCode `openai/gpt-6-luna` at High effort implemented the rename in native session `ses_ea5fa5809ffecNJq6wciDlqfB1`. Interrupted CLI processes were resumed with their saved context and edits. Worker commits `4cfd02d` and `a76f2ed` contain the source changes; the primary orchestrator supplied the original M-shaped node logo and integrated the current guides while retaining historical receipts.

- Workspace dependency relinking with `pnpm install --ignore-scripts`, workspace `pnpm typecheck`, and production `pnpm build` passed. Intermediate checks caught malformed JSX and mistyped identifiers; those were corrected before the successful checks. Node syntax checks for the desktop and packaging scripts, Bash syntax for the Arch recipe, and Git whitespace checks passed. No test suite was added or run.
- Code review preserved `relay.sqlite`, existing database records, worktree paths, session identifiers, browser profiles and legacy UI storage keys. It also checked explicit `MINGLE_*` precedence, legacy `RELAY_*` fallback, both generations of MCP token cleanup, and both `.mingle`/`.relay` file-access exclusions. Electron creates the selected profile directory before setting both `userData` and `sessionData`, before readiness and the single-instance lock.
- `pnpm package:arch` produced `release/mingle-0.1.0-linux-x64.tar.gz` and `release/mingle-bin-0.1.0-1-x86_64.pkg.tar.zst`. Both checksum files verified. The checked-in recipe and generated `.SRCINFO` now pin the actual archive checksum. Build warnings were limited to dependency annotation and legacy-deploy notices; the build completed.
- Archive SHA-256: `551986c31b0ccdd72c1af903630ca78547040ab6f5cd25da530c3070e44b3ebb`. Arch package SHA-256: `ebee817425aef160b62087b23a6bb422b09a6ba7437eeea0020571e49cbd65a5`.
- The staged desktop entry names Mingle, runs `mingle`, and selects the `mingle` icon/window class. Package metadata declares the old `relay-workspace-bin` package as provided, conflicting and replaced. The staged desktop main file matched its source hash `d4c92e85caf338d6f6f2dce8ac8983e5d92ed22a6de2ed5a9c9f6644422a254f`; the staged PNG matched its source hash `bb9108087277947ea64b309cdc21e50542af6934f5ff3ed1d87fc76a38957df0`.
- Started the actual packaged Node/backend in a private preview data directory outside the repository and existing user workspace. Health reported schema 10, a clearly identified example project, zero active provider runs, zero terminals and no pending approvals. Native T3 preview DOM inspection at 1280×800 confirmed title and sidebar Mingle, a loaded 20×20 `/mingle.svg` logo, the same favicon, no visible Relay branding on the inspected page and no horizontal overflow. Screenshot capture was blurred; visual assessment is based on the directly rendered logo asset and DOM inspection, not that screenshot.

The implementation worker was the only model task started for this rename. No provider conversation was submitted for validation. Existing user data was not migrated or opened for an upgrade trial; selection and profile continuity were reviewed in source. Full Electron upgrade launch, live provider execution under the renamed MCP namespaces, and Windows/macOS execution remain unverified. The package was built without installation, application restart, push or publication.

## Google account and preferences — 2026-10-20

Implemented Google sign-in through Supabase with a separate Account settings page and an explicit allowlist for portable preferences. Provider credentials, permissions and machine/project data remain local. The owner approved a dedicated Free-plan Supabase project in Mumbai and delegated Google/Supabase configuration through the shared browser. The Mingle Google consent screen remains External/Testing with the owner's account added; it was not published publicly.

- `pnpm typecheck`, `pnpm build` and `pnpm package:arch` passed. Both release checksum files verified; the source Arch recipe and .SRCINFO were updated to the new archive. Only the existing dependency annotation/legacy-deploy notices appeared. No automated tests or paid model tasks were added or run.
- Applied the account migration to the dedicated project and aligned the local migration filename to Supabase's recorded version `20261020170423`. Read-only catalog queries confirmed enabled RLS, all four owner-only CRUD policies, authenticated-only table grants and timestamp/revision triggers. Security and performance advisors both returned no findings. Public Auth metadata confirmed Google enabled.
- Created a dedicated Google Cloud project/client, configured its Supabase callback, entered the client secret directly in Supabase, and saved the loopback callback allowlist. No client secret was written to source, documentation or runtime workspace records. No paid Google compute or billing account was enabled.
- Started a separate Node/web runtime using a private cache workspace, leaving the installed app and its projects unchanged. The owner completed real Google consent in the shared browser. Mingle verified the account with `getUser()` and displayed signed-in state. Save device preferences succeeded; a cloud count confirmed one preferences row at revision 1. Use account preferences fetched and applied it, with a success notice, no alert and no horizontal overflow at 1280×800.
- This preview uses memory-only login and says so. Electron's OS-protected key bootstrap and AES-GCM vault are implemented and type/syntax checked, but a desktop keyring restart round trip and Windows/macOS behavior were not exercised. Cancellation, offline revocation, stale-device conflicts and hostile cross-account attempts were reviewed in code, not exercised live. The single live preference round trip does not establish every RLS denial case.
- The Node preview remains available at `http://127.0.0.1:34529` for the owner's review. Its memory-only account login ends when that runtime closes. New account storage does not partition the local SQLite workspace or implement team invitations/roles/shared project access.

The updated desktop package was built without installing it or restarting the owner's installed app. Nothing was pushed to Git or released publicly. Detailed architecture, deployment limits and references are in [accounts](accounts.md).


## UI motion and alignment — 2026-10-20

OpenCode implemented this pass using `openai/gpt-6-luna`, variant `high`, in an isolated worktree. Its three scoped commits were integrated as `26b20e2`, `d3309f4` and `f8d62ac`. Orchestrator review in `c22bac9` corrected measurement of the clipped agent list, animated compact-card width, usage-dialog focus return, disclosure sizing and outdated Git empty-state text. Shared timings and interaction guidance are recorded in [ui-motion](ui-motion.md).

- Coverage includes shared dialogs, menus and choices; session context menus; Git and member popovers; composer suggestions; attachments; notices and toasts; usage and saved diff dialogs; browser overlays and confirmations; context/mobile sidebars; agent presence; terminal and task drawer close; and tool/change disclosures. Closing surfaces become inert immediately while their visual exit finishes. Reduced-motion preferences shorten decoration. Provider actions and shell stop commands are not delayed by animation.
- The worker's focused web typecheck, production build and diff check passed. After integration, `pnpm typecheck` passed across contracts, server, web and desktop. `pnpm package:arch` passed, including web/server compilation and production builds. No tests were added or run, and no provider inference turn was submitted for validation. The only model task was the requested implementation worker.
- Native T3 preview DOM inspection of a separate, clearly labeled example workspace confirmed the updated stylesheet, two idle group members, Mingle branding and no horizontal overflow at 1280×800. Opening the project dialog focused its search field; Escape dismissed it and returned focus to Open Project. Existing user projects, credentials, account preferences and the installed desktop were not changed for inspection.
- Browser review is limited: screenshots were blurred, snapshot and resize operations failed, and animation sampling timed out with a stalled document timeline/requestAnimationFrame. DOM and animation-property inspection worked, but no smooth-frame playback, narrow-screen interaction, full reduced-motion run or Windows/macOS visual verification is claimed. Native details height interpolation is progressive enhancement; unsupported browsers retain native disclosure behavior.
- Both release checksum files verified. Archive SHA-256: `7e6a21bfb174c3730ee9c64350a7c88d71f2212acbcb78564931cd46ba110909`. Arch package SHA-256: `9bbe485660765cfdf34c21ddee3c6639050527b62486e442f829a3839f5533f5`. The tracked Arch recipe and `.SRCINFO` pin this archive. Build output contained the existing Zod annotation and pnpm legacy-deploy notices; packaging completed successfully.

The package was built locally without installation, installed-app restart, push or publication. No dependencies or backend/provider contracts changed for this pass.

# Mingle rename and data continuity

Mingle is the canonical product name. The workspace root is `mingle-workspace`; internal packages are `@mingle/contracts`, `@mingle/server`, `@mingle/web` and `@mingle/desktop`. Desktop builds use the `mingle` executable and command, `mingle.desktop`, `mingle.svg`, `/opt/mingle`, the Arch package `mingle-bin`, and `mingle-VERSION-linux-x64.tar.gz` release archives. The Arch package declares `provides`, `conflicts` and `replaces` for `relay-workspace-bin` so a future package upgrade can replace the former package.

## Existing local data

No database or user file is renamed, copied, migrated or rewritten by the rebrand. The selected existing data root continues in place with its absolute paths and contents. Desktop selection also keeps Electron's profile root aligned with that workspace, preserving browser profiles and Chromium localStorage.

- A fresh desktop install uses the platform's `Mingle` user-data directory, with workspace data in `workspace/`.
- If `Relay/workspace/relay.sqlite` exists, desktop opens `Relay` in place and keeps it as Electron's user-data root. This legacy database wins when both `Relay` and `Mingle` roots contain databases; the other root is left untouched.
- If the Relay database is absent but a Mingle workspace database exists, desktop opens Mingle. If neither database exists but the Relay user-data directory exists, it reuses that root; otherwise it starts under Mingle.
- For a source checkout, the default is `.mingle`. An existing `.relay` directory is reused when it is the only database root; if both have databases, `.relay` remains the default. Explicit `MINGLE_DATA_DIR` selects a path directly.
- For each supported environment pair, a defined `MINGLE_*` value takes precedence; `RELAY_*` is read only when the corresponding Mingle variable is unset. The aliases are `DATA_DIR`, `HOST`, `PORT`, `WEB_DIST`, `WEB_PORT`, `ALLOWED_ORIGINS`, and the desktop development-launcher `NODE_EXECUTABLE`.

The SQLite filename remains `relay.sqlite`, including WAL files, and its schema and historic rows are not changed by this rename. Session/provider IDs, saved provider conversation IDs, worktree paths, branch names, browser-profile paths, upload records and attachments remain as recorded. The existing `relay.ui.v2` and `relay.ui.v1` localStorage keys are deliberately still read and written. Mingle writes new public Antigravity metadata under `.cache/Mingle`; it can read the prior `.cache/Relay/antigravity` metadata without moving or deleting it. These metadata files contain public discovery results, not credentials.

## Compatibility identifiers

The remaining Relay identifiers are storage or protocol compatibility details rather than active product branding:

- `.relay`, `RELAY_*`, `Relay/workspace`, and the `relay.sqlite` filename are selected/read for existing data as described above. `.mingle` and `.relay` are both ignored and denied by project file/snapshot APIs.
- `relay.ui.v1`/`relay.ui.v2` remain stable browser storage keys so saved project/session selection and layout settings continue to load.
- The contracts retain catalog provenance value `source: 'relay'` so saved catalog entries parse without a schema migration. New local provider commands use the Mingle-owned catalog behavior; historic rows are not rewritten.
- Upload clients may use `X-Mingle-Filename`; the server still accepts the old `X-Relay-Filename` header.
- Provider MCP registration and runtime configuration use matching `mingle_browser` / `mingle_team` names. Old MCP token environment names are scrubbed alongside the new names from provider children. Historical tool-call records keep their recorded names.
- Pre-rename package/archive filenames, repository references, exact commits, old shell commands, filesystem paths, and validation receipts remain verbatim where they identify an actual prior artifact or observation. The project folder and Git remote are unchanged.

The `docs/validation.md`, `docs/provider-research.md`, `docs/provider-opencode.md` and live integration receipts describe pre-rename runs. Their command output, artifact hashes, paths, names and commit references are historical evidence, not the current Mingle package or active MCP configuration.

## Packaging rollout

Existing ignored `release/relay-workspace-*` files are pre-rename artifacts and are not renamed in place. A new Mingle archive and Arch package are produced after integration with `pnpm package:arch`; that step generates the archive checksum used for the package build. Do not install or replace an existing package as part of source integration. The first Mingle installation should open the existing Relay data root through the selection rules above. There is no database migration or data-copy step.

The first Mingle archive and Arch package were built locally after logo integration; their checksums and packaged UI inspection are recorded in [validation](validation.md#mingle-rename-logo-and-package--2026-10-20). Building a package does not install it or exercise an existing desktop profile upgrade.

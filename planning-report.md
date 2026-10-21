# Planning and native questions — implementation report

## Delivered

- Added shared contracts and durable SQLite records for provider-native plans and interactive questions, including plan revisions, approval, execution lifecycle, restart recovery, and safe question cancellation/answering.
- Integrated native plan mode and user-input callbacks for Codex, Claude, OpenCode, and Antigravity. Plan runs omit browser/team side-effect tools and reject commands/skills; provider permissions are unchanged.
- Added session and group UI for planning, reviewing/editing/approving/executing plans, and answering provider questions. Group plan generation addresses one selected agent; approved plan execution uses the durable group delivery queue.
- Added migrations 14 and 16 for session plan/question records and durable group plan intent/execution linkage. Updated the existing schema-upgrade integration fixture.

## Verification

- `pnpm typecheck` — passed.
- `pnpm --filter @mingle/server test` — passed: 25 files, 189 tests.
- `pnpm --filter @mingle/web build` — passed; Vite printed dependency comment-annotation warnings from Zod and completed successfully.
- `git diff --check` — passed.
- No provider-backed plan generation or paid model task was run; no new test cases were added.

## Integration notes

- Migration 16 is this worktree's group plan intent/execution migration, following the migration 15 slot reserved for mentions in the shared coordination notes. Reconcile the central migration list with project removal (13), plans/questions (14), mentions (15), and this migration (16) while preserving fresh-database and upgrade behavior.
- Commit scope includes only the planning implementation and its related contract, UI, schema-fixture, and documentation changes. No push or publication was performed.

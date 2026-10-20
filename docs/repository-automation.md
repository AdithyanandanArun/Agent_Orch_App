# Repository controls and automatic project tracking

Relay keeps Git operations in the Node server and uses the installed GitHub CLI's existing authentication. It does not extract tokens or configure a GitHub login. GitHub Actions is read-only: no run, rerun, cancel or workflow editing controls are exposed.

## Repository controls

The conversation footer identifies the actual checkout or isolated session worktree. Branch, commit, push and pull request actions operate on that scope, never a client-supplied working directory. Local Git status works without GitHub connectivity. GitHub checks and workflow history load separately and retain their actual commit IDs; a successful older workflow is not a successful check for the current local commit.

Commit uses an explicit message and selected eligible changed paths. Other staged paths stay outside the selected commit. Denied secret paths and escaping symlinks cannot be selected. The server checks the expected HEAD and status fingerprint and rejects stale selections. Branch changes require a clean checkout. Mutations reject active Relay sessions writing to that checkout. Independent external CLI writers cannot be locked by Relay; refresh after an external edit.

Push and pull request creation require explicit user actions. There is no automatic push, force push, reset, stash, discard or merge. Pull request creation does not implicitly publish a branch. GitHub CLI availability, authentication, unsupported hosts, rate limits and missing remotes are reported instead of being treated as passing CI.

## Where automatic tasks come from

Repository context is a bounded static scan. Existing project checklists and TODO comments can become sourced tasks. Manifests and directory structure populate project components in Agent Map; real Git metadata and observed changes populate Activity. Opening an empty folder does not start a model or invent a project plan.

An explicit work request creates a task for its session. Native Codex `turn/plan/updated` events and successful Claude `TodoWrite`/task tool results update plan steps while a run proceeds. Steps retain source metadata and an optional parent task. Parentage is displayed separately from prerequisite dependencies. Order in a plan is not evidence of a dependency.

A completed provider turn or native completed step moves its work to **Review**, where a person can accept it. A checked repository checkbox is explicit completion evidence. A missing source is flagged; disappearance is not proof that work was done. Fields actually changed by the user are protected from subsequent automatic updates. Manual task creation and the existing dependency rules remain available.

Claude task updates reuse persisted native task metadata across resumed runs. TaskGet/List can supply titles and dependencies for IDs not observed by Relay. Text-only historical conversations are not parsed into fabricated plans, subprocesses or past timings. Native child-agent invocations appear only when the provider reports them; static repository components are not represented as agents.

## Persistence and refresh

SQLite migration 6 adds source metadata and project-context snapshots without changing existing tasks. Scans run on onboarding/startup, relevant repository/file/run events and periodic refresh. Repeated unchanged observations do not create duplicate tasks or activity events. Files, model credentials and browser profiles are not copied into project context. No dependency installation, repository script execution or background inference is part of indexing.

Repository and task automation is local. It does not yet implement autonomous task scheduling, automatic integration, issue editing, GitHub webhooks or distributed coordination.

## Protocol references

- [Codex app-server event contract](https://learn.chatgpt.com/docs/app-server): native plan notifications and collaboration items.
- [Claude tool execution lifecycle](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works): successful tool results rather than attempted calls.
- Claude SDK task DTOs are checked against the installed `sdk-tools.d.ts`; no transcript prose is interpreted as a task ID.
- [GitHub CLI workflow history](https://cli.github.com/manual/gh_run_list), [pull request creation](https://cli.github.com/manual/gh_pr_create).


## Bounds and practical limits

Static scans enumerate at most 20,000 files (4,000 directories and depth 12 for non-Git folders), read 30 checklist documents of at most 256 KiB, 40 package manifests, and 400 source files of at most 200 KiB with a 6 MiB combined source budget. The 10-second reading budget is cooperative; individual Git commands have separate deadlines. Missing-source reconciliation is disabled for an incompletely read source category. Repository tasks are capped at 200, preferring open work; source limits appear in the scan notes.

Agent Map shows at most 40 components, 40 reported child-agent invocations and 200 relevant tasks, with hidden counts. Other recorded tasks remain in the board and database. Title-derived provider plan identities belong to a parent request (or a run with no parent); native Claude task identities remain session-scoped.

Local Git status lists at most 1,000 in-scope changes, with a small additional list of out-of-scope changes. Content fingerprints are bounded to 64 MiB per file and 256 MiB per read; unreadable, oversized or excess-budget paths cannot be committed. Selected commits use a private index, an explicit branch-ref compare-and-swap and a refresh of only the committed paths in the real index. Existing signing policy is honored; a signing failure never silently falls back to unsigned. Repository hooks and filesystem monitor hooks are disabled, matching Relay's existing Git helper.

GitHub reads are cached for 30 seconds and coalesced, with a five-second refresh cooldown. Exact-HEAD checks are separate from commit-labelled branch workflow history. Failed or truncated reads carry completeness flags and cannot produce an all-passing status. Cross-fork pull requests and non-github.com GitHub hosts are not supported in this pass. Windows and macOS execution has not been checked on those devices.

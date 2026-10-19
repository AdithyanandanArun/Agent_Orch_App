# Relay

A local development workspace for independent coding-agent sessions. Relay is the working title for the distributed AI development environment described in [the product vision](docs/vision.md).

This repository establishes the local foundation: an original React workspace, a Node runtime, persistent sessions and events, isolated Git worktrees, provider adapters, task dependencies, artifact handoffs and a development Electron shell. Distributed team networking, voice orchestration and automatic integration remain later milestones.

## Run locally

Use Node **24.13 or later**, Git and pnpm **11.26**. Native terminal support may require a C++ build toolchain and Python when a prebuilt `node-pty` binary is unavailable.

```sh
pnpm install
pnpm dev
```

Open **http://127.0.0.1:5173**. The local API listens on port **4310**. The clearly labeled example workspace contains local files, idle sessions and a sample dependency workflow; it starts no model calls. Add your own existing Git project to work on real code.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
pnpm start
```

`pnpm start` serves the built workspace and API together at **http://127.0.0.1:4310**. Tests use local fixtures rather than paid inference.

## Provider setup

**Codex:** install the supported Codex CLI and authenticate it yourself with `codex login`. Relay talks to its documented app-server protocol, using the conversation identifier for later turns.

**Claude:** the adapter uses the official Claude Agent SDK with your existing local Claude Code login. Run `claude auth login` in a terminal on the same machine and as the same OS user that starts Relay, then use **Settings → Re-check**. Relay asks `claude auth status --json` for login status; it never reads, copies or stores credential files. If Settings selects a different executable than your shell, use that full executable path for login.

Alternatively, set `ANTHROPIC_API_KEY` in the environment that starts Relay. An explicit API key takes precedence over the saved login and uses API billing. Credentials are not entered into the browser. A copied `.env` file is not automatically loaded; export the variable in your shell or use your process manager's environment configuration.

An installed executable does not establish authentication or access to every model. Settings show executable and login diagnostics and allow path overrides. Model access, expired credentials and quota errors remain visible when a session runs.

See [provider research](docs/provider-research.md) for the T3 architecture investigation, protocol sources and provider access assumptions.

## Workspace behavior

Create independent sessions with their own model, effort and permission policy. Git worktrees are the default; a repository needs an initial commit before Relay can create one. Nonisolated sessions are an explicit choice. A worktree separates file edits and is not an operating-system sandbox.

Tasks include an owner, prerequisites and acceptance criteria. A successful assigned run enters review. Artifact handoffs identify a committed file and revision, record an event and add context for the receiving session's next turn. Handoffs do not merge branches or silently launch inference.

Use the file pane to inspect and edit permitted project files, the changes pane for Git diffs, and the terminal for an interactive shell in the selected local workspace. The app is intended for a trusted local user and binds to loopback; exposing it through a network tunnel is not a supported team collaboration mode.

State lives in the ignored `.relay/` directory by default. Override it with `RELAY_DATA_DIR`. Worktrees and provider conversation references are retained; deleting application data is not a supported cleanup procedure for repositories with unmerged work.

## Desktop development shell

```sh
pnpm build
pnpm desktop
```

The Electron launcher starts the same Node server on a selected loopback port. It uses the local Node installation, configurable with `RELAY_NODE_EXECUTABLE`, and stores state under Electron's user-data directory. This is a development launcher; signed installers and update delivery are future release work.

## Project documents

- [Original vision](docs/vision.md)
- [Product and interaction specification](docs/product-experience.md)
- [Architecture decisions](docs/architecture.md)
- [Implementation contract](docs/implementation-contract.md)
- [Provider research](docs/provider-research.md)
- [Milestones and acceptance evidence](docs/roadmap.md)
- [Observed validation and remaining limits](docs/validation.md)

The implementation is original. T3 Code is an architectural research reference and is not a source-code dependency. No license grant has been selected for this project yet.

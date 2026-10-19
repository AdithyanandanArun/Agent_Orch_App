# @relay/server

Local Node runtime for Relay: HTTP + WebSocket API on `127.0.0.1:4310`, SQLite persistence (`node:sqlite`), provider
adapter sessions, task DAG, handoffs, Git worktree isolation and PTY terminals. It is the middle layer between the web UI
(or the Electron shell) and the provider module in `src/providers/`.

```
pnpm --filter @relay/server dev       # tsx watch src/index.ts
pnpm --filter @relay/server start     # tsx src/index.ts
pnpm --filter @relay/server test      # vitest, no model calls
pnpm --filter @relay/server typecheck
```

## Configuration

| Setting | Env | Option | Default |
| --- | --- | --- | --- |
| Data directory (database, example workspace, worktrees) | `RELAY_DATA_DIR` | `dataDir` | `<repo root>/.relay` (repo root is derived from `import.meta.url`, never from cwd) |
| Host (loopback only, anything else is refused) | `RELAY_HOST` | `host` | `127.0.0.1` |
| Port (`0` = free port) | `RELAY_PORT` | `port` | `4310` |
| Built web app | `RELAY_WEB_DIST` | `webDistDir` | `<repo root>/apps/web/dist` if it contains `index.html` |
| Vite dev port that is trusted as an origin | `RELAY_WEB_PORT` | `webDevPort` | `5173` |
| Extra trusted origins (comma separated) | `RELAY_ALLOWED_ORIGINS` | `allowedOrigins` | none |

Data layout: `relay.sqlite` (+ WAL), `example-workspace/` (a real Git repo), `worktrees/<projectId>/<sessionId>/`.
Worktrees are never deleted by the server; archiving a session only hides its metadata.

## Embedding and tests

```ts
import { createApplication } from './app.ts';          // buildServer is an alias
const app = createApplication({ dataDir, port: 0, providers /* { createAdapter, detectProviders } */, exampleWorkspace: true });
const { url, port } = await app.listen();               // initialises the example workspace, then binds
await app.close();                                     // aborts runs, kills PTYs, closes sockets, server and database
```

`src/index.ts` exports `startRelayServer(options)` (real providers from `./providers/index.ts`) and runs it as a CLI with
SIGINT/SIGTERM/SIGHUP handling when executed directly. Tests inject `FakeProviders` from `src/test-utils.ts`; nothing in the
automatic suite calls a model or a provider executable.

Options of interest: `providers` (required), `log`, `exampleWorkspace` (default `true`), `detectOnStart` (default `true`),
`runtime: { abortGraceMs, flushIntervalMs }`, `terminal: { shell, spawner }`.

## Behaviour notes

- **Example workspace**: created once per data dir (`meta.example_workspace_v1`). Project `prj_example` (`isExample: true`)
  is a Git repo with README, contract doc and a committed versioned artifact `api/users.v1.openapi.json`; two **idle**
  sessions (`ses_example_contract` Claude, `ses_example_client` Codex) each in their own worktree; a four-task DAG.
  Its only commit uses a local sample identity (`Relay Example`). No provider is invoked.
- **Runs**: `POST /api/sessions/:id/messages` validates and registers the run synchronously (409 if the session is
  active), then runs the adapter in an isolated promise. Assistant text is persisted while streaming (message kind
  `streaming`, finalised to no kind; cancelled or recovered runs end as `partial`). Other message kinds: `tool`, `info`,
  `error`, `handoff`, `task`. `usage` events are treated as run-cumulative snapshots added to the totals from before the run.
  An adapter that ignores `AbortSignal` is declared interrupted after `abortGraceMs` (5 s).
- **Approvals** exist only for a live run. Interrupt, failure, completion and restart deny them; deciding on a
  non-pending or stale approval returns 409. Session status is `waiting` while one is pending.
- **Restart recovery**: runs in `running`/`waiting` become `interrupted`, pending approvals become `denied`
  (`approval.expired` event), streaming messages become `partial`, `running` tasks go back to `ready`.
- **Tasks**: new tasks are `ready` or `blocked` (unfinished dependencies). `running` is set only by `POST /tasks/:id/run`;
  a successful turn moves the task to `review`, failure or interruption back to `ready`; only a human moves it to
  `done`, which unblocks dependents (and re-blocks ready dependents if a done task is reopened). Cycles, self and
  cross-project dependencies and cross-project assignment are 422.
- **Handoffs** (`POST /api/handoffs`): the artifact path must be a committed regular file at `revision` (resolved to a
  full commit id) that is reachable from the source session's `HEAD`. Result: a `handoff.created` event and a system
  message (`kind: 'handoff'`) in the target session with a compact reference and the artifact content (≤ 16 KiB, text).
  Unconsumed handoff messages are prepended to the next provider prompt once (consumed when the provider produces its first
  event or the run completes). No merge, no run.
- **Git status** (`GET /api/projects/:id/git`): `status` is the porcelain code (`M`, `A`, `D`, `R`, `??`, or two
  letters when staged and unstaged differ); `diff` is `git diff HEAD` (staged + unstaged) plus up to 20 small untracked files,
  with secret files excluded, capped at 1 MB. Always scoped to the project or `sessionId` worktree directory.
- **Files**: paths are relative, normalised, symlink-resolved and must stay inside the root (project or session
  worktree). `.git`, `.relay`, `.ssh`, `.env*` (except `*.example`/`*.sample`), keys and certificates are refused; binary
  and >2 MiB files are not opened. Writes use `O_NOFOLLOW`.
- **Terminals** (`/ws`): `terminal.start` spawns a `node-pty` shell in the project or session directory. A terminal belongs to
  the socket that started it; other sockets cannot write, resize or stop it; closing the socket (or shutdown) kills it.
  Limits: 8 per socket, 32 total, 64 KiB per input frame, 2–500 columns, 1–300 rows. Start failures are reported as a
  terminal that prints the reason and exits with code `-1`, because `ServerEvent` has no error frame.

## Local transport security

- The server binds loopback only and checks the `Host` header on every request (DNS rebinding).
- Mutating HTTP requests and WebSocket upgrades are rejected (403) when they carry an `Origin` other than
  `http://{localhost,127.0.0.1,[::1]}:{server port | webDevPort}` or a configured extra origin. Requests without `Origin`
  (curl, tests) pass the Host check only. No CORS headers are ever sent, so the app must be same-origin or behind the Vite proxy.
  Electron should load the UI from the server origin (`http://127.0.0.1:4310`), not `file://`.
- Static responses carry a CSP (`DEFAULT_CSP` in `config.ts`; pass `csp: null` to disable); the web app must not load remote scripts.
- Errors are `{ "error": string }`; internal details are logged, not returned. Secrets in provider errors, tool output and
  approval inputs are redacted on a best-effort basis.

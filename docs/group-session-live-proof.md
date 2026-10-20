# Live group-session integration proof — 2026-10-20

## Outcome

**Implemented and integrated in one bounded, provider-backed Relay group request.** The existing OpenCode lead delegated a committed API contract and backend to Codex, then queued an OpenCode frontend assignment against the actual backend task ID and `api-contract.md`. Relay verified and delivered that artifact, automatically released the blocked frontend task while the backend remained in **Review**, and later delivered both worker commits to the lead. The lead integrated both commits in its isolated checkout. Both worker tasks and the coordinator request task remain **Review**, pending human acceptance.

This proves the observed OpenCode/Codex/OpenCode workflow on one Linux loopback runtime. It does not prove Claude interoperability, distributed collaboration, general failure recovery, cross-platform behavior, or savings.

## Isolated setup and actual providers

- Relay source runtime: commit `a1fa21aa097760d33349caac4a40e38fd5cd5a2b`, server version `0.1.0`, started from the current source on dynamically selected loopback port `43855` (`http://127.0.0.1:43855`). SQLite, worktrees, and runtime data are under `/home/adithyan/.cache/relay-workers/team-proof/runtime-data`.
- No installed app was opened or restarted. The disposable Git project is `/home/adithyan/.cache/relay-workers/team-proof/example-contact-form`, named **Example validation — local contact form**. Its committed README marks it as an example/validation project, and its initial commit `e4f0d3fa6f32f12a69d31f86d7d1eb7460dc32ce` contains only the README and a dependency-free `package.json`. The project record's `isExample` field is false; it is not Relay's seeded demonstration project.
- Initial and worker commits use the configured Git identity `Adithyanandan A <224833376+AdithyanandanArun@users.noreply.github.com>`.
- `opencode1` was the Current agent leads orchestrator: OpenCode `1.19.3`, model `openai/gpt-6-luna`, High effort, Full access, isolated branch `relay/opencode-lead-885c3948`, Relay session `ses_885c39488db54156`, native session `ses_ea61763faffeFOTbDeHWmmF5kG`.
- `codex1` was the backend worker: Codex `0.160.1`, model `gpt-6-luna`, High effort, Full access, isolated branch `relay/codex1-010ccc5b`, Relay session `ses_010ccc5bed5a46c3`, native session `01a159e8-d92d-7ae3-97a1-446534ed911d`.
- `opencode2` was the frontend worker: OpenCode `1.19.3`, model `openai/gpt-6-luna`, High effort, Full access, isolated branch `relay/opencode2-74a37df7`, Relay session `ses_74a37df7c4044762`, native session `ses_ea61577dcffeQeKUPUgzapnQdG`.
- Each member's effective provider/model/effort/policy and worktree came from Relay bootstrap/session metadata. OpenCode discovery advertised HTTP MCP; actual group tool activity and durable artifact events were recorded through Relay's group runtime, not a fake adapter or shell-emulated message.
- Claude was not assigned and no Claude inference was started. `GET /api/bootstrap` performs Relay's documented provider metadata discovery, which includes a non-inference Claude auth-status probe; no credential files were read.

## Request, dependency, and automatic artifact handoff

The sole human request was group message `gms_ea6485e904734fbf`, request `req_f8c4a605d62e47fb`, accepted at `2026-10-20T15:22:55.841Z`. It requested a local contact form using standard Node HTTP, static HTML/CSS/JavaScript, local disk persistence, `node:test`, and no external dependencies.

The lead created two non-overlapping assignments through team MCP:

| Assignment | Assignment / task / delivery | Recorded scope | Final task status |
| --- | --- | --- | --- |
| Backend | `asg_2c087214603241b8` / `tsk_04e3cb1d49ce4524` / `dlv_ac522595102141b9` | `.gitignore`, `api-contract.md`, `server.js`, `test/server.test.js` | Review |
| Frontend | `asg_254ed43541064227` / `tsk_7597ec616d4b4801` / `dlv_1895fb557be341b7` | `app.js`, `index.html`, `styles.css`, `test/ui-contract.test.js` | Review |

The frontend task recorded `dependsOn: ["tsk_04e3cb1d49ce4524"]` and the exact input artifact `{ taskId: "tsk_04e3cb1d49ce4524", path: "api-contract.md" }`. It first appeared blocked. The backend committed the contract and implementation as `25939a53d8f4b4d80f6cc348916ae66e8c450754`. Relay recorded:

1. `handoff.created`, event 20, at `15:24:57.952Z`, for `api-contract.md` at that revision.
2. `group.artifact.published`, event 21, artifact `art_1ea21afb44e44e6f`, at `15:24:57.954Z`.
3. Backend task `tsk_04e3cb1d49ce4524` changed to Review at event 28, `15:24:58.107Z`.
4. Relay started the queued frontend assignment as run `run_9e9406b4279d455e` at event 34, `15:25:02.516Z`.

A read-only SQLite join of `group_assignment_inputs`, `group_artifacts`, and the frontend delivery confirmed its producer task, exact path, artifact ID, blob, full commit, completed delivery, and frontend run. The contract was inlined by Relay's verified artifact handoff. No human changed task state, manually copied contract text, or manually released the consumer. The backend remained in Review while the frontend ran.

Both workers published their committed files to the lead through `team_artifact`. Backend artifacts were at commit `25939a53d8f4b4d80f6cc348916ae66e8c450754`; frontend artifacts were at `33a69b12e2b51ae007e3070b6fbe49c5ad870b40`. Both assignment deliveries completed and both tasks remained Review.

## Contributions and integration

- **Codex backend (`@codex1`)** committed `api-contract.md`, `server.js`, `test/server.test.js`, and `.gitignore` as `25939a53d8f4b4d80f6cc348916ae66e8c450754` (`Implement local contact API and persistence`). It reported four passing `node:test` checks for a valid submission, invalid/malformed submissions, persistence after server restart, and static serving.
- **OpenCode frontend (`@opencode2`)** consumed the exact delivered contract revision, then committed `index.html`, `styles.css`, `app.js`, and `test/ui-contract.test.js` as `33a69b12e2b51ae007e3070b6fbe49c5ad870b40` (`Add accessible contact form frontend`). It reported three passing UI contract tests, `node --check app.js`, and `git diff --check`.
- **OpenCode lead (`@opencode1`)** cherry-picked those worker commits into `/home/adithyan/.cache/relay-workers/team-proof/runtime-data/worktrees/prj_0da84de2e86e4bf8/ses_885c39488db54156`, branch `relay/opencode-lead-885c3948`. Integrated commits are `3284b0744faf4e99ccaba91f734af5c9f90a2cca` (backend), `21d5b68b5b01b0b681a49edece359e37d47354d1` (frontend), and `39f72e4d744c3f9fa63ee4fde78dbcbd3df111f8` (`Serve root-level contact form assets`, final HEAD).
- The backend contract initially described static files under `public/`, while the frontend assignment required root-level assets. The lead preserved both worker scopes and added an allowlisted root `index.html`/`styles.css`/`app.js` fallback, retaining `public/` precedence. The final test suite checks that fallback and refuses to serve `server.js` as a static file.

## Runs, turns, and measured timing

Relay's final request record is **completed, 5 of 16 turns**, with five completed deliveries. The five native runs and Relay-recorded durations were:

| Member / run | Provider and model | Duration |
| --- | --- | ---: |
| Lead request — `run_c497c643d3eb49b6` | OpenCode `openai/gpt-6-luna` High | 469,473 ms |
| Backend assignment — `run_8e29a3a7a0334a1c` | Codex `gpt-6-luna` High | 108,295 ms |
| Frontend assignment — `run_9e9406b4279d455e` | OpenCode `openai/gpt-6-luna` High | 147,925 ms |
| Lead's reply to a worker question — `run_c4979f3a7b6045b2` | OpenCode `openai/gpt-6-luna` High | 29,462 ms |
| Lead result/integration report — `run_9bc240563ee34d2b` | OpenCode `openai/gpt-6-luna` High | 19,035 ms |

Request acceptance to final delivery completion spanned approximately **8 minutes 38 seconds** (`15:22:55.841Z`–`15:31:33.837Z`). Summed run durations are not wall time because backend and frontend work overlapped. Relay reported no USD cost for these sessions; no cost comparison or savings claim is made.

## Verification evidence

**Worker-reported checks:** Codex reported 4/4 backend tests; OpenCode frontend reported 3/3 UI tests plus `node --check app.js` and `git diff --check`.

**Lead-reported checks:** The lead reported `npm test` 8/8, syntax checks for `server.js`, `app.js`, and both tests, `git diff --check`, and an actual browser form exercise. Its detailed tool record shows these checks preceded its later static-routing correction, so they are not treated as final post-correction verification.

**Independent post-correction checks run in the final lead checkout:**

- `npm test`: **8 passed, 0 failed** in 159 ms. This includes API success, validation failure, disk persistence across server restart, root asset serving, unknown API route behavior, and UI contract tests.
- `node --check server.js`, `node --check app.js`, `node --check test/server.test.js`, `node --check test/ui-contract.test.js`: all passed.
- `git diff e4f0d3f..HEAD --check`: passed.
- `npm start`: server started on a dynamically reserved loopback port; `GET /api/contacts` returned HTTP 200 with an empty list. The process was stopped and temporary data removed.
- A fresh headless Playwright Chromium context loaded the final integrated page, filled the form, submitted it, observed success feedback, confirmed one matching API and disk record, and reported zero page errors. This final browser check ran after commit `39f72e4`.

The example defines no build script; the production-style start command and Node syntax checks were used instead.

Two initial independent Playwright harness attempts failed before interacting with the app (incorrect module resolution, then a missing default headless-shell executable). The verifier corrected the harness to use the installed Chromium executable; the final browser check passed. One read-only status-monitor command also timed out after a PID file was mistakenly used as a URL; it changed no files and did not affect the Relay runtime or proof state.

No Relay source fix was needed. The integration correction was confined to the disposable example. The Relay repository received only this proof documentation and the supported roadmap/evidence update.

## Remaining limits and retained runtime

- This was one local Linux run. It does not establish cross-platform, distributed, repeated-task, exhaustive failure-recovery, or production-security behavior.
- Claude was not used; Codex/Claude interoperability remains untested. No fixed cost reduction is inferred.
- All related tasks are still **Review**; no task was marked Done or accepted.
- No code was pushed, published, installed, or added to Relay's contact-form product.
- The private runtime, SQLite database, example repository, worker worktrees, and artifact commits are preserved under `/home/adithyan/.cache/relay-workers/team-proof`. The isolated Relay server is stopped after proof completion. To restart it from the Relay repository root, run:

  ```sh
  pnpm --filter @relay/server exec tsx /home/adithyan/.cache/relay-workers/team-proof/server-entry.mts
  ```

  The launcher selects a fresh loopback port and writes it to the private `server-url.txt`. Do not rerun the private setup or send-request scripts unless creating a new proof instance; the database, groups, and paid work already exist.

Sanitized evidence is retained privately in `~/.cache/relay-workers/team-proof/evidence/`, with raw runtime records in its SQLite database. The private evidence contains no credentials, tokens, or MCP endpoint URLs.

# Provider research and adapter design

Scope: `apps/server/src/providers/**`. Public surface is `apps/server/src/providers/index.ts`:

```ts
createAdapter(provider: Provider): AgentAdapter
detectProviders(settings: AppSettings): Promise<ProviderInfo[]>   // [codex, claude]
```

Both use the types in `@relay/contracts` unchanged. `AgentAdapter.run()` performs exactly one turn.

## Provenance

| Source | Used for | Notes |
| --- | --- | --- |
| Codex app-server documentation (local copy `/tmp/relay-codex-app-server.md`, from learn.chatgpt.com/docs) | Lifecycle, methods, approvals, items, errors | Example wire values in the prose are not all current (see next row). |
| `codex app-server generate-json-schema` run against the installed `codex-cli 0.160.1` | Authoritative wire shapes | `AskForApproval` is kebab-case (`untrusted`, `on-request`, `never`), `SandboxMode` is kebab-case, `SandboxPolicy.type` is camelCase. The docs show `unlessTrusted`/`workspaceWrite` in places; the binary's schema wins. Request shapes were also exercised against the real app-server without inference (thread/start, thread/resume, malformed-thread turn/start) on 2026-10-19. |
| Claude Agent SDK docs (`code.claude.com/docs/en/agent-sdk/*`), TypeScript reference, CLI reference (local copies `/tmp/relay-claude-*.md`) | `query()`, options, permissions, auth policy | The overview states that third-party developers may not offer claude.ai login or its rate limits without prior approval; API-key auth is required. |
| Installed `@anthropic-ai/claude-agent-sdk@0.3.302` type declarations (`sdk.d.ts`) | Exact option names, message and result shapes, `canUseTool` signature | Checked rather than trusting the docs prose. Command line produced by the SDK was verified against a stub executable (no network). |
| `claude --help` of Claude Code 2.1.292 | `--bare` semantics (OAuth/keychain never read) | Relay does not use bare mode (it would drop CLAUDE.md); it verifies the credential source instead, see below. |
| T3 Code, upstream `7e7e6d8240858d19d8e72dbcd0f0117e3d0a7f56` (main), inspected 2026-10-19 (`/tmp/relay-t3-claude.ts`, `/tmp/relay-t3-codex.ts`) | Architecture only | Takeaways: one driver per provider behind a common adapter interface; capability/status probing is separate from running a session; provider processes are isolated from the UI/Node layers; provider status is cached and re-probed. No code, names or structure were copied; Relay's adapters are written from the protocol documents above. |

## Module layout

```
providers/
  index.ts            createAdapter, detectProviders (public)
  common.ts           ProviderError, AbortError helpers, secret redaction, bounded stderr tail
  process.ts          probe runner (argv, timeout), ChildLike, escalating shutdown (stdin EOF -> SIGTERM -> SIGKILL)
  discovery.ts        executable resolution (override > PATH > ~/.local/bin > ~/.npm-global/bin > SDK-bundled)
  detect.ts           detectProviders: version probe + Codex app-server account/model probe + Claude env check
  codex/rpc.ts        newline-delimited JSON-RPC client over a child's stdio
  codex/mapping.ts    policy/approval/item/usage mapping (pure)
  codex/adapter.ts    one process, one thread, one turn
  claude/messages.ts  SDK message -> AdapterEvent mapper, models, policy mapping (pure)
  claude/adapter.ts   query() wrapper: options, canUseTool, abort
  testing/            fake child, fixture `codex` process, helpers (tests only)
```

## Codex adapter

Each `run()` spawns `codex app-server` (stdio is the default transport, so no `--listen` flag, which keeps older CLIs working) in the session worktree and tears the process down before the promise settles.

1. `initialize` (timeout 20s) with `clientInfo {name: "relay"}`, `experimentalApi: false` and a small `optOutNotificationMethods` list (raw reasoning, live command output, fs/MCP chatter), then the `initialized` notification.
2. `thread/start` (`model`, `cwd`, `approvalPolicy`, `sandbox`, `serviceName: "relay"`) or, when the session has a `providerSessionId`, `thread/resume` (`excludeTurns: true`). A failed resume, or a resume that returns a different thread id, rejects with `resume_failed`. There is no silent fallback to a new thread, which would lose context. The thread id is emitted as `{type: 'session'}`.
3. `turn/start` with the prompt, `model`, `effort`, `approvalPolicy` and an explicit `sandboxPolicy`. The model and effort come from the session as given; nothing is substituted.
4. Notifications are filtered to the run's thread (sub-agent threads are ignored for output; their approval requests are still forwarded).

| Codex message | Result |
| --- | --- |
| `item/agentMessage/delta` | `text` (items separated by a blank line; a completed message only adds text that was not already streamed) |
| `item/started` / `item/completed` for `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `webSearch`, `collabAgentToolCall`, `imageView` | `tool` (name `shell`, `file_change`, `mcp:server/tool`, ...; completion carries status, exit code and an output tail, diffs truncated) |
| `contextCompaction` item, `warning`, `configWarning`, retrying `error` | `info` |
| `thread/tokenUsage/updated` | one `usage` event at the end (see below) |
| `turn/completed` `completed` | run resolves |
| `turn/completed` `failed` | rejects `turn_failed` with message, `codexErrorInfo` tag and HTTP status |
| `turn/completed` `interrupted` | `AbortError` if Relay asked, otherwise `turn_interrupted` error |
| `model/rerouted` | run is interrupted and rejects `model_substitution` (see restrictions) |

**Usage.** Codex reports thread-lifetime totals. A run's usage is the growth since the run started; the baseline is inferred from the first update as `total - last`. `inputTokens` is Codex's `inputTokens` (cached input included), `outputTokens` its `outputTokens`; `costUsd` is always `null` (Codex reports no cost). The event is emitted in `finally`, so failed and interrupted runs still report spend.

**Server requests (approvals).**

| Request | Approve | Deny / failure |
| --- | --- | --- |
| `item/commandExecution/requestApproval` (also network prompts via `networkApprovalContext`, tool `network`) | `{decision: "accept"}` | `{decision: "decline"}` (`cancel` only while aborting, because `cancel` also interrupts the turn) |
| `item/fileChange/requestApproval` | `{decision: "accept"}` | `{decision: "decline"}`; a `grantRoot` is spelled out in the prompt because approving widens write access |
| `item/permissions/requestApproval` | grants exactly the requested subset, `scope: "turn"` | `{permissions: {}}` |
| legacy `execCommandApproval`, `applyPatchApproval` | `{decision: "approved"}` | `{decision: "denied"}` (`abort` while aborting) |
| `mcpServer/elicitation/request` | never approved | `{action: "decline", content: null}` |
| `item/tool/call` (dynamic tools) | never provided | `{success: false, ...}` |
| anything else (including `item/tool/requestUserInput`, token refresh, attestation) | rejected with JSON-RPC `-32601` and an `info` event | |

`acceptForSession`, execpolicy amendments and network policy amendments are never sent: a decision is made once per request. If the host callback throws, the request is declined (fail closed).

**Abort.** On `signal` abort during setup the process is torn down at once. During a turn the adapter sends `turn/interrupt`, waits up to 10s for `turn/completed: interrupted`, then terminates the process (stdin EOF, SIGTERM after 1.5s, SIGKILL after a further 3s; the process is started as a group leader on POSIX so descendants are signalled too). If the turn id is not yet known the interrupt is sent as soon as it is. `run()` then rejects with an `AbortError`.

**Process exit.** Process close rejects every pending JSON-RPC request and the turn with `process_exited`, including exit code or signal and a redacted, truncated stderr tail (last ~1.5k chars). Spawn errors (`ENOENT`, `EACCES`) take the same path. Request timeouts: initialize 20s, thread start/resume 60s, turn/start acknowledgement 60s; a turn itself has no wall-clock limit.

## Claude adapter

`run()` calls the official `query()` once, passing the prompt as a string.

| Option | Value | Reason |
| --- | --- | --- |
| `model`, `effort` | session values | Honoured exactly. No `fallbackModel`. |
| `resume` | `session.providerSessionId` | A missing session returns an error result that is surfaced; no silent new session. |
| `cwd` | `session.worktreePath` | |
| `permissionMode` | `supervised` -> `default`, `balanced` -> `acceptEdits` | `bypassPermissions` and `allowDangerouslySkipPermissions` are never used. |
| `canUseTool` | forwards to `requestApproval` | Allow returns the original input; deny tells Claude not to retry and does not interrupt. `AskUserQuestion` is denied without prompting (no UI for it). |
| `includePartialMessages` | `true` | Text comes from `text_delta` stream events. |
| `pathToClaudeCodeExecutable` | resolved executable | Settings override, else first working install, else the SDK's bundled binary. |
| `settingSources` | `['project']` | User-level settings (allow rules, `defaultMode`) cannot pre-approve tools or override the policy. Project CLAUDE.md is still read. |
| `settings` | `{disableAllHooks: true}` | Hooks from a checked-out repository are not run. |
| `systemPrompt` | `claude_code` preset | |
| `env` | process env minus `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, plus `ANTHROPIC_API_KEY` | |
| `abortController` | linked to `RunOptions.signal` | The SDK terminates the CLI process; `Query.close()` runs in `finally`. |

Message mapping (`claude/messages.ts`): `stream_event` text deltas -> `text` (blank line between text blocks); the complete `assistant` message supplies `tool_use` blocks as `tool` events and supplies text only when that message was not streamed (no duplicates); `user` `tool_result` blocks -> `tool` events named `<Tool>:result`; `system/init` -> `session` (`session_id`); `api_retry` and `model_refusal_no_fallback` -> `info`; `result` -> one `usage` event (input = input + cache read + cache creation tokens summed over `modelUsage`, output tokens, `total_cost_usd`) and either completion or an error built from `subtype`, `errors` and `result`. A run whose stream ends without a `result` fails with `no_result` and the redacted stderr tail. Sub-agent text is not shown; sub-agent tool calls are prefixed `subagent:`.

## Detection (`detectProviders`)

Runs `--version` probes (6s timeout, no shell) and, for Codex, a short app-server session that only calls `account/read` (no token refresh) and `model/list`. No inference is requested, so nothing is billed. The two providers are probed in parallel (about 0.6s on the development machine); concurrent calls with identical settings share one probe.

Executable choice (`discovery.ts`): a non-empty `codexExecutable`/`claudeExecutable` setting is authoritative: if it fails `--version` the provider is reported unavailable with that reason and nothing else is tried. Otherwise every `claude`/`codex` on `PATH` in order, then `~/.local/bin`, then `~/.npm-global/bin`, then (Claude only) the binary bundled with the Agent SDK; the first one that exits 0 and prints a version wins, and skipped candidates are listed in `reason`. On the development machine `/usr/bin/claude` (a broken npm shim: "native binary not installed") is skipped and `~/.npm-global/bin/claude` 2.1.292 is used.

`available` means "a session can be attempted", not "credentials are valid":

* **Claude:** `available` requires a working executable and `ANTHROPIC_API_KEY` in the server environment. The key is never validated without a run; `reason` says so. Without a key the entry is unavailable and explains that Relay does not use claude.ai subscription login.
* **Codex:** `available` requires a working executable, a responding app-server and an account from `account/read` (the account type is reported; the email is not read into the result). `account: null` with `requiresOpenaiAuth` yields unavailable plus a `codex login` hint. If `account/read` itself fails the provider stays available with a note that login could not be verified.
* **Models:** Codex lists come from `model/list` (non-hidden, using the `model` id); if that call fails only the documented default `gpt-6.1-sol` is shown. Claude lists are the official identifiers `claude-sonnet-5-5` (default), `claude-opus-5-5`, `claude-fable-5-1`, `claude-haiku-4-5-20251001`; Relay does not call the Models API.

## Policy mapping

| Relay policy | Codex | Claude |
| --- | --- | --- |
| `supervised` | `approvalPolicy: on-request`, read-only sandbox | `permissionMode: default` (prompts for everything except read-only tools) |
| `balanced` | `approvalPolicy: on-request`, `workspace-write` sandbox limited to the worktree, network off | `permissionMode: acceptEdits` (edits pre-approved, everything else prompts) |

Both forward every approval request to `requestApproval`; neither disables a sandbox or permission check.

## Restrictions and security posture

* **No subscription login.** Claude runs only with `ANTHROPIC_API_KEY`. The run is refused up front without it. The `system/init` message is checked: if Claude Code reports any credential source other than `ANTHROPIC_API_KEY` (for example `oauth`) the run stops before output is forwarded. OAuth/auth-token variables are removed from the child environment. Relay never reads, copies or stores Claude or Codex credential files; Codex authenticates with its own existing CLI login. Cloud-provider variables (`CLAUDE_CODE_USE_BEDROCK` etc.) are not stripped but are not a supported or documented Relay path.
* **No secrets in output.** Error messages, stderr summaries and probe diagnostics pass through `redactSecrets` (API key shapes, bearer tokens, JWTs, `*_KEY/TOKEN/SECRET=` pairs, plus the literal key value). `ANTHROPIC_API_KEY` is removed from the Codex child's environment.
* **No model substitution.** Neither adapter configures a fallback. If Claude reports `model_refusal_fallback` or Codex reports `model/rerouted`, the run is stopped with `model_substitution` and an `info` event, rather than continuing on a different model. A differing model in `system/init` or `thread/start` is reported as `info`.
* **Fail closed.** Approval callbacks that throw or are aborted mean "deny". Unknown server requests are rejected, never auto-approved.
* **No shell strings.** Every process is started with an argv array.
* **No paid calls in tests.** See below.

## Contract notes for the runtime

* `run()` resolves when the turn completes successfully. It rejects with `name === 'AbortError'` when `signal` aborted (a rejection rather than a quiet resolve so an interrupted run cannot be mistaken for success); check `signal.aborted` before recording an error. Other failures reject with `ProviderError` (`code` is a stable tag such as `missing_api_key`, `executable_unavailable`, `resume_failed`, `process_exited`, `timeout`, `turn_failed`, `model_substitution`, `credential_source`).
* `requestApproval` may stay pending for a long time. On abort the adapters stop waiting for it; the host should still resolve it with `false`.
* `session` events can repeat the same id; persist it as `providerSessionId` the first time it is seen.
* `usage` is per run (not cumulative); the host should add it to the session totals.
* Event callbacks that throw are swallowed so a host listener cannot corrupt the protocol loop.

## Tests

`pnpm --filter @relay/server test` runs `apps/server/src/providers/**/*.test.ts` (56 tests, about 3s, no network, no model calls):

* Codex adapter against an in-memory fake child: handshake and parameters, policy mapping, streaming and de-duplication, tool events, every approval type, resume and resume failure, interrupt, SIGTERM/SIGKILL escalation, abort during setup, process exit with redacted stderr, initialize timeout, spawn failure, failed turns, model reroute, foreign threads and malformed lines.
* Codex adapter against a real fixture process (`testing/fake-codex.mjs`): real spawn and stdio framing, approvals round trip, exit mid-turn, a process that ignores interrupt and SIGTERM is killed (checked by pid).
* Claude adapter against a fake `query()` generator: options and environment, de-duplicated streaming, tool and usage mapping, `canUseTool` outcomes, abort propagation, missing key, wrong credential source, error results, fallback model, missing result.
* Discovery and detection with throwaway executables: broken PATH shim, precedence, override authority, timeouts, and Codex detection through the fixture app-server.

Not covered automatically: real model turns, real approvals from the live CLIs and Windows process groups. Those need a manual run with credentials.

## Limitations

* Supervised Codex sessions use a read-only sandbox with `on-request`, so file edits and most commands go through approvals; that is deliberate but can be chatty. Git operations inside a linked worktree touch the shared `.git` directory outside the worktree and will normally need approval in both modes.
* Each run starts a new app-server process and re-attaches the thread (a fraction of a second on the development machine). There is no process pooling.
* Codex `inputTokens` includes cached input; Claude's includes cache reads and writes. Neither is a billing figure.
* Claude project `.claude/settings.json` allow rules are still honoured (user-level settings are not); hooks are disabled.
* Cloud-provider authentication for Claude (Bedrock, Vertex, Foundry) is not implemented.
* The Claude model list is static; entries may need updating as models are released.
* The `claude_code` system prompt preset and tool set are whatever the installed Claude Code version provides.

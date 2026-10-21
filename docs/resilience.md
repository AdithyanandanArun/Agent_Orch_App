# Recovery and resilience contract

Mingle's resilience layer preserves what the host actually knows about a session or group. A checkpoint references workspace state; it does not claim that edits, tasks or acceptance criteria completed. Native provider conversations remain owned by their providers.

## Autonomy and limits

`AutonomyConfig` supports `supervised`, `balanced` and `extended`; new group defaults are balanced. Group defaults use 80 turns (maximum 10,000). New groups receive that default, while stored per-group values such as 16 remain unchanged. The optional `emergencyTurnLimit` has three distinct meanings:

- Omitted: use that group's saved `maxTurns` ceiling.
- `null`: disable the turn ceiling.
- A number from 2 to 10,000: use this explicit effective ceiling instead of `maxTurns`.

Task finish criteria preserve whether acceptance conditions were explicit or derived and can require evidence or human review. No group turn, task, delivery or hop count is reset by retry or resume.

Fallback is a group-level `GroupRecoveryPolicy`, not a group default. `automaticFallback` defaults false; configured lead and worker fallbacks name existing members and are validated by the group service. A fallback uses that member's saved native session and settings as-is. It never creates a member or mutates the provider/model/permissions of an existing native conversation.

## Durable data and bounds

Migration 11 is additive and introduces:

- Group `autonomy_policy`, `recovery_policy`, `recovery_state` and monotonically increasing `coordinator_epoch`; each claimed delivery records the epoch under which it was dispatched.
- `session_checkpoints`, versioned and bounded to 64 KiB, at most 20 per session.
- `session_failures`, addressable by `runId`, retaining the most recent 20 per session. Resolution marks a failure as no longer current but preserves its per-run record for old deliveries and repeat-failure analysis. A failure record is saved before the scheduler's run-finished callback.
- `group_recovery_actions`, idempotent by `(group_id, idempotency_key)`.
- `group_recovery_checkpoints`, for durable batch acknowledgement/Ask me checkpoints.
- `group_assignment_milestones`, retaining acceptance provenance and a bounded reference to host evidence.
- `group_stall_evidence`, retaining fingerprinted evidence/counters rather than transcripts.

Checkpoints include an objective reference, assigned task titles/descriptions/acceptance criteria/status, actual worktree path/branch/HEAD/dirty paths, group artifact references, pending approval summaries, bounded errors and uncertain tool summaries. They never include approval inputs, tool input/output, complete source files, credentials, or full unbounded message transcripts. Git uses argv arrays with noninteractive, bounded status/metadata commands. Missing Git data yields `statusKnown: false` and a notice; it is not represented as a clean state. Dirty paths cap at 500 and the whole serialized checkpoint caps at 64 KiB. Every checkpoint carries schema `version: 1`. A restart captures a checkpoint for each session recovered from a running/waiting state; shutdown drains outstanding checkpoint captures before SQLite closes.

Failure records retain a stable provider failure kind, provider code when safely reported, retryability, dispatch certainty, outcome uncertainty, continuation safety, optional known non-secret quota pool, a bounded retry time and redacted visible reason. `retryable: true` does not mean replay is safe. `safeToRetry: true` is required as positive proof before a scheduler can retry automatically; omitted safety is unknown. HTTP 429 alone is never classified as quota exhaustion. Ambiguous host mutations are never automatically replayed, and output truncation is not successful completion.

## Recovery API

`RecoveryService` is constructed with the shared `Store` and exposes:

```ts
capture(sessionId: string, reason: string, runId?: string): Promise<RecoveryCheckpoint>
latest(sessionId: string): RecoveryCheckpoint | null
recordFailure(sessionId: string, runId: string, failure: ProviderFailure): void
failure(sessionId: string): ProviderFailure | null
failureForRun(runId: string): ProviderFailure | null
clearFailure(sessionId: string): void
```

`capture` verifies optional run ownership, inspects Git without modifying the worktree or index, and persists only bounded references. Failure and checkpoint state are independent: a new checkpoint never clears or overwrites a failure. `clearFailure(sessionId)` resolves current visibility while retaining each historical failure addressable through `failureForRun(runId)`.

### HTTP routes

All paths are under `/api`:

| Route | Request | Response |
| --- | --- | --- |
| `GET /sessions/:id/recovery` | — | `{ checkpoint: RecoveryCheckpoint \| null, failure: ProviderFailure \| null }` |
| `POST /sessions/:id/checkpoints` | `{ reason: string (1–200), runId?: string }` | `RecoveryCheckpoint` (201) |
| `POST /groups/:id/recovery` | `RecoveryActionRequest` | `RecoveryActionResult` |
| `POST /sessions/:id/compact` | `{}` | `ContextCompactionResult` |

The strict recovery action union is idempotency keyed and supports retry with an optional approach note, delivery reassign to a selected existing member, coordinator replacement, Ask me/pause, acknowledgement of a specific durable checkpoint, and explicit resume. Group recovery calls `GroupService.recoverAction`; startup's `recover()` remains distinct. Stale action state is revalidated in the group service, not trusted from a renderer snapshot.

## Coordinator fencing and delivery semantics

Lead replacement is one SQLite transaction that updates the group's coordinator member/role, rewrites actionable request planner authority, and increments `coordinator_epoch`. Every claimed delivery snapshots that epoch. Team tool operations revalidate role and epoch when invoked and after any awaited artifact/path verification. Stale leads cannot dispatch. Independent workers already running are not invalidated merely because the lead is unavailable; only new lead-dependent dispatch pauses. Recovery actions and duplicate message deliveries use durable idempotency keys. A resume or replacement never clears a worker's cleanup lock, abandons dirty edits, merges branches or changes task acceptance.

## Manual context compaction

`SessionRuntime.compact(sessionId)` targets one session. It synchronously reserves the same active/cleanup lock used by provider runs before its first `await`; `isActive()` and resource counts include the compaction. A same-session run/approval/cleanup conflict returns 409. Interruption/shutdown abort the adapter and keep the lock until native cleanup settles. The runtime takes a pre-compaction checkpoint, records durable `session.compaction.started|completed|failed|unsupported` events, returns the pre-compaction checkpoint ID, and tries a post-operation checkpoint without allowing checkpoint errors to change the native operation's result.

Native support is capability-based:

- **Codex app-server:** `thread/compact/start`; success follows the completed native `contextCompaction` item.
- **Claude Agent SDK:** resume and issue `/compact` only when `supportedCommands()` advertises the built-in command; verify the SDK result and compaction boundary.
- **OpenCode ACP:** use the native local server's `POST /session/:id/summarize` only when the current native session/provider/model are bound and the server confirms success.
- **Antigravity ACP:** invoke only an advertised native compact command; ACP compaction updates alone are reports, not requests.

Unavailable/unsafe capabilities return `unsupported` or `failed`; Mingle does not send a generic `/compact` prompt, invent a summary, run ordinary tools, bypass the saved permission policy, or silently create a replacement native conversation. See the provider worker's dated research note for primary sources and observed limits.

# Distributed execution service API

`RemoteExecutionService` is a device-local boundary implemented in `apps/server/src/distributed/execution.ts`. It does not create provider credentials, remote sessions, direct network listeners, or group deliveries. The HTTP and application wiring remain the caller's responsibility. Contracts are exported directly from `packages/contracts/src/remote-execution.ts`; the application root contract index can re-export them during integration.

## Constructor and structural adapters

```ts
new RemoteExecutionService({ store, account, transport, runtime, workspace, providers, changed })
```

- `store.db` is the existing `DatabaseSync`. The service creates only `mingle_remote_*` tables/indexes in this local database; those tables contain local runtime data, not provider credentials or keys.
- `account.withAuthenticatedClient(callback)` must call server-side `auth.getUser()` for each callback and pass the authenticated client and verified UUID. The service checks active membership and device ownership through `mingle_members` and `mingle_devices` on every authority-sensitive call. It verifies the shared project in `mingle_projects` and checks both directional `mingle_device_links` before peer operations. Account-backed operations have a bounded five-second default deadline (`accountTimeoutMs` can configure 250–30,000 ms); a timed-out lookup fails closed.
- `transport.snapshot(teamId?)` returns `{localDeviceId, devices:[{id,teamId,ownerId,linked,revokedAt,online?}]}`. `send({teamId,toDeviceId,kind,payload,idempotencyKey})` must encrypt/authenticate and durably deliver the envelope. `onMessage(handler)` supplies `{id,teamId,fromDeviceId,toDeviceId,kind,payload}` only after device authentication and returns an unsubscribe function. Transport retries handler failures; it owns cryptographic keys and mailbox replay protection.
- `runtime` is the existing structural interface `{start(sessionId, content, options): runId, isActive(sessionId)}`. `start` is synchronous. The service reserves dispatch durably before the call and never invokes it again for the same request. It never supplies `groupDeliveryId`.
- `providers.localAlternatives({projectId,sourceSessionId,taskId})` returns every eligible local alternative as `{sessionId,provider,model,eligible,state,reason?}` where state is `available`, `busy`, `quota-exhausted`, `provider-unavailable`, or `unknown`. An alternative is exhausted only for the two positive failure states; busy/unknown/available block fallback. `quotaForSession(session)` returns `{state:'available'|'exhausted'|'unknown',observedAt,reason?}` from a real local quota read. Missing or stale reports must be `unknown`.
- `workspace.isUnpublishedWork({projectId,sourceSessionId,taskId})` checks the local recovery/repository store; caller-supplied failure or unpublished flags are not accepted. `captureCheckpoint(sessionId,reason,runId?)` may create a local checkpoint. `subscribeSession(sessionId,listener)` must be a store subscription that exposes only minimized `{runId,kind:'status'|'progress'|'result',status?,summary?,delta?,terminal?}` updates, never tool input/output or approval data. Events are matched to the exact dispatched run ID.
- `changed()` is a local snapshot notification callback.

These adapters are structural to keep the distributed package independent of not-yet-integrated account, transport and application classes. The project/team workers' cloud tables follow the shared blueprint: `mingle_members(team_id,user_id)`, `mingle_projects(id,team_id)`, `mingle_devices(id,team_id,owner_id,revoked_at)`, and directional `mingle_device_links(team_id,device_id,peer_device_id)`.

## Service methods and request shapes

All methods parse strict Zod schemas in `remote-execution.ts`. `snapshot(teamId?)` returns exactly:

```ts
{
  bindings: RemoteProjectBinding[], agents: RemoteAgent[], requests: RemoteExecutionRequest[],
  approvals: RemoteApproval[], messages: RemoteCollaborationMessage[],
  tasks: RemoteCollaborationTask[], events: RemoteExecutionEvent[]
}
```

Without a team ID, it returns only teams for which the current verified account is still a member and the current registered device is owned by that account. Device-local approvals are visible only on the device that recorded them. Presence and quota observations age to `unknown` after two and five minutes respectively; disconnected peers appear offline and are not fallback candidates. A remote fallback candidate needs a currently linked/online device, fresh idle presence and fresh known available quota.

| Method | Input schema / behavior |
| --- | --- |
| `bindProject(input)` | `BindRemoteProjectSchema`: `{teamId,sharedProjectId,localProjectId}`. Validates active membership, remote project and active local project; binding is per account and device. |
| `publishAgents(input)` | `PublishRemoteAgentsSchema`: `{teamId,sharedProjectId,sessionIds}`. Explicitly publishes only supervised Claude, Codex or OpenCode sessions in the bound project. Non-supervised sessions reject without changing saved policy. Publishes metadata/presence/quota only; it does not execute. Group membership is exposed as identity metadata, but grouped sessions cannot be remotely started. |
| `refreshPublishedAgents(input)` | `{teamId,sharedProjectId}`. Refreshes the already-published local roster's saved name/model/config digest/group and runtime presence, then republishes the metadata. It does not probe quota or submit inference; quota freshness remains tied to the last explicit quota observation and ages to `unknown`. |
| `suggestFallback(input)` | `SuggestRemoteFallbackSchema`: `{teamId,sharedProjectId,sourceSessionId,taskId}`. Reads the matching latest local durable provider-failure record and checkpoint, checks local run/tool cleanup, and asks the injected local-alternative resolver. It returns `{eligible,reason,evidence,localAlternatives,candidates}` and records a suggestion event; it does not send or execute work. |
| `requestDelegation(input)` | `RequestRemoteDelegationSchema`: `{teamId,sharedProjectId,sourceSessionId,taskId,agentId,mode,content,maxSpendUsd?,allowUnverifiedTarget?,idempotencyKey}`, where `mode` is `provider-failure` or `unpublished-recovery`. Provider-failure mode requires a matching positive durable quota/provider-unavailable failure, safe continuation, no unknown tool effects, a durable checkpoint, at least one eligible local alternative and positive exhaustion of every eligible local alternative. The default target requirement is fresh known-idle/known-available quota. A direct caller may set `allowUnverifiedTarget:true` to ask an idle destination whose quota is unknown, but this does not change its status or qualify it as an automatic suggestion. Unpublished recovery requires local repository/store proof and is an explicit human request. It sends an `execution.request`; receipt never starts inference. `maxSpendUsd` is an optional informational estimate, not a cap. |
| `decide(input)` | `DecideRemoteExecutionSchema`: `{requestId,expectedDigest,decision:'approved'|'denied',allowProviderSpend,allowUnverifiedQuota?,shareProgress?}`. Only the account owner of the destination device can decide. Approval is one-time and bound to the displayed request digest, device, owner, project, agent/session configuration, task/dependencies and explicit one-run provider-spend consent. Unknown quota can proceed only when the request explicitly allowed an unknown target and the destination owner explicitly sets `allowUnverifiedQuota:true`; a known exhausted quota always blocks. On approval the service rechecks current quota, project/session binding, source device and links, atomically consumes the grant and writes `dispatching`, then calls the synchronous runtime `start` once. |
| `onEnvelope(envelope)` | Authenticated transport callback. Accepts `execution.request`, `execution.agents`, `execution.status`, `collaboration.message`, and `collaboration.task`. Peer `execution.approval`/`execution.decision` payloads reject; all senders, owners, memberships, project bindings and links are rechecked. Duplicate envelope IDs are idempotent. |
| `sendMessage(input)` | `SendRemoteMessageSchema`: `{teamId,sharedProjectId,content,agentId?,groupId?,taskId?,dependsOn?,idempotencyKey}`. Adds authenticated device/account attribution and publishes a shared conversation message. |
| `publishTask(input)` | `PublishRemoteTaskSchema`: `{teamId,sharedProjectId,taskId,agentId?,groupId?}`. Shares task status, acceptance criteria and dependency references without changing either local task. |
| `close()` | Unsubscribes from transport and local progress subscriptions. Startup changes leftover `dispatching` requests to `uncertain`; it never resumes them. |

The destination owner receives `RemoteExecutionRequest.evidence.unverifiedAtDestination: true` and must approve the exact request before work runs. The generated continuation prompt labels source evidence unverified, includes bounded task/checkpoint progress and committed references, instructs the destination to inspect its own files, and prohibits replaying prior tool actions. Credentials, tool approval inputs, tool outputs, and source files are not transferred.

## State and safety boundaries

The request state moves through `awaiting-approval` → `dispatching` → `dispatched` → `completed`/`failed`; denial is `denied`. If dispatch throws after the reservation, or a process restarts while `dispatching`, the durable state becomes `uncertain` and cannot be retried automatically. This is at-most-once dispatch, not a promise that the provider actually received the request. Unknown source tool effects, pending source approvals, unsafe failure continuation, missing checkpoint, active source cleanup, and unknown destination quota all block dispatch.

`allowProviderSpend` is the explicit one-run owner authorization. Only `supervised` destination sessions are publishable and dispatchable; policy is checked again against current session configuration immediately before dispatch. The continuation prompt tells the agent that push/merge and permission grants remain separately owner-gated. `maxSpendUsd` is optional and, when present, is only an informational estimate included in the immutable request digest. The current synchronous `SessionRuntime.start` API has no provider-enforced dollar cutoff; Mingle does not claim or enforce a hard dollar cap. No estimate or rate is invented when none is provided.

The service subscribes for completion regardless of `shareProgress`. Terminal state is persisted by exact request/run ID and sent to the source device even when progress sharing was declined. Progress callbacks are serialized and drained by `close()` before the caller may close SQLite; account-backed publication has a bounded deadline, and transport delivery remains the transport's durable outbox responsibility. Startup marks both `dispatching` and `dispatched` requests `uncertain`, because a crash cannot establish whether native work completed.

The service will not forge `groupDeliveryId`. Sessions in local groups remain visible in agent metadata with their group ID, but remote start rejects until a future integration routes a request through a real recorded local group delivery. No remote approval stands in for local Git push/merge or command approvals.

`RemoteExecutionService` does not currently add an HTTP route or export through `packages/contracts/src/index.ts`; the parent integration owns both. No cloud migration is performed by this worker.

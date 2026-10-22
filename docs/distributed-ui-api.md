# Distributed team workspace UI API

The Team workspace Settings section uses an isolated client at `apps/web/src/components/distributed/api.ts`. Every request is same-origin under `/api/distributed`; the renderer never contacts the cloud mailbox or provider directly. The UI submits no credentials or device-owner assertions. Service authorization remains authoritative on the receiving device.

## Routes and request bodies

| Method / path | Request body or query |
| --- | --- |
| `GET /snapshot?teamId=<id>` | Optional `teamId`. Snapshot sections are `{teams,transport,execution,git,commands}`. |
| `POST /teams` | `{name}` |
| `POST /invitations` | `{teamId,email,role}`; a one-time token is shown only if returned by this creation call. |
| `POST /invitations/accept` | `{token}` |
| `POST /members/revoke` | `{teamId,userId}` |
| `POST /projects` | `{teamId,name,repositoryUrl?}` |
| `POST /devices/register` | `{teamId,name}` |
| `POST /devices/link` | `{teamId,deviceId,fingerprint}` |
| `POST /devices/revoke` | `{teamId,deviceId}` |
| `POST /sync` | `{}` |
| `POST /projects/bind` | `{teamId,sharedProjectId,localProjectId}`; local project ID comes from the local bootstrap. |
| `POST /agents/publish` | `{teamId,sharedProjectId,sessionIds}`; only explicitly checked sessions in the current local project are sent. |
| `POST /messages` | `{teamId,sharedProjectId,content,idempotencyKey}`. No agent identity is asserted by the renderer. |
| `POST /delegations` | `{teamId,sharedProjectId,sourceSessionId,taskId,agentId,mode,content,idempotencyKey}` where `mode` is `provider-failure` or `unpublished-recovery`. Destination provider spending is not represented as a guessed dollar cap; it requires explicit destination-owner consent. |
| `POST /fallbacks/suggest` | Exactly `{teamId,sharedProjectId,sourceSessionId,taskId}`. Available only for a recorded local session/run failure. This returns eligibility/candidates and does not create or dispatch a delegation. A separate, explicit delegation request is required after selecting a reported candidate. |
| `POST /approvals/:id` | `{expectedDigest,decision,allowProviderSpend,allowUnverifiedQuota,shareProgress}`. The route ID supplies `requestId`; the UI deliberately strips it from the body. `expectedDigest` is copied from the displayed `execution.requests[].digest`; it is never fetched implicitly at decision time. `shareProgress` defaults false. Provider spend must be explicitly allowed for approval. Unknown native quota remains unknown; a separate one-run consent is shown when quota is unverified, including OpenCode where quota is not reported. |
| `POST /git/request` | `{idempotencyKey?,teamId,sharedProjectId,toDeviceId,expectedHead,baseHead?,branch?}`. This only requests a Git bundle transfer. |
| `POST /git/:id/decision` | `{decision,expectedDigest}` where the route ID supplies `requestId` and `expectedDigest` is the displayed `git.requests[].requestDigest`. The body does not duplicate the route ID. |
| `POST /git/integrate` | `{idempotencyKey?,teamId,sharedProjectId,incomingRequestId,action,expectedHead,expectedFingerprint,remoteName?}`. `action` is `merge` or `push`; `remoteName` is required only for push. Integration is distinct from transfer import and uses the displayed HEAD/fingerprint. |
| `POST /commands/request` | `{idempotencyKey?,teamId,sharedProjectId,toDeviceId,operation,cwd}`. `operation` is one of the contract's structured Git read operations (`git.version`, `git.status`, `git.head`, `git.branch`, `git.log`, `git.showStat`, `git.diffStat`); no free-form executable or argv is submitted. |
| `POST /commands/:id/decision` | `{decision,expectedDigest}` where the route ID supplies `requestId` and `expectedDigest` is the displayed `commands.requests[].requestDigest`. The body does not duplicate the route ID. |

## Snapshot and approval handling

Execution data uses the service contract's `bindings`, `agents`, `requests`, `approvals`, `messages`, `tasks`, and `events` arrays. The actionable destination-owner queue is derived only from `execution.requests` where `state === 'awaiting-approval'` and `targetDeviceId` equals the local device ID. Resolved `execution.approvals` are historical decisions, not pending requests. Each approval displays the request digest, destination device/owner, provider/model, reported quota state, task details/acceptance/dependencies, shared project, request content and recovery evidence when present.

Remote agent availability uses the explicit `presence` (`idle`, `busy`, `offline`, or `unknown`) and quota uses `quotaState` (`available`, `exhausted`, or `unknown`). Unknown is never labeled available. Fallback suggestions are displayed only from the service's actual eligibility/candidate response; agents with unknown quota are not presented as available automatic suggestions. Shared group IDs and task dependency IDs are shown only when present in actual snapshot records.

Git decisions bind to the displayed `requestDigest`; bundle imports and merge/push integration remain distinct. Command decisions also bind to `requestDigest`, show the exact structured operation and project-relative directory, and render service audit entries separately from Git audit entries. Stale decisions are returned as visible service errors; the UI does not silently refresh and replay a decision.

The execution worker is changing `RequestRemoteDelegationSchema.maxSpendUsd` from a required cap to an optional informational field. The UI intentionally omits it rather than inventing a dollar budget. The destination decision uses explicit `allowProviderSpend` consent and displays that Mingle cannot guarantee a dollar cap.

Snapshot polling runs every 5 seconds while this Settings section is mounted and visible; browser focus, visibility return and local workspace event changes also refresh it. Form drafts are held in component state and are not reset by snapshot refreshes. HTTP failures remain visible, including sign-in, missing-route, migration and network errors.

The integration includes an interactive shared agent map using reported ownership, hosting, assignment and explicit dependency relationships. Source-transfer and local merge/push approvals appear alongside incoming-import approvals. Execution disclosure includes the source checkpoint commit and committed artifact references. The local project binding is read from the execution binding records, and device rows expose their IDs for reciprocal linking.

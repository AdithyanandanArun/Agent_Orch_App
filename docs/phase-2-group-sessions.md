# Phase 2 — Group sessions and an orchestrator

Status: proposed implementation specification, based on the owner's updated vision. Group conversations, participant messaging and automatic delegation are not implemented yet. Phase 1's independent provider sessions remain the execution foundation.

## Experience

A session can become a group conversation through **Add agent**. It has one shared timeline, independent coding agents and a designated orchestrator. Users can address an agent with a handle such as `@claude1` or `@codex1`. Messages with no agent recipient go to the orchestrator. The orchestrator breaks a request into work, delegates to available members, receives results and gives the user a consolidated response.

Each agent retains its own provider conversation, model, effort, permissions and working directory. Its conversation history and tool activity remain attributable to that agent. Adding an agent does not broadcast the whole history to every model or start a provider run.

### Settings

Add **Settings → Agents & orchestration** with:

- Default orchestrator provider, model, reasoning effort, service tier and permission policy.
- Worker defaults, using the provider's currently advertised model/effort/permission capabilities.
- Maximum simultaneous worker runs and bounded automatic delegation/message rounds.

These are defaults for new groups and new participants. Existing participants keep their saved settings. A group can select another orchestrator explicitly while coordination is idle; changing providers creates/selects another independent participant rather than rewriting an existing native conversation.

### Adding an agent

Use one compact dialog that previews all effective choices before adding the participant:

| Field | Behavior |
| --- | --- |
| Provider | Codex or Claude, with actual availability and failure reasons |
| Handle | Suggested unique handle, editable before adding |
| Model | Current provider-supported choices |
| Effort | Choices supported by that model |
| Permissions | Explicit native permission policy |
| Workspace | New isolated worktree by default; actual folder/branch shown |

The first conversion of a single-agent session also previews the orchestrator from Settings. Proposed default: create a separate orchestrator and retain the existing agent as a worker, preserving its provider conversation and directory. The owner can instead choose to keep the existing agent as orchestrator. This role choice is recorded explicitly.

Because the existing agent may now have a narrower role, the same dialog offers **Keep current settings** or **Change model and effort** for it. Show the current and proposed values together. Do not silently downgrade a model, lower effort, change permission policy or substitute a provider. Apply configuration changes only when that member is idle and provider cleanup has finished. Unsupported choices produce an actionable error.

### Routing

| User action | Destination |
| --- | --- |
| Send without an agent mention | Designated orchestrator |
| Send to `@claude1` | That member only |
| Send to `@codex1` | That member only |
| Explicitly select several agent recipients | The selected recipients; composer previews recipients before sending |
| Use `@claude` / `@codex` | Resolve only when exactly one member matches; otherwise choose a member |

Mentions autocomplete from this group's active membership. Unknown or removed recipients reject dispatch rather than falling back to the orchestrator. Preserve stable member identities and do not reuse retired handles within the conversation. Routing uses resolved participant IDs, rather than reparsing arbitrary message prose. Code blocks, quoted text, URLs and an agent merely printing a handle do not dispatch runs. Multiple recipients receive the explicitly addressed request; the router does not invent per-agent task scopes from punctuation. Task scopes are explicit in orchestrator assignments.

The orchestrator remains aware of task/result events, but a directly addressed worker message does not automatically launch an additional orchestrator turn. Informational updates can remain machine events until reasoning is needed.

### Timeline

Keep the existing minimal conversation layout. Agent responses have a small handle/role label so the speaker is clear, without provider icons. Human messages retain their current bubbles. Delegations show their sender, recipient and delivery state. Tool calls, working time, approvals and changed-file cards belong to the real member/run that produced them.

A compact member control opens participants and their settings; do not add a permanent collection of agent dashboards around the conversation. Keep Tasks, Activity and Agent Map synchronized with assignments, dependencies and actual run state.

## Runtime and persistence

Separate the shared conversation from the provider runtime:

- **Group:** project, title, orchestrator member and orchestration settings.
- **Member:** stable identity, group, unique handle, role and existing provider `Session` ID.
- **Group message:** ordered shared entry, sender, resolved recipients, optional reply/correlation IDs and source session-message/run reference.
- **Delivery:** recipient, logical message ID, claim/delivery state, attempt and associated run.
- **Assignment:** task, owning member, input artifacts, permitted edit scope, expected output and acceptance criteria.

Keep current provider sessions as independent execution units: one active run per member, with their existing native conversation IDs, approvals, worktrees and persistence. Task ownership can continue referencing the underlying session, with group membership resolved by the server. Existing single-agent sessions remain usable without being forced through a multi-model orchestration step.

Existing history remains linked to its original session; conversion does not replay it as a new user prompt or duplicate its durable records. Give the new orchestrator a bounded bootstrap containing the current request, project context, member capabilities, active tasks and relevant prior decisions, with explicit references to additional history it can retrieve.

SQLite stores membership, group messages, deliveries and assignments. WebSocket deltas include enough group/member identity to update the shared timeline without mixing simultaneous assistant streams. Use server sequence numbers for ordering; preserve each provider run's actual timing independently.

### Agent communication

Both providers receive a narrow, run-scoped team tool interface, following the existing server-owned browser capability pattern. Proposed operations are:

- List members and their actual status/capabilities.
- Assign a bounded task to an eligible worker.
- Send a targeted question or reply.
- Publish a verified artifact reference.
- Report progress, completion or a blocker.
- Retrieve relevant project/task context and unread messages.

The server validates group membership, recipient, task ownership, dependencies and current permissions for every operation. It derives the sender from the invoking run. A worker cannot impersonate the orchestrator or create a more privileged agent. Assignment scheduling belongs to the orchestrator; workers can communicate directly without gaining arbitrary delegation authority.

A dispatch tool result confirms acceptance/queueing, not successful completion. UI mention labels correspond to real recorded tool actions. Relay does not execute commands by looking for `@...` text in model output.

### Efficient context exchange

Use the communication layers from the original vision:

1. **Structured events** for status, queue changes, task ownership, artifact availability and completion. Recording an event does not itself require an LLM turn.
2. **Compact payloads** for actual assignments and questions: task ID, concise objective, constraints, output contract, acceptance criteria and exact file/commit references.
3. **Natural language** for design decisions, questions and unresolved ambiguity.

A receiving agent reads new messages, required decisions and referenced artifacts. It does not receive every other agent's raw transcript on each turn. Store project decisions and interfaces durably; summaries retain provenance and links to the full source. Begin with validated JSON and existing contracts; evaluate alternative encodings by measured token use and correctness before adopting them.

For example, an artifact announcement identifies the source member, task, repository, path, immutable commit and blob. The server verifies the reference using the existing handoff boundary before offering it to another member.

## Automatic delegation and recovery

An unaddressed user work request can authorize the orchestrator to assign work to the configured members within that group's visible limits. Routine assignments do not require another confirmation for each worker. The orchestrator selects among actual available members and their configured capabilities; it does not silently replace their models or permissions.

The server queues work for a busy member. Incoming peer messages join its inbox and become available at a safe turn boundary; they never start an overlapping native turn. A request requiring an answer may wake an idle member within the active orchestration budget. A status notification does not need a new model run. Batch result notifications for the orchestrator to avoid a separate reasoning turn for every tool event.

Every logical message and assignment has a stable ID for deduplication, with reply/correlation IDs for traceability. Delivery and consumption are recorded separately. Retries after a failed start retain unread context and do not claim successful delivery. Provider failures, exhausted quota, unavailable credentials and blocked permissions remain visible. Switching models or providers remains an explicit user choice.

Bound parallel workers, automatic model turns, message hops and repeated attempts. A known exceeded limit pauses new automatic work and shows the reason; unknown provider cost is never presented as an enforceable exact spend cap. Prevent self-dispatch and notification ping-pong. The user can stop one member or the whole group, inspect queued work and explicitly resume it.

On application restart, retain conversations, tasks, messages and queued assignments, mark killed runs interrupted and expire old approvals. Do not silently resume paid model runs merely because the app reopened.

## Workspaces and integration

New workers and the orchestrator use separate worktrees by default. An existing or imported member keeps its current directory until explicitly changed through a supported flow. Show when it works directly in the project folder. Task assignments identify edit ownership; concurrent writers cannot be assigned overlapping integration work without coordination.

Artifact readiness and final acceptance remain separate. A verified committed contract can unblock a consumer through an explicit artifact dependency, while the producing task remains in Review. Legacy task dependencies continue requiring Done. Do not mark an upstream task accepted solely to get around the current dependency gate.

The orchestrator can prepare and review integration in its own worktree under its permission policy. Publishing and changes to the user's selected checkout retain explicit controls. A consolidated answer identifies worker contributions, integrated revisions, conflicts and what still needs review. Separate commits in different worktrees do not by themselves constitute an integrated result.

Browser access continues to honor the actual connection/tab owner and human control. Adding a participant does not grant it ownership of another participant's browser tabs.

## Delivery sequence and acceptance

1. **Group foundation:** additive persistence and shared timeline; convert an existing session without losing history; retain standalone operation.
2. **Explicit addressing:** add/configure members, mention completion, deterministic routing, independent streams and member/group stop controls.
3. **Orchestrator:** saved defaults, optional adjustment of the current member, bounded automatic task dispatch and visible queue state.
4. **Peer communication:** durable targeted requests/replies, compact context retrieval and verified artifact handoff; no duplicate or overlapping runs.
5. **Integrated proof:** one unaddressed request reaches the orchestrator, Codex produces a committed API contract, Claude consumes that exact revision and implements the UI, and the orchestrator prepares the combined result for review without manual copying.

Acceptance must include preserved original history and provider conversation IDs; actual model/effort/policy in the add-agent preview; only intended recipients running for direct mentions; live simultaneous streams remaining distinct; changes to busy members refusing safely; restored pending messages without duplicate dispatch; bounded communication; and visible interruption/failure behavior. A real provider-backed integration demonstration requires explicit owner authorization for its model runs. Completion evidence must distinguish implementation, local checks and the live demonstration.

The current record defines the next phase. It does not declare any group-session feature complete. Distributed computers, voice control and general autonomous integration remain later milestones.

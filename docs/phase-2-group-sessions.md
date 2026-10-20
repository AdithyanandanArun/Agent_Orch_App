# Phase 2 — Group sessions and coordination modes

Status: implemented in the application, based on the owner's updated vision. Group conversations, participant messaging and bounded automatic delegation use Phase 1's independent provider sessions as their execution foundation. Local implementation checks and the remaining paid integration demonstration are recorded separately below.

## Experience

A session can become a group conversation through **Add agent**. The first conversion offers three explicit modes: **Cowork**, **Orchestrated** and **Current agent leads**. All use one shared timeline and independent agents addressed through handles such as `@claude1` or `@codex1`.

| Mode | Leadership | An unaddressed user message | Existing agent |
| --- | --- | --- | --- |
| Cowork | The human directs equal agents | Delivered to all active peers; one peer proposes the request's work split | Remains an equal peer with its history and configuration |
| Orchestrated | A separate agent from Settings coordinates workers | Goes to the orchestrator, which delegates and consolidates results | Becomes a worker; user chooses whether to adjust its configuration |
| Current agent leads | The existing agent becomes the orchestrator | Goes to the existing agent, which delegates to the new worker and reviews results | Keeps its native conversation, history, model, effort and permissions |

Cowork has no separate orchestrator participant or permanent lead agent. It avoids adding a coordinator model, but broadcasting work to multiple agents still consumes their tokens. Do not claim a fixed saving or that more agents always cost less.

### Current agent leads

The existing session becomes the group's orchestrator without creating a separate coordinator. Its native conversation, history, configuration and directory remain intact. The new session becomes an independent worker under that orchestrator; additional agents join as workers. Unaddressed messages continue to reach the existing agent, which can assign scoped work and review results. Both agents can exchange targeted questions and artifacts through the shared team tools.

Preview the new worker's provider, model, effort, permissions and workspace before adding it. Do not show the existing-worker downgrade question: the existing agent is still leading. Its configuration remains editable through member settings when idle. Settings defaults do not replace its current configuration.

### Cowork request coordination

Both peers receive the user's request. The host grants one peer a temporary, per-request planning lease; propose the existing agent initially because it has the conversation context. That peer proposes a split and performs its own share. The other peer waits for a concrete scope before editing, then receives the original request together with its assignment. Request receipt and model execution are separate events. No additional coordinator conversation or coordinator inference turn is created.

The temporary planner can allocate this request among the selected peers, ask questions and publish revised proposals. It cannot change their configuration or permissions, add agents, or permanently claim leadership. Stable assignment IDs and host-checked scopes prevent two competing splits or duplicate dispatch. The human can adjust the plan and address either peer directly. Subsequent requests can select a different temporary planner; being first to respond does not grant authority.

Peers exchange targeted questions, artifact references and progress directly. Informational updates remain structured events. A summary from one peer is labeled with that peer's identity; it is not presented as an independent orchestrator review.

Each agent retains its own provider conversation, model, effort, permissions and working directory. Its conversation history and tool activity remain attributable to that agent. Adding an agent does not broadcast the whole history to every model or start a provider run.

### Settings

Add **Settings → Agents & orchestration** with:

- Default orchestrator provider, model, reasoning effort, service tier and permission policy, used only when creating the separate coordinator in Orchestrated mode.
- Worker defaults, using the provider's currently advertised model/effort/permission capabilities.
- Maximum simultaneous worker runs and bounded automatic delegation/message rounds.

These are defaults for new groups and new participants. Existing participants keep their saved settings. A group with an orchestrator can select another orchestrator explicitly while coordination is idle; changing providers creates/selects another independent participant rather than rewriting an existing native conversation.

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

First choose Cowork, Orchestrated or Current agent leads, then configure the new agent. The choice screen explains the routing with original, small animated diagrams and plain language. Adding an agent creates no extra coordinator in Cowork. In Orchestrated mode, preview the separate orchestrator from Settings, preserve the existing agent as a worker, and show the complete roster before confirming. Current agent leads shows the existing agent as orchestrator and the new participant as worker, with no separate coordinator. No mode silently creates a paid model run.

Only the Orchestrated conversion asks **Keep the current agent's configuration?** with **Keep current configuration** and **Change configuration** options. Show model, effort and permissions in the preview; expanding Change makes the settings editable. Keep history and native conversation identity when changing supported model/effort within its provider. Cowork and Current agent leads keep the current configuration; the user can still edit it through the member settings.

The Orchestrated configuration step shows the current and proposed settings together. Do not silently downgrade a model, lower effort, change permission policy or substitute a provider. Apply configuration changes only when that member is idle and provider cleanup has finished. Unsupported choices produce an actionable error.

### Routing

| User action | Destination |
| --- | --- |
| Send without an agent mention in Cowork | All active peers; one temporary planner splits the request |
| Send without an agent mention in Orchestrated | Separate designated orchestrator |
| Send without an agent mention in Current agent leads | Existing agent acting as orchestrator |
| Send to `@claude1` | That member only |
| Send to `@codex1` | That member only |
| Explicitly select several agent recipients | The selected recipients; composer previews recipients before sending |
| Use `@claude` / `@codex` | Resolve only when exactly one member matches; otherwise choose a member |

Mentions autocomplete from this group's active membership. Unknown or removed recipients reject dispatch rather than falling back to the orchestrator. Preserve stable member identities and do not reuse retired handles within the conversation. Routing uses resolved participant IDs, rather than reparsing arbitrary message prose. Code blocks, quoted text, URLs and an agent merely printing a handle do not dispatch runs. Multiple recipients receive the explicitly addressed request; the router does not invent per-agent task scopes from punctuation. Task scopes are explicit in orchestrator assignments.

In either mode with an orchestrator, it remains aware of task/result events, but a directly addressed worker message does not automatically launch an additional orchestrator turn. Informational updates can remain machine events until reasoning is needed.

### Timeline

Keep the existing minimal conversation layout. Agent responses have a small handle/role label so the speaker is clear, without provider icons. Human messages retain their current bubbles. Delegations show their sender, recipient and delivery state. Tool calls, working time, approvals and changed-file cards belong to the real member/run that produced them.

A compact member control opens participants and their settings; do not add a permanent collection of agent dashboards around the conversation. Keep Tasks, Activity and Agent Map synchronized with assignments, dependencies and actual run state.

## Mode-choice visualization and motion

The first Add agent step asks **How should these agents work together?** with three equally prominent selectable cards:

- **Cowork — You lead.** The diagram fans a message from the human to two equal agent nodes. A temporary split marker appears on one peer, then complementary task markers move to both peers. A small horizontal exchange illustrates their direct communication. There is no third coordinator node.
- **Orchestrated — An agent coordinates.** The message travels from the human to a separate orchestrator, then branches into worker assignments. Results return to the orchestrator before one combined response returns to the human. The existing agent's node visibly becomes a worker.
- **Current agent leads — Keep your agent in charge.** The message travels from the human to the existing agent, then to the new worker. Results return through the existing agent for review. Its node is labeled orchestrator; there are only two agent nodes, and its existing context and configuration are retained.

Use neutral charcoal/white styling, thin connectors and occasional blue message motion. Keep diagrams subordinate to their readable labels. Animate only the explanation: this is an illustrative flow, not claimed live execution or progress. The [standalone interaction preview](previews/group-modes.html) is explicitly an example workspace and starts no model calls.

Provide a pause control and honor `prefers-reduced-motion`. Reduced-motion mode keeps labeled static connections. Keyboard focus and a selected border communicate the choice without depending on color or animation. Selection updates a concise routing/roster summary and the configuration step. Orchestrated adds the separate coordinator and the current-agent configuration question; Cowork shows both peers with the existing configuration retained. Current agent leads shows the existing orchestrator and new worker, preserving the existing configuration without the worker downgrade question.

Changing mode on an existing group is an explicit idle-time transition with a roster/configuration preview. Retain completed history. Pending work must be paused and reviewed against the new mode; do not silently retarget queued messages or add/remove a coordinator while runs are active.

## Runtime and persistence

Separate the shared conversation from the provider runtime:

- **Group:** project, title, explicit mode, nullable orchestrator member (absent in Cowork, newly created in Orchestrated, existing member in Current agent leads) and coordination settings.
- **Request planning lease:** request, chosen peer, plan version, scope and expiry for Cowork; not a permanent participant role.
- **Member:** stable identity, group, unique handle, role and existing provider `Session` ID.
- **Group message:** ordered shared entry, sender, resolved recipients, optional reply/correlation IDs and source session-message/run reference.
- **Delivery:** recipient, logical message ID, claim/delivery state, attempt and associated run.
- **Assignment:** task, owning member, input artifacts, permitted edit scope, expected output and acceptance criteria.

Keep current provider sessions as independent execution units: one active run per member, with their existing native conversation IDs, approvals, worktrees and persistence. Task ownership can continue referencing the underlying session, with group membership resolved by the server. Existing single-agent sessions remain usable without being forced through a multi-model orchestration step.

Existing history remains linked to its original session; conversion does not replay it as a new user prompt or duplicate its durable records. In Orchestrated mode, give the new orchestrator a bounded bootstrap containing the current request, project context, member capabilities, active tasks and relevant prior decisions, with explicit references to additional history it can retrieve. Current agent leads continues the existing native conversation directly; it does not create a replacement coordinator or replay the transcript into another session.

SQLite stores membership, group messages, deliveries and assignments. WebSocket deltas include enough group/member identity to update the shared timeline without mixing simultaneous assistant streams. Use server sequence numbers for ordering; preserve each provider run's actual timing independently.

### Agent communication

Both providers receive a narrow, run-scoped team tool interface, following the existing server-owned browser capability pattern. The implemented operations are:

- List members and their actual status/capabilities.
- Assign a bounded task to an eligible worker.
- Send a targeted question or reply.
- Publish a verified artifact reference.
- Report progress, completion or a blocker.
- Retrieve relevant project/task context and unread messages.

The server validates group membership, recipient, task ownership, dependencies and current permissions for every operation. It derives the sender from the invoking run. A worker cannot impersonate the orchestrator or create a more privileged agent. In both modes with an orchestrator, assignment scheduling belongs to that designated member. In Cowork, the selected peer can schedule only assignments covered by its request planning lease. All members can communicate directly without gaining arbitrary delegation authority.

A dispatch tool result confirms acceptance/queueing, not successful completion. UI mention labels correspond to real recorded tool actions. Relay does not execute commands by looking for `@...` text in model output.

### Efficient context exchange

Use the communication layers from the original vision:

1. **Structured events** for status, queue changes, task ownership, artifact availability and completion. Recording an event does not itself require an LLM turn.
2. **Compact payloads** for actual assignments and questions: task ID, concise objective, constraints, output contract, acceptance criteria and exact file/commit references.
3. **Natural language** for design decisions, questions and unresolved ambiguity.

A receiving agent reads new messages, required decisions and referenced artifacts. It does not receive every other agent's raw transcript on each turn. Store project decisions and interfaces durably; summaries retain provenance and links to the full source. Begin with validated JSON and existing contracts; evaluate alternative encodings by measured token use and correctness before adopting them.

For example, an artifact announcement identifies the source member, task, repository, path, immutable commit and blob. The server verifies the reference using the existing handoff boundary before offering it to another member.

## Automatic delegation and recovery

In either mode with an orchestrator, an unaddressed user work request can authorize the orchestrator to assign work to the configured members within that group's visible limits. Routine assignments do not require another confirmation for each worker. The orchestrator selects among actual available members and their configured capabilities; it does not silently replace their models or permissions.

The server queues work for a busy member. Incoming peer messages join its inbox and become available at a safe turn boundary; they never start an overlapping native turn. A request requiring an answer may wake an idle member within the active orchestration budget. A status notification does not need a new model run. Batch result notifications for the current coordinator (the orchestrator or the peer holding the request lease) to avoid a separate reasoning turn for every tool event.

Every logical message and assignment has a stable ID for deduplication, with reply/correlation IDs for traceability. Delivery and consumption are recorded separately. Retries after a failed start retain unread context and do not claim successful delivery. Provider failures, exhausted quota, unavailable credentials and blocked permissions remain visible. Switching models or providers remains an explicit user choice.

Bound parallel workers, automatic model turns, message hops and repeated attempts. A known exceeded limit pauses new automatic work and shows the reason; unknown provider cost is never presented as an enforceable exact spend cap. Prevent self-dispatch and notification ping-pong. The user can stop one member or the whole group, inspect queued work and explicitly resume it.

On application restart, retain conversations, tasks, messages and queued assignments, mark killed runs interrupted and expire old approvals. Do not silently resume paid model runs merely because the app reopened.

## Workspaces and integration

New peers, workers and a new separate orchestrator use separate worktrees by default. Current agent leads keeps the existing orchestrator in its current workspace; the new worker gets an isolated worktree. An existing or imported member keeps its current directory until explicitly changed through a supported flow. Show when it works directly in the project folder. Task assignments identify edit ownership; concurrent writers cannot be assigned overlapping integration work without coordination.

Artifact readiness and final acceptance remain separate. A verified committed contract can unblock a consumer through an explicit artifact dependency, while the producing task remains in Review. Legacy task dependencies continue requiring Done. Do not mark an upstream task accepted solely to get around the current dependency gate.

In either coordinated mode, the orchestrator can prepare and review integration in its own workspace under its permission policy. Current agent leads retains the existing directory; no silent workspace move occurs. In Cowork, an explicitly assigned peer prepares the combined result; the human directs and reviews integration. Publishing and changes to the user's selected checkout retain explicit controls. A consolidated answer identifies worker contributions, integrated revisions, conflicts and what still needs review. Separate commits in different worktrees do not by themselves constitute an integrated result.

Browser access continues to honor the actual connection/tab owner and human control. Adding a participant does not grant it ownership of another participant's browser tabs.

## Delivery sequence and acceptance

1. **Group foundation:** additive persistence and shared timeline; convert an existing session without losing history; retain standalone operation.
2. **Mode choice and addressing:** animated three-mode explanation, add/configure members, mention completion, mode-dependent routing, independent streams and member/group stop controls.
3. **Coordination:** Cowork request planning leases; optional separate orchestrator from saved defaults or existing agent as orchestrator; current-worker configuration question in Orchestrated mode; bounded dispatch and visible queue state.
4. **Peer communication:** durable targeted requests/replies, compact context retrieval and verified artifact handoff; no duplicate or overlapping runs.
5. **Integrated proof:** exercise all three modes. In Cowork, a broadcast reaches both peers and exactly one split produces non-overlapping assignments. In Orchestrated mode, an unaddressed request reaches only the orchestrator before delegation. In Current agent leads, that recipient is the existing native conversation, and the new worker runs only after an explicit mention or recorded delegation. In all modes, Codex produces a committed API contract, Claude consumes that exact revision and implements the UI, and the combined result reaches human review without manual copying.

Acceptance must include no extra coordinator participant in Cowork or Current agent leads; the existing agent retaining its history, configuration and orchestrator role in Current agent leads; the selected mode and roster persisting through reload; the worker configuration question appearing only for Orchestrated conversion; reduced-motion and keyboard alternatives for mode animations; preserved original history and provider conversation IDs; actual model/effort/policy in the add-agent preview; only intended recipients running for direct mentions; live simultaneous streams remaining distinct; changes to busy members refusing safely; restored pending messages without duplicate dispatch; bounded communication; and visible interruption/failure behavior. A real provider-backed integration demonstration requires explicit owner authorization for its model runs. Completion evidence must distinguish implementation, local checks and the live demonstration.

The application now implements this coordination layer. A real provider-backed integrated feature demonstration remains pending; this record does not claim that proof has run. Distributed computers, voice control and general autonomous integration remain later milestones.


## Interaction preview review — 2026-10-20

`docs/previews/group-modes.html` is a standalone, explicitly labeled example of the mode-choice flow. It uses original SVG/CSS diagrams and local JavaScript, with no dependencies, provider calls or saved settings. It is separate from the current Relay application runtime.

In the native collaborative preview, both choices rendered at 1280px. Selecting Cowork hid the separate coordinator and current-agent configuration question. Arrow-key selection moved to Orchestrated and showed both. Choosing Change allowed a lighter example model and Medium effort, reflected in the review summary. Pause stopped both SVG animation clocks. The 390px layout stacked the choices and had no horizontal overflow. Reduced-motion support is implemented but was not exercised by changing the host's system preference. No automated tests or model runs were started.


### Third-mode preview review

Added Current agent leads to the specification and standalone preview. Native browser inspection at 1280px confirmed three cards without horizontal overflow, the existing agent labeled Orchestrator, the new agent labeled Worker, and a two-participant review summary. The separate coordinator row and existing-worker configuration question were hidden. Switching from a lighter-model/Medium Orchestrated preview back to Current agent leads restored the unchanged current-model/High preview. Pause stopped all three SVG clocks. At 390px, cards stacked without horizontal overflow. JavaScript syntax and Git whitespace checks passed. Screenshot capture failed, and the browser host disconnected during the final desktop resize, so no new screenshot was captured. No automated tests or provider runs were started. This remains a design preview, not implemented group execution.


## Application implementation review — 2026-10-20

The actual Relay application now exposes all three modes through Add agent, with live provider configuration, independent native sessions, group defaults, shared timelines, resolved recipients, team tools, assignment/task integration and persisted queue controls. The standalone HTML preview above remains a historical design artifact.

Implementation used authorized Claude Sonnet 5.5 High workers. Claude reached its session quota after writing the backend and most frontend components; an actual GPT-6 Luna High CLI worker completed frontend wiring/styles, and integration review corrected routing, interruption and persistence boundaries. Every implementation worker committed its scoped files. No attribution trailers or publication were added.

Local evidence:

- Workspace TypeScript checks and the production web/server build pass. Desktop entry-point syntax checks pass through the workspace typecheck. No automated tests were added or run.
- The native collaborative browser rendered three cards at 1280px and the current-agent-led two-member preview without a worker downgrade question. Provider selection changed the proposed worker from Codex to the actual Claude catalog. Pausing stopped all three SVG clocks.
- A mobile dialog overflow was found and corrected with an explicit viewport width cap. Reinspection at 390px measured the modal from x=20 to x=370, with cards stacked and no dialog/card overflow.
- In the built application, `@claude1` selected only that worker, an unknown custom handle disabled Send, and a handle inside inline code retained default orchestrator routing. Drafts were cleared without sending.
- In a separate cache data directory and explicitly labeled example workspace, configuration-only API calls created Current agent leads with orchestrator/worker, Cowork with two peers and no coordinator, and Orchestrated with a separate coordinator and two workers. The original orchestrator kept High effort; the separate-coordinator conversion applied the explicitly selected Low effort to its existing worker. All new members had isolated workspaces. Bootstrap reported zero runs and zero deliveries.
- A previously running development watcher opened an early v7 schema during integration. Migration 8 upgraded it without deleting data. Read-only SQLite foreign-key checks reported zero violations in both the existing development database and separate review database.
- Screenshot capture failed in the collaborative browser, although DOM inspection and focused interactions worked. No screenshot is claimed.

A live multi-provider assignment/communication/integration demonstration has not been run. It remains the unchecked proof milestone in roadmap.md. Group messages currently carry text and resolved recipients; attaching selected native skills in the group composer is explicitly unavailable, while independent-session skill controls remain supported. This does not claim distributed machines or general autonomous integration are complete.

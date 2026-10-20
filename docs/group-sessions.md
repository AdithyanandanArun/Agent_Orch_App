# Group conversations

Use **Add agent** in an existing session to work with several independent coding agents in one conversation. Adding a participant saves its settings and creates its workspace; it does not start inference. Existing native conversation IDs and history stay with their original session.

## Choose how work is coordinated

| Choice | Existing agent | New agent | Message without a recipient |
| --- | --- | --- | --- |
| Cowork | Equal peer, initially the request planner | Equal peer | Both peers receive the request; one planner splits it before the other edits |
| Orchestrated | Worker, with an explicit Keep/Change configuration choice | Worker | Separate coordinator from Settings |
| Current agent leads | Orchestrator with its existing history and configuration | Worker | Existing orchestrator |

The animated choice diagrams illustrate routing. They are not live progress. Pause motion and the operating system's reduced-motion preference keep the choices usable without animation.

The add-agent flow previews the provider, unique handle, model, effort, service tier, permissions and workspace. New participants use isolated Git worktrees by default. Existing sessions retain their current directory; imported conversations are not moved. A repository needs an initial commit for worktree creation. Working in a shared folder requires explicitly opting out of isolation.

## Addressing and the timeline

Choose an agent recipient or type its handle, such as `@claude1` or `@codex1`. The composer previews the resolved recipients. A direct message starts work only for its recipients. Unaddressed routing follows the selected mode. Unknown handles reject rather than being sent to a different agent. Handles in quoted text, URLs or code are not dispatch instructions.

Responses, tool activity, approvals, elapsed time and changed files retain the member and native run that produced them. Each member can have only one provider turn at a time. A separate provider process or native conversation is not a second shared context window: Relay sends compact assignments and references, not everyone's full transcript.

Agent names use a consistent individual color, with an OpenAI or Claude mark taken from the associated session's provider. The handle identifies the participant; the provider mark identifies its runtime. Two Codex participants still have separate worktrees, conversations and runs.

When delegated work finishes, Relay queues a results handoff to the assigning agent. If that agent is still working, its follow-up waits for the current turn to finish. The handoff's delivery state describes that follow-up turn; it does not certify that files were integrated or that a task passed review. Read the agent's final response and changed-file summary for the actual outcome. Detailed internal handoff instructions remain available in a disclosure.

Native guidance asks the coordinator or Cowork planner to finish with one human-readable summary that opens with an outcome (Implemented, Partially complete or Blocked) and material caveats. It names each agent's contribution, where work was actually integrated, which checks the coordinator ran versus which a peer reported, and what still needs review or action, and says Pending while workers run. Workers publish required committed handoff files once (none invented when nothing is committed), record Review when ready, then send a final summary without repeated completion messages. Unresolved blockers remain visible. This is model guidance, not a certification: Relay does not infer success from a finished turn, and tasks stay in Review until a human accepts them.

Completed files can live in the integrating agent's isolated worktree rather than the original project folder. The checkout control and file links identify that location. Finishing a provider turn neither commits nor publishes those files automatically, and delegated tasks remain in Review until accepted.

The floating agent bubble stays at the right as messages scroll, without reserving a sidebar column. It shows each active member's provider identity, configuration and current state. An agent doing work with a pending follow-up remains **Working**, with the queued count shown alongside it. Approval waits, pauses, errors and idle states are shown separately. Working time uses the native run's start time; queue age is not reported as work time. During a connection loss, the list identifies its state as last known.

Opening the right context pane fades the bubble away; closing the pane restores it smoothly. The bubble can collapse to a small activity summary and defaults to that compact form in narrow or short windows. Expanding it shows individual statuses, with its height bounded above the composer. Sidebar and background transitions work in both directions and respect reduced motion. The Members menu remains available for agent settings and controls.

## Agent communication

During a recorded group run, Codex and Claude receive the same host-authenticated team interface:

- `team_members`: actual membership, roles and run state.
- `team_inbox`: messages and artifact references addressed to that member.
- `team_assign`: scoped objective, task ownership, acceptance criteria and prerequisites.
- `team_message`: targeted note, question or reply.
- `team_artifact`: verified committed file and revision delivered through Relay's artifact handoff boundary.
- `team_status`: progress, blocker or Review for the sender's own task.

Only the designated orchestrator or Cowork's temporary request planner can schedule assignments. Peer messaging does not grant delegation authority. Tool results confirm queueing or recording, not successful completion. Plain model output containing an `@handle` is never executed as a dispatch command.

Task dependencies normally require Done. An assignment can explicitly name an expected artifact dependency; the corresponding verified committed artifact can unblock that consumer while its producer remains in Review. Completion is still a human acceptance decision. Referencing a commit does not merge it into another worktree. Agents can prepare integration within their configured permissions; publishing remains an explicit repository action.

## Limits, interruption and recovery

**Settings → Agents & orchestration** stores coordinator/worker defaults and default limits. Existing groups keep their own configuration. Group controls expose actual members, settings, queued deliveries, interruption and pause/resume.

Parallel runs, automatic turns and message hops are bounded. Status events do not create model turns. A question that requests an answer can wake its recipient within the active request's limits. Failures and limit exhaustion stay visible. Raising a limit does not erase usage already counted against the request.

Pause holds new scheduling while native runs already in progress can finish. Stop pauses automatic scheduling and interrupts the group’s runs. Stopping one member cancels its queued work and holds it; its Resume action can retry eligible interrupted work. It does not silently restart. SQLite preserves membership, messages, assignments and deliveries. On server restart, unfinished runs are marked interrupted and queued coordination requires explicit Resume; reopening Relay never restarts paid work by itself.

Credentials for the team tools are temporary, scoped to one run and kept out of durable source/history. The server validates the invoking member, active delivery, permissions and coordination authority on every operation. Browser access remains a separate capability with its existing tab ownership and human controls.

Cowork avoids an extra coordinator conversation. Every participating model still consumes its own quota and tokens; no fixed cost reduction is guaranteed.

# Product and interaction specification

Relay is a working title for an independent local development environment. The first intended user is a developer already using coding agents who wants to coordinate their work without losing ownership of their project, credentials, or decisions. The original vision remains the source for the broader roadmap.

## First complete workflow

1. Open a local Git project. Show its real branch and files; retain the selection after reload.
2. Create a named Codex or Claude session, choose the model, effort and policy, and create an isolated worktree by default. Explain any prerequisites instead of silently sharing the main checkout.
3. Send a task. Stream actual provider output and tool events, preserve messages, show actionable errors, and allow interruption.
4. Create a second independent session. Each session has its own provider conversation, worktree and lifecycle.
5. Create tasks with acceptance criteria and dependencies. Show why blocked work is blocked. Dispatch a ready task only when explicitly requested.
6. Inspect the source session's Git diff. Send a committed artifact reference to the receiving session. Record the exact revision and receiving message durably. A handoff supplies context; integration remains explicit.
7. Dispatch the receiving task with the handoff context. Send successful work to review. A human decides whether the acceptance criteria have been met.
8. Restart Relay. Restore local state, show interrupted runs honestly, expire stale approval requests, and resume provider conversations on the next turn.

## Information architecture

- Workspace: sessions, conversation, composer, project files, editor, Git changes, browser preview and terminal.
- Tasks: task status, dependencies, owner, acceptance criteria and explicit dispatch.
- Agent map: actual session and task relationships; selecting a node leads to useful detail.
- Activity: durable project events and artifact announcements.
- Settings: diagnostics, executable overrides, policy and appearance.

Project selection scopes the workspace. Session selection scopes chat and code inspection. Creating a session never silently launches inference. Unavailable provider executables and absent product authentication are separate states. An example workspace must be labeled and contain no simulated live traffic or invented performance claims.

## Interaction standards

Keyboard access, focus indication, labeled form inputs, Escape dismissal, a command menu and clear loading/error states are part of the first foundation. Local file drafts must survive background state refresh. Streaming should not steal focus or force the user to the bottom when reading earlier messages. Destructive Git or external publication actions require an explicit user action.

## Design direction

A quiet development environment with dark slate surfaces, restrained lavender emphasis, thin separators, small monospaced technical metadata and readable conversation text. Use a single spacing, type and color system. The agent graph explains work relationships; it should remain useful with one idle session.

## Future product work

Voice control, authenticated connections between computers, scoped team ownership, reconnection and event replay across nodes, automatic scheduling, knowledge retrieval and controlled integration queues remain milestones in the original vision. They need dedicated specifications and failure testing before product claims. Their visibility in the design should reflect actual availability.

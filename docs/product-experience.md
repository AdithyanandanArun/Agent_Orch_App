# Product and interaction specification

Mingle is an independent local development environment, previously named Relay. The first intended user is a developer already using coding agents who wants to coordinate their work without losing ownership of their project, credentials, or decisions. The original vision remains the source for the broader roadmap.

## First complete workflow

1. Open a local Git project. Show its real branch and files; retain the selection after reload.
2. Click New Session to create and select a session immediately using saved provider, model and effort defaults. Adjust its model/effort in the composer, and rename it when useful. Create an isolated worktree by default; explain prerequisites and the explicit project-folder setting when a worktree cannot be created.
3. Send a task. Stream actual provider output and tool events, preserve messages, show actionable errors, and allow interruption.
4. Create a second independent session. Each session has its own provider conversation, worktree and lifecycle.
5. Create tasks with acceptance criteria and dependencies. Show why blocked work is blocked. Dispatch a ready task only when explicitly requested.
6. Inspect the source session's Git diff. Send a committed artifact reference to the receiving session. Record the exact revision and receiving message durably. A handoff supplies context; integration remains explicit.
7. Dispatch the receiving task with the handoff context. Send successful work to review. A human decides whether the acceptance criteria have been met.
8. Restart Mingle. Restore local state, show interrupted runs honestly, expire stale approval requests, and resume provider conversations on the next turn.

## Information architecture

- Workspace: sessions, conversation, composer, project files, editor, Git changes, browser preview and terminal.
- Tasks: task status, dependencies, owner, acceptance criteria and explicit dispatch.
- Agent map: actual session and task relationships; selecting a node leads to useful detail.
- Activity: durable project events and artifact announcements.
- Settings: new-session defaults and appearance, with diagnostics, executable overrides and permissions under disclosures.

Project selection scopes the workspace. Session selection scopes chat and code inspection. Creating a session never silently launches inference. Unavailable provider executables and absent product authentication are separate states. An example workspace must be labeled and contain no simulated live traffic or invented performance claims.

## Interaction standards

Keyboard access, focus indication, labeled form inputs, Escape dismissal, a command menu and clear loading/error states are part of the first foundation. Local file drafts must survive background state refresh. Streaming should not steal focus or force the user to the bottom when reading earlier messages. Destructive Git or external publication actions require an explicit user action.

## Design direction

A quiet development environment with black/charcoal surfaces, white emphasis, occasional blue and no purple. Conversation prose is readable and unadorned; assistant responses have no provider icon. User bubbles, composer, choice menus and dialogs share deliberate spacing and rounded outlines. Settings occupies a full page. Optional context and terminal panels start closed. Keep secondary project views in the footer's More menu, and show advanced details when requested. Use a single spacing, type and color system. The agent graph explains work relationships; it should remain useful with one idle session. See [the workspace design revisions](ui-direction.md) for references and behavior.

## Future product work

Voice control, authenticated connections between computers, scoped team ownership, reconnection and event replay across nodes, automatic scheduling, knowledge retrieval and controlled integration queues remain milestones in the original vision. They need dedicated specifications and failure testing before product claims. Their visibility in the design should reflect actual availability.

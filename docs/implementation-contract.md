# Relay — first implementation contract

Working title: Relay. This is a durable first foundation for the multi-month product described in vision.md. Build an original local workspace with real persistence and supported provider harnesses. Do not claim distributed coordination, automatic integration, or advanced orchestration is complete.

## Stack

pnpm workspace; React 19 + TypeScript + Vite; Tailwind or plain CSS with design tokens; TanStack Router and Zustand if useful; Node >=24.13; WebSockets; SQLite via node:sqlite; node-pty; Monaco and xterm; Electron desktop entry point. Effect may be used where useful, without copying T3 abstractions. Core architecture matches T3's UI / Node / provider process separation. Rust isn't required to launch the Codex Rust executable.

## HTTP and WebSocket contract

All HTTP routes use /api. Errors: {error: string}. JSON success bodies, except file content endpoint. API server port 4310 on 127.0.0.1, Vite port 5173. Vite proxies /api and /ws. Production server serves apps/web/dist. Default data directory is .relay under repository root (override RELAY_DATA_DIR); never tracked.

- GET /api/bootstrap -> Bootstrap (shared contracts), includes durable messages and events. Initial state creates one clearly labeled example project with a local folder, readme/contract files, tasks and TWO idle sample sessions (not active provider calls). isExample=true. Do not invent metrics or completed runs. Runtime defaults to this example until user opens their own project.
- POST /api/projects {name,path} -> Project. Path must exist; use canonical real path. GET /api/projects/:id/files?path=relative -> FileEntry[]. GET /api/projects/:id/file?path=relative&sessionId=optional -> {content,path}; PUT same endpoint {content} saves text. Refuse traversal, symlink escapes, .git and secrets. Files can be scoped to a session worktree.
- POST /api/sessions CreateSession -> Session. Git projects isolated by default using unique worktree+branch under data directory. Clear errors for nonrepo/unborn HEAD. Nonisolated sessions explicitly opt in. PATCH /api/sessions/:id {name?} -> Session. DELETE /api/sessions/:id archives metadata but never removes worktrees. POST /api/sessions/:id/messages SendMessage -> {accepted:true}; starts asynchronous provider run. 409 if active. POST /api/sessions/:id/interrupt -> {ok:true} cancels process, denies pending approvals.
- GET /api/projects/:id/git?sessionId=optional -> GitStatus. Read-only status and diff. No push/merge endpoint in this foundation.
- POST /api/tasks CreateTask -> Task. PATCH /api/tasks/:id UpdateTask -> Task; reject cycles, cross-project deps or ownership, invalid transitions past unfinished deps. Mark downstream ready when dependencies done. POST /api/tasks/:id/run -> {accepted:true}; dispatch assigned session with task context, moves to review on successful turn, never auto-done.
- POST /api/handoffs Handoff -> WorkspaceEvent. Verify source/target same project, artifact committed at revision in source repo; create compact reference and durable receiving system message. Does not silently merge or start a paid model run. Include artifact content or source path reference for consumption; downstream session should receive it with next explicit run.
- POST /api/approvals/:id {decision:'approved'|'denied'} -> Approval. Approvals belong only to active local run; expire/deny on restart and interruption.
- PATCH /api/settings UpdateSettings -> AppSettings. No credential UI or secret storage; Claude uses ANTHROPIC_API_KEY in server environment. Executable paths may be configured. GET /api/providers -> ProviderInfo[]. POST /api/providers/refresh -> ProviderInfo[]. Accurate diagnostics; codex --version and Claude executable selection probes with timeout. Installed != authenticated; do not claim authentication based on executable alone.
- GET /api/events?after=integer&projectId=optional -> WorkspaceEvent[] for replay.
- WS /ws -> ServerEvent. Connected client receives state.changed on mutation. Client re-fetches bootstrap (debounced), session.delta updates live text at its absolute offset to handle snapshot overlap. Terminal messages use shared ClientEvent with {type:'terminal.ready',terminalId} server handshake and {type:'terminal.error',message} for failed starts. PTY owner socket only, project/session cwd validation, kill on disconnect. No shell interpolation.

## Provider module contract

apps/server/src/providers/index.ts exports createAdapter(provider: Provider): AgentAdapter and detectProviders(settings: AppSettings): Promise<ProviderInfo[]>; interface types in @relay/contracts. Provider agent owns only this subtree + provider tests and docs/provider-research.md.

Codex: launch codex app-server over stdio; JSON-RPC initialize/initialized; thread/start or thread/resume; turn/start; deltas and tool records; forward approval requests to host callback; interrupt/abort; process timeout and cleanup; restore provider session id. No OAuth extraction. Use existing CLI login.

Claude: use official @anthropic-ai/claude-agent-sdk query(), resume provider session id, stream partial text, map canUseTool to requestApproval, support AbortSignal. Use API environment authentication for the shipped product, never offer third-party subscription OAuth login without approval. CLI subagents used by the developer to build this project are a separate workflow. Honor model and effort. No automatic fallback model substitutions.

## UI direction

Designed desktop workspace, responsive down to 900px (smaller widths graceful overlay). Near-black blue slate surfaces, restrained lavender accent, fine borders, generous chat whitespace, clear hierarchy, small mono metadata, original Relay line glyph. Persistent sidebar with project switcher, Workspace / Tasks / Activity; sessions grouped with provider marks; bottom connection and settings. Workspace header project breadcrumb, branch, command menu and new session. Center session/chat, bottom composer with provider/model and policy. Right context pane with Overview / Files / Changes / Preview tabs, bottom optional real terminal. Task view board with dependencies and detail drawer. Agent map may use React Flow or a simple clear interactive SVG from actual sessions/tasks, selectable nodes; never fake live traffic. Settings sheet with provider diagnostics, executable fields, theme/policy, documented upcoming capabilities. Helpful empty states and explicit example banner. Command menu with keyboard shortcut and actual actions. New project/session/task modal forms, loading/error states and accessible dialog/labels/focus. Original code, no T3 source copy.

Workers must commit their own scoped changes, with no coauthor trailers, and never push. Orchestrator owns root packages/config/contracts/docs except provider-research.md. Workers may create their app package.json. Coordinate dependency additions in final report; root owns shared lockfile.

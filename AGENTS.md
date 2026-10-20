# Project instructions

Mingle is an original local development environment for independent coding sessions. The user has authorized parallel Claude Code Sonnet 5.5 high workers, with GPT-6 Luna high as fallback if Claude quota is exhausted. The orchestrator coordinates integration.

- Implement original code. T3 Code is an architectural and UX research reference, never a code dependency or source to copy.
- Use React, TypeScript, Vite, Node, WebSockets and SQLite. Keep provider runtimes separate from UI. Electron wraps the local application.
- Each implementation worker owns its assigned paths and commits its own work. Never stage another worker's files. Never push or publish code without the user's final permission.
- Use the repository's configured user identity. Do not add Co-authored-by, assistant attribution, Claude attribution, or Codex attribution to commits or PRs.
- Show actual provider availability, failures, task states and events. Demo data must be explicitly identified as an example workspace.
- Runtime data and credentials must stay outside tracked source. Never log or commit secrets. Do not read other developers' private credentials.
- Validate boundaries, use Git argv arrays instead of shell interpolation, and isolate session edits in worktrees by default.
- Run focused checks appropriate to substantive changes. Do not run paid model tasks as part of the automatic test suite.
- Read packages/contracts/src/index.ts and docs/implementation-contract.md before implementing.

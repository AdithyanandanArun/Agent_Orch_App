# Original product vision

Transcribed from the project idea document supplied by the owner.

Distributed AI Development Environment

Status: Product concept and implementation blueprint

Date: 2026-10-19

Vision

Build an independent, local-first, voice-enabled AI development environment in which independent Claude Code, Codex, and future coding-agent sessions collaborate as a coordinated software team—on one machine or across computers owned by different developers.

The platform must remain useful with only one agent. It should feel familiar to users of T3 Code, but must not fork or depend on T3 Code's codebase. Study its public UX and architecture as references, then implement our own components and runtime.

Problem

Coding agents typically work in isolated sessions. Humans repeatedly copy context, allocate work, coordinate dependencies, resolve conflicting edits, and integrate changes. Agents may wait idle while others are overloaded. Repeated prompts waste tokens, and late integration creates rework.

Goal: More reliable, integrated software delivered with less manual coordination, time, and token expenditure.

Three Operating Modes

1. Single-agent IDE: Project management, chat, editor, terminal, Git, browser preview, session persistence, and voice commands.

2. Local multi-agent workspace: Multiple independent Claude Code and/or Codex sessions on one machine, with task handoffs, messaging, and isolated worktrees.

3. Distributed team workspace: Developers invite teammates and connect their machines and independently owned sessions over a secure network, with scoped permissions and coordinated work.

Product Principles

Independent sessions, not merely subagents: Each top-level session has its own lifecycle, context, tools, and owner. Provider-created subagents may be shown beneath their parent.

Local-first: Single-user operation should not require a hosted collaboration service.

Provider-agnostic: Use documented integrations and adapters; verify SDK capabilities and provider terms before committing to an implementation.

Human control: Each developer controls their machine, credentials, sessions, and usage limits; team leaders control project-level policies.

No throwaway UI: Establish a coherent design system and durable component architecture early, even if initial functionality is limited.

Measured efficiency: Compression and parallelism are useful only if quality and end-to-end cost improve.

Architecture

React + TypeScript Development UI(chat | editor | terminal | Git | browser | voice | agent graph)                  |         Local Application API                  |    Session Manager + Agent Adapters       |                       | Claude Code session       Codex session       |                       |  isolated worktree       isolated worktree                  |       Collaboration / Orchestration(task DAG | scheduler | event bus | context index | approvals)                  |       Secure Connectivity Layer(identity | membership | presence | messaging | recovery)                  |        Remote teammates' nodes

The local agent runtime, collaboration engine, and networking layer should be modular and separable from the UI.

Key Capabilities

1. Agent sessions

Launch, stream, inspect, interrupt, resume, and terminate independently running sessions. Persist session metadata and relevant events. Display subagents distinctly from top-level sessions.

2. Agent-to-agent communication

Support targeted messages, broadcasts, presence, artifact announcements, and durable event delivery. Remote sessions should not gain unrestricted filesystem or machine access.

3. Token-efficient communication

Use three levels, selected by a routing policy:

Structured events: Machine-consumed status updates with no LLM invocation.

Compact model-readable payloads: Small schema-based messages, diffs, file/commit references, and concise context summaries when a model must read them.

Natural language: For ambiguous requirements, design decisions, and complex reasoning.

Example:

{  "type": "artifact.ready",  "from": "codex-backend",  "to": "claude-frontend",  "task": "auth-api",  "artifact": {    "path": "contracts/auth.openapi.json",    "revision": "9ab31c"  }}

A shared, versioned knowledge index stores decisions, interfaces, and task state so agents retrieve only relevant changes instead of repeatedly exchanging full chat histories. Evaluate compact formats (including TOON-like representations) against JSON using actual tokenizer counts, comprehension accuracy, and total execution cost. A shorter character count does not guarantee fewer tokens.

4. Task orchestration

Maintain a dependency DAG with task owner, prerequisites, priority, acceptance criteria, and status. Automatically unblock dependent work, flag duplication and conflicts, and suggest safe reassignment. Do not generate busywork simply to keep agents active.

5. Code integration

Use separate Git worktrees or working directories, shared API contracts, change detection, tests, review gates, and controlled integration queues. Do not let multiple agents write into the same files without coordination.

6. Permissions and autonomy

Offer supervised, balanced, and autonomous-with-limits policies. Routine authorized events may flow automatically; accessing private files, using another developer's quota, privileged commands, sensitive merges, deployments, and expensive operations require the appropriate approval. Keep an audit trail.

7. Voice-first control

Allow users to address an agent or the whole team, route instructions, request status, interrupt tasks, and handle approvals. Use deterministic commands when possible; reserve model calls for natural-language interpretation and reasoning.

8. Visual agent graph

Show connected developers, computers, top-level sessions, subagents, assignments, dependencies, blocked tasks, and communication. Selecting a node opens its actionable details, not just an animation.

9. Shared browser

Provide browser previews and Playwright/CDP testing. Use isolated browser contexts or explicit control leases to avoid concurrent-agent interference.

Proposed Technology Stack

Area

Initial direction

UI

React, TypeScript, Vite

Design system

Original component library, consistent tokens and layouts

Editor

Monaco

Terminal

xterm.js with PTY integration

Local backend

Node.js / TypeScript

Desktop packaging

Electron or Tauri, evaluate after web/local prototype

Agent adapters

Supported Claude Code and Codex interfaces, validated experimentally

Local persistence

SQLite

Network messaging

Authenticated WebSockets; optional relay for remote connectivity

Hosted coordination

Node.js or Go, with PostgreSQL if needed

Event bus

Start with local durable events; add NATS only if justified

Browser

Chromium + Playwright

Graph UI

React Flow or equivalent

Voice

ASR, command router, TTS

Isolation

Git worktrees and scoped tool permissions

T3 Code reference: Its reported stack includes React, TypeScript, Vite, Node.js, WebSockets, Electron, and Codex App Server integration. Treat this as a research reference, not an implementation dependency; verify current upstream details before adopting specific patterns.

Development Plan

Phase 0 — Research and design

Examine T3 Code's public UI flows and architecture; use Reverse Engineer Anything where helpful for behavior mapping, not decompilation or code copying.

Create a component inventory: project switcher, chat, session tabs, editor, terminal, Git diff, browser, settings, agent graph.

Define a design system and realistic high-fidelity UI flows before asking coding agents to improvise a prototype interface.

Validate available Claude Code and Codex session APIs, persistence, streaming, interruption, and licensing/terms.

Phase 1 — Durable single-agent foundation

Build the original UI shell and local backend, one functioning agent adapter, reliable streaming, terminal/editor integration, and session persistence. Make the UI architecture production-intended, even with limited features.

Phase 2 — Two-agent proof

Run Claude Code and Codex as separate sessions in isolated worktrees. Implement task IDs, a durable event log, structured messages, and a real backend-to-frontend API-contract handoff.

First decisive demo: Codex builds an endpoint; Claude receives the versioned contract automatically, integrates the UI, and tests pass without manually copying instructions.

Phase 3 — Local orchestration

Add the dependency graph, ready/blocked states, safe scheduling, shared context index, change detection, and integration gates.

Phase 4 — Distributed collaboration

Connect two computers with authenticated messaging, ownership boundaries, permission prompts, reconnection, and event replay. Validate failure behavior when a device disconnects mid-task.

Phase 5 — Product experience

Expand voice control, browser collaboration, agent/subagent graph, team management, observability, and polished desktop packaging.

Validation Metrics

Time to deliver an integrated, tested feature.

Number of human coordination interventions.

Blocked/idle agent time.

Total tokens and cost per accepted task.

Integration conflicts, failed tests, and rework.

Speedup when adding agents versus overhead incurred.

Developer preference against existing workflows.

Compare the platform with manual multi-session development and existing orchestration tools using the same tasks and quality criteria.

Risks and Open Questions

1. Which supported provider interfaces allow independent long-lived sessions, reconnection, and remote control?

2. What restrictions apply to third-party orchestration of subscription-backed agent sessions?

3. How will we handle credentials, machine ownership, remote commands, and usage budgets securely?

4. How do we avoid stale context and incorrect decisions from aggressive message compression?

5. When is centralized coordination preferable to peer-to-peer messaging?

6. What is the smallest complete UX that feels polished rather than disposable?

7. How much parallelism improves throughput before merge and communication overhead dominates?

Positioning

Category: AI developer tools / multi-agent collaboration.

Audience: AI-first developers, hackathon teams, indie builders, startups, and engineering teams.

Possible business model: Free local development; paid hosted coordination and team/organization controls.

One-line pitch: A familiar, independent AI coding environment that turns separate Claude Code and Codex sessions—across one or many computers—into a coordinated development team.

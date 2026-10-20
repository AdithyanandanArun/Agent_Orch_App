# Google Antigravity provider

Relay implements Google’s standalone Antigravity ACP server as a local provider runtime. It speaks ACP over the server child process stdio and does not use a Python SDK client, the `agy` CLI, or the Antigravity editor runtime as a substitute.

## Executable and availability

Install the ACP runtime and companion using Relay’s explicit Settings installer. Relay accepts the configured executable path or resolves the exact platform ACP executable from `PATH` and `~/.local/bin`. The sibling `localharness_external` executable (or `.exe` on Windows) is required. A configured path is authoritative: a missing binary or companion is an error, with no fallback to another installation. Relay never searches editor caches.

Background detection starts the configured executable and sends only ACP `initialize`. It does not call `authenticate` or `session/new`; those can start Google authentication. A successful probe means the ACP runtime connected, not that Google sign-in or a model catalog was verified. Settings sign-in calls ACP `authenticate` with `oauth-personal`, then creates a metadata-only session. Google owns authentication persistence; Relay does not read or copy credentials.

## Run behavior

Each Relay run starts one ACP child. New conversations use `session/new`; existing native IDs use advertised `session/resume`, or `session/load` when resume is not advertised. Relay preserves the native conversation ID and never replaces a failed resume with a new thread. Relay maps supervised, balanced, and full-access to the native `default`, `auto_edit`, and `yolo` modes when those modes are advertised. The server’s administrative controls may impose additional restrictions.

The `default` model and `none` effort sentinels preserve Antigravity’s native selection. Explicit model and effort selections must be advertised by that session. Relay rejects unsupported skills, non-standard service tiers, and unavailable Relay team MCP before prompt submission. The team MCP is passed as a per-session HTTP MCP server, with its bearer token kept out of argv and diagnostics. Browser MCP is not currently wired into ACP and is reported to the run. ACP filesystem and terminal client features are not advertised or implemented.

Relay only sends one-time permission decisions and never persists “allow always.” The six exact Relay team MCP tools are auto-approved only when the run supplied `relay_team` and ACP identifies that server and tool in its MCP metadata. Supervised and balanced runs ask Relay’s approval callback for other tools; full-access follows the native YOLO mode. Provider tool IDs and returned activity are retained where ACP supplies them. Relay does not invent process hierarchies or per-run token totals. Native context-window updates are not input/output token usage.

## Catalog, usage, and history

Relay caches only model and command choices received from ACP setup or an explicit metadata refresh. Before the provider reports slash commands, the catalog is empty with a notice. Selected Relay skills are rejected instead of being redirected to another provider. Native conversation import is unsupported: listing returns no conversations and a notice, while reading fails explicitly.

Quota lookup is enabled only after an explicit Antigravity sign-in and only for ACP agent version `1.4.1`. That version’s advertised `/usage` slash command is handled before model inference, so Relay uses it in a separate maintenance session and does not resume or alter a user conversation. Other versions return an unavailable notice. Relay parses only provider-reported remaining percentages and reset text; unknown fields stay unknown. If the report shape is not recognized, Relay returns an unavailable/partial result with a bounded redacted copy of the native report. It makes no credit or reset-redemption claims.

## Protocol references and verification

Implementation is based on the ACP contract and official Google distribution reviewed for this provider. Google’s 1.4.1 official archive was inspected locally for wire behavior (SHA-256 `2e37012ceb2a5c7fc7309b6e6596234fb637ee3c62a5199f65d4cbe777871384`). The inspection verified ACP initialization, advertised capabilities, session setup and resume/load behavior, config options, per-session HTTP MCP metadata, one-time permission choices, command updates, and the native `/usage` shortcut. No source from that distribution was copied into Relay.

- [Agent Client Protocol: initialization](https://agentclientprotocol.com/protocol/initialization)
- [Agent Client Protocol: session setup](https://agentclientprotocol.com/protocol/session-setup)
- [Agent Client Protocol: session configuration](https://agentclientprotocol.com/protocol/session-config-options)
- [Agent Client Protocol: tool calls and permission requests](https://agentclientprotocol.com/protocol/tool-calls)
- [Google Antigravity ACP documentation](https://antigravity.google/docs/ide/extensions)

This implementation does not install the provider or perform paid inference. TypeScript typechecking covers the provider boundary; no provider tests were added or run for this change.

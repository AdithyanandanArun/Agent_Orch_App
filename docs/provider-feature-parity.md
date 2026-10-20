# Provider feature coverage

Updated 2026-10-20 using native harness protocols and original Mingle UI. This records the current scope of the provider integration.

| Feature | Codex | Claude |
| --- | --- | --- |
| Model discovery | App-server `model/list` | SDK `supportedModels()`; canonical aliases retained |
| Reasoning | Advertised levels, including Extra High/Max/Ultra when supported | Advertised SDK levels; unavailable controls omitted |
| Speed | Standard or advertised service tier; explicit standard-speed override | Standard; Fast only when the model reports support |
| Permissions | Supervised, Auto-accept edits, native Auto reviewer, Full access | Native default, acceptEdits, model-supported auto, bypassPermissions |
| Saved defaults | Model, effort, permission policy and service tier | Same, validated against selected model |
| `/` picker | Mingle workspace commands | Mingle commands plus SDK-reported commands and aliases |
| `$` picker | Native installed skill catalog; explicit skill input items | SDK skill catalog; one selected skill dispatched by name |
| Skill scope | Scopes returned by Codex `skills/list` | Bundled/project/available plugin skills reported under the project settings source |
| Catalog refresh | On session/model changes, reconnect or explicit retry; fresh selection validation before a run | Same; metadata RPCs have a bounded deadline and close the CLI afterward |
| Shared browser | Run-scoped local MCP tools for the visible Chromium tabs | Same, injected through SDK HTTP MCP |
| Auto-compaction | Native per-thread token threshold from provider capacity metadata | Native percentage environment override |
| `/usage` | Native quota windows, credit balance, available reset count and grant expiry details when reported | Native five-hour, seven-day and applicable scoped windows; no spendable credit balance or reset-grant count exposed by the SDK |

## Antigravity

Google's ACP runtime is a third independent provider. Settings includes explicit installation, Google sign-in, cancellation and reconnection. Model choices come from authenticated native configuration metadata; unknown thinking controls remain **Native default**. Supervised, Auto-accept edits and Full access map to ACP modes, with approvals returned to the provider through its permission request protocol. Standard is the only Mingle service tier exposed.

Independent sessions and group agents share the existing runtime, worktree, tool activity and change-summary machinery. Browser and team MCP servers are supplied per session with ephemeral authorization. Native conversation IDs are retained for later turns. Native command metadata is cached without sending discovery prompts.

Native history import, explicit skill attachments and a custom compaction threshold are unsupported. Quota reads use only the verified runtime's native maintenance command; unknown credit/reset fields remain unreported. An installed runtime is not proof of a valid Google login or account entitlement. See [Antigravity protocol research and limits](provider-antigravity.md).

## OpenCode

OpenCode's native ACP server (`opencode acp`) is the fourth independent provider. Models are its `provider/model` IDs, reasoning effort is its native model variants with an explicit Native default, and the `/` picker lists the commands (including skills) it advertises for the session folder, discovered without a prompt. Supervised, Auto-accept edits and Full access are enforced with per-run OpenCode permission rules; Auto is unsupported. Browser and team MCP are registered per session. Native history import, usage/quota, the `$` skill picker, a custom compaction threshold and service tiers are unsupported and reported explicitly. See provider-opencode.md for protocol details and verification limits.

## Mingle commands

`/new`, `/stop`, `/settings`, `/model`, `/effort`, `/permissions`, `/tier`, `/skills`, `/usage`, `/status`, `/diff` and `/help` are local Mingle actions. They do not start inference. Mingle commands take precedence over provider commands with the same names. Other Claude commands dispatch through the SDK's documented slash syntax. Codex terminal UI slash commands require individual client integrations; they are not sent as pretend prompt aliases.

The usage dialog separates Mingle conversation token/cost totals from account-wide quota windows shared with other apps. It shows percentages remaining and native reset timestamps in the local timezone, with a live countdown. Unknown values and replenishment schedules stay explicitly unreported. Manual refresh is rate limited and concurrent reads are coalesced; no reset redemption is exposed. See [Codex usage mapping](codex-usage-research.md) and [Claude usage mapping](claude-usage-research.md).

The picker supports caret-aware completion, arrow navigation, Enter/Tab selection and Escape dismissal. In a group composer, address provider actions to one member with `@handle /command arguments` or `@handle $skill arguments`; selection is checked against that member's fresh catalog again at dispatch. Actions stay on the addressed agent and use its saved settings. Codex accepts explicit native skills but does not expose prompt-style slash commands; Antigravity does not offer a Mingle-selected skill catalog. Deleting a skill marker removes its binding. Unsupported model settings fail clearly. Saved inherited settings can adapt when selecting a different model.

## Remaining coverage

Personal Claude settings/skills are not imported. Its SDK couples the user settings source to permission rules and other configuration; Mingle currently keeps its project source and disabled hooks. Discovery notices explain this boundary. Fast mode and automatic review remain subject to provider/account policy and availability.

File mentions, a dedicated planning interface, interactive provider questions, advanced context inspection, general MCP/plugin management, and additional native command actions need their own client implementations. Attachments and targeted provider actions are covered in [chat attachments and native actions](chat-attachments-and-native-actions.md), including their provider limits. The existing file editor, terminal, Changes, tasks and activity views remain available.

The shared browser and automatic compaction setting are covered in [browser setup and limits](shared-browser.md). General MCP server/plugin management remains separate from Mingle’s built-in browser connection.

## References

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) and the installed Codex CLI 0.160.1 JSON schema.
- [Claude Agent SDK skills and commands](https://code.claude.com/docs/en/agent-sdk/slash-commands) and installed SDK 0.3.302 declarations.
- [Codex control mappings](codex-controls-research.md), [Claude control mappings](claude-controls-research.md), and [validation record](validation.md).

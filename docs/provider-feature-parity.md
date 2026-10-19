# Provider feature coverage

Updated 2026-10-20 using native harness protocols and original Relay UI. This records the current scope of the provider integration.

| Feature | Codex | Claude |
| --- | --- | --- |
| Model discovery | App-server `model/list` | SDK `supportedModels()`; canonical aliases retained |
| Reasoning | Advertised levels, including Extra High/Max/Ultra when supported | Advertised SDK levels; unavailable controls omitted |
| Speed | Standard or advertised service tier; explicit standard-speed override | Standard; Fast only when the model reports support |
| Permissions | Supervised, Auto-accept edits, native Auto reviewer, Full access | Native default, acceptEdits, model-supported auto, bypassPermissions |
| Saved defaults | Model, effort, permission policy and service tier | Same, validated against selected model |
| `/` picker | Relay workspace commands | Relay commands plus SDK-reported commands and aliases |
| `$` picker | Native installed skill catalog; explicit skill input items | SDK skill catalog; one selected skill dispatched by name |
| Skill scope | Scopes returned by Codex `skills/list` | Bundled/project/available plugin skills reported under the project settings source |
| Catalog refresh | On session/model changes, reconnect or explicit retry; fresh selection validation before a run | Same; metadata RPCs have a bounded deadline and close the CLI afterward |
| `/usage` | Native quota windows, credit balance, available reset count and grant expiry details when reported | Native five-hour, seven-day and applicable scoped windows; no spendable credit balance or reset-grant count exposed by the SDK |

## Relay commands

`/new`, `/stop`, `/settings`, `/model`, `/effort`, `/permissions`, `/tier`, `/skills`, `/usage`, `/status`, `/diff` and `/help` are local Relay actions. They do not start inference. Relay commands take precedence over provider commands with the same names. Other Claude commands dispatch through the SDK's documented slash syntax. Codex terminal UI slash commands require individual client integrations; they are not sent as pretend prompt aliases.

The usage dialog separates Relay conversation token/cost totals from account-wide quota windows shared with other apps. It shows percentages remaining and native reset timestamps in the local timezone, with a live countdown. Unknown values and replenishment schedules stay explicitly unreported. Manual refresh is rate limited and concurrent reads are coalesced; no reset redemption is exposed. See [Codex usage mapping](codex-usage-research.md) and [Claude usage mapping](claude-usage-research.md).

The picker supports caret-aware completion, arrow navigation, Enter/Tab selection and Escape dismissal. Deleting a skill marker removes its binding. Manually typed or restored markers resolve against enabled skills; duplicate names require an explicit picker selection. Unsupported model settings fail clearly. Saved inherited settings can adapt when selecting a different model.

## Remaining coverage

Personal Claude settings/skills are not imported. Its SDK couples the user settings source to permission rules and other configuration; Relay currently keeps its project source and disabled hooks. Discovery notices explain this boundary. Fast mode and automatic review remain subject to provider/account policy and availability.

Attachments, file mentions, a dedicated planning interface, interactive provider questions, provider context management, MCP/plugin management, and additional native command actions need their own client implementations. They are not covered by this release. The existing file editor, terminal, Changes, tasks and activity views remain available.

## References

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) and the installed Codex CLI 0.160.1 JSON schema.
- [Claude Agent SDK skills and commands](https://code.claude.com/docs/en/agent-sdk/slash-commands) and installed SDK 0.3.302 declarations.
- [Codex control mappings](codex-controls-research.md), [Claude control mappings](claude-controls-research.md), and [validation record](validation.md).

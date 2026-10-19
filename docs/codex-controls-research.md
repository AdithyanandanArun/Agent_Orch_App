# Codex controls research

Checked against Codex CLI `0.160.1` and the JSON schema generated for that installed CLI on 2026-10-19. The official [Codex App Server reference](https://learn.chatgpt.com/docs/app-server) is the protocol reference. Relay uses only app-server methods and fields available in the installed schema; it does not depend on undocumented slash-command conventions.

## Permission policies

`thread/start` and `thread/resume` accept `approvalPolicy`, `approvalsReviewer`, and a sandbox mode. `turn/start` accepts `approvalPolicy` and `approvalsReviewer` overrides plus a typed `sandboxPolicy`. The native schemas advertise `read-only`, `workspace-write`, and `danger-full-access`; approval values include `on-request` and `never`; reviewer values include `user` and `auto_review`.

Relay maps its choices directly:

| Relay policy | Approval | Reviewer | Sandbox |
| --- | --- | --- | --- |
| `supervised` | `on-request` | `user` | read-only |
| `balanced` | `on-request` | `user` | workspace-write, session root only, network disabled |
| `auto` | `on-request` | `auto_review` | workspace-write, session root only, network disabled |
| `full-access` | `never` | `user` | danger-full-access |

Auto review is the native reviewer selected by Codex for approval requests; Relay does not disable the request path. Any app-server approval request that reaches the client still goes through Relay's existing host approval callback, which remains fail-closed. The other Relay policies explicitly select the user reviewer so an inherited app-server default cannot silently enable auto review. A native policy value is not replaced with a weaker policy when unsupported: request failures surface as provider errors.

## Models, effort and service tier

`model/list` advertises each model's `supportedReasoningEfforts`, `defaultReasoningEffort`, and `serviceTiers`/`defaultServiceTier`. Relay uses this live data to reject an effort or non-default tier that is not advertised for the selected model. It does not substitute another model, effort, or tier.

`thread/start` and `thread/resume` accept `serviceTier`; `turn/start` also accepts `serviceTier`. Relay forwards the selected tier to both thread and turn requests. Relay's `standard` setting maps to native `null`, which leaves the Codex default in effect. Other values must match a tier returned for that model.

## Skills and commands

The native `skills/list` RPC discovers available skills for a `cwd`; Relay uses it with the session worktree and `forceReload: true`. Each discovered enabled skill is surfaced using the native skill path as its stable ID. On each run the host revalidates selection against the current catalog; the adapter sends selected skills as native `skill` turn input items containing `name` and `path`.

App-server also has `command/exec` for running an argv vector and `thread/shellCommand` for explicitly user-initiated shell commands. These are command execution APIs, not a catalog of slash commands; the protocol reference lists no general command-list or named slash-command dispatch method. Relay therefore does not invent Codex prompt commands from CLI slash commands. Relay's local commands are supplied by Relay itself.

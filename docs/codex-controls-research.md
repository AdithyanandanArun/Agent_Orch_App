# Codex controls research

Checked against Codex CLI `0.160.1` and the JSON schema generated for that installed CLI on 2026-10-19. The official [Codex App Server reference](https://learn.chatgpt.com/docs/app-server) is the protocol reference. Relay uses only app-server methods and fields available in the installed schema; it does not depend on undocumented slash-command conventions.

## Permission policies

`thread/start` and `thread/resume` accept `approvalPolicy` and a sandbox mode. `turn/start` accepts an `approvalPolicy` override and a typed `sandboxPolicy`. The native schemas advertise `read-only`, `workspace-write`, and `danger-full-access`, and approval values include `on-request` and `never`.

Relay maps its choices directly:

| Relay policy | Approval | Sandbox |
| --- | --- | --- |
| `supervised` | `on-request` | read-only |
| `balanced` | `on-request` | workspace-write, session root only, network disabled |
| `auto` | `never` | workspace-write, session root only, network disabled |
| `full-access` | `never` | danger-full-access |

Approval requests from the app-server continue through Relay's existing host approval callback. A native policy value is not replaced with a weaker policy when unsupported: request failures surface as provider errors.

## Models, effort and service tier

`model/list` advertises each model's `supportedReasoningEfforts`, `defaultReasoningEffort`, and `serviceTiers`/`defaultServiceTier`. Relay uses this live data to reject an effort or non-default tier that is not advertised for the selected model. It does not substitute another model, effort, or tier.

`thread/start` and `thread/resume` accept `serviceTier`; `turn/start` also accepts `serviceTier`. Relay forwards the selected tier to both thread and turn requests. Relay's `standard` setting maps to native `null`, which leaves the Codex default in effect. Other values must match a tier returned for that model.

## Skills and commands

The native `skills/list` RPC discovers available skills for a `cwd`; Relay uses it with the session worktree and `forceReload: true`. Each discovered enabled skill is surfaced using the native skill path as its stable ID. On each run the host revalidates selection against the current catalog; the adapter sends selected skills as native `skill` turn input items containing `name` and `path`.

App-server also has `command/exec` for running an argv vector and `thread/shellCommand` for explicitly user-initiated shell commands. These are command execution APIs, not a catalog of slash commands; the protocol reference lists no general command-list or named slash-command dispatch method. Relay therefore does not invent Codex prompt commands from CLI slash commands. Relay's local commands are supplied by Relay itself.

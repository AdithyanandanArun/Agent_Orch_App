# Chat attachments and provider actions

Mingle lets you attach files to a single-agent or group message. Use the paperclip button to choose files, or paste an image into the composer. Uploads are staged as drafts before you send; failed uploads remain visible so you can retry or remove them. A message accepted by Mingle keeps its attachments in history. Removing a project from Mingle does not erase that history or its files.

Previews appear in a row above the message field, starting from the left. Multiple attachments wrap within the composer and scroll when the row reaches its height limit. They reserve their own space rather than floating over the text or controls. The paperclip stays beside the send button.

## Limits and storage

- Up to 10 files and 50 MiB total per message.
- Raster images up to 10 MiB each; other files up to 25 MiB each. Claude's inline image limit is 5 MiB.
- Uploads stream to Mingle's private application data directory, outside the repository. Names are display metadata; providers receive run-scoped copies outside the worktree.
- PNG, JPEG, GIF and WebP are signature-checked and may be previewed. Other files, including SVG and HTML, download as opaque files. Mingle does not claim to extract or understand arbitrary file formats.
- Unsent uploads expire after 24 hours. Sent files are retained with their conversation. Mingle does not add file contents to your repository or bypass the agent's configured permission policy.

## Provider support

Images use each provider's native input route when the selected model or negotiated runtime reports image support: Claude's structured SDK input, Codex local-image input, or ACP image blocks for Antigravity and OpenCode. Mingle rejects images before sending when support is not reported. A generic file is provided as a private path/reference for the agent to read under its normal permissions; it is not decoded into extracted text by Mingle.

OpenCode's native slash-command protocol accepts text parts only. Mingle refuses to send a native OpenCode command with attachments, so the files remain in the draft until you remove them or send a regular message.

## Native actions in a group

Use `@handle /command arguments` for a provider slash command, or `@handle $skill arguments` for a listed skill. Choose the exact suggestion when duplicate names appear. Mingle targets one member and rechecks its current command or skill catalog, membership, provider, model, and queue before dispatch. A stale or removed action is rejected instead of being sent to another agent. Each agent uses the model, effort and permissions already configured for that member.

Codex slash commands from its interactive terminal UI are not exposed as prompt aliases; its native installed skills can be selected. Claude accepts one selected skill per message. Antigravity does not expose a Mingle-selected skill catalog. OpenCode's advertised commands include its native skills and are sent through ACP. Mingle's own `/` commands take precedence over similarly named provider commands.

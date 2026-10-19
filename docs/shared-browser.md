# Shared browser

Relay's browser is a real Chromium controlled by the local Node server. React displays its JPEG screencast over a separate WebSocket; human input and provider tools operate the same page. This implementation is original. T3 Code was researched for its browser host, streaming, ownership and provider integration architecture, without copying its implementation or adding it as a dependency.

## Use it

Open a session, show the context pane, then select **Browser**. Choose one of:

- **Relay browser:** a separate Chromium profile for that session. Install the pinned browser from the pane or **Settings → Browser**, or configure an absolute executable path. Its profile persists under the Relay data directory. It starts with none of your personal browser's logins; logins you make here remain in this dedicated profile.
- **Your running browser:** share existing logins and open web tabs by connecting to a running Chromium browser. Enable remote debugging in that browser, select the detected browser or enter its loopback CDP endpoint, and explicitly connect. An agent cannot attach to a personal browser by itself.

For Chrome 144 or newer, open `chrome://inspect/#remote-debugging`, enable remote debugging and approve Chrome's connection prompt. Availability varies among Chromium derivatives and versions. Browsers that do not provide that consent flow need an already configured loopback CDP endpoint. Chrome 136+ refuses the old debugging-port approach with its default user-data directory; Relay does not relaunch or modify that profile to work around it. See [Chrome's auto-connect documentation](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) and [debugging-port change](https://developer.chrome.com/blog/remote-debugging-port).

A connection shares web tabs and the logged-in browser session. It does not copy cookie databases, decrypt passwords, or import profile files. Disconnecting an existing browser detaches Relay and leaves the browser and its tabs open. Closing a shared tab closes the actual tab; the UI asks before closing an existing-browser tab.

Use **Take control** to click, type, paste, scroll and navigate. **Release to agent** lets tools write again. Watching does not take control. The agent can inspect while you hold control, but its writes fail with a clear handoff message. Expand the viewer for more space. Keyboard input is captured only while the page is focused; Alt+Shift+Esc returns focus to Relay. Paste forwards the text you explicitly paste, without automatically reading the system clipboard.

## Agent access

Both Codex and Claude Code receive a local HTTP MCP connection on each enabled run. It provides status, tabs, open, snapshot, navigate, click, type, hover, select, press, scroll, resize, evaluate, wait, dialog, back, forward, reload and close tools. A snapshot includes bounded visible text, tab- and snapshot-scoped accessibility targets and an optional PNG. Textbox values are hidden; navigation or another snapshot invalidates old refs. Tools should begin with status and use fresh snapshot refs or role/name targets.

**Settings → Browser → Let agents use the browser** controls this access. Supervised and Auto-accept edits sessions require approval before the run's first browser mutation; Auto and Full access follow their selected policy. The browser is capable of actions in signed-in accounts, so those actions must follow the user's task and authorization.

Connections use ephemeral random bearer capabilities stored hashed in memory, bound to a run and session, and revoked when the run ends. They are not exposed through bootstrap or settings, and are scrubbed from provider events before persistence. Tabs are scoped to a Relay session. Streaming has bounded viewers, input queues, buffers and acknowledgement pacing. Human/agent handoffs invalidate queued writes from the old owner.

## Context compaction

**Settings → General → Context** selects a native default or an integer threshold from 1–95%. It applies to subsequent runs, including resumed conversations, through native provider controls. Claude receives its documented percentage environment override. Codex receives an absolute token limit calculated from its reported/configured model capacity. Unknown capacity leaves native compaction enabled and produces a notice; Relay never guesses a model's window. Providers may compact earlier because of their own limits and reserved context. See [the provider mapping and observed limits](provider-compaction-research.md).

## Scope and platform limits

The same server and viewer are used in the web and Electron shells. Browser discovery contains native Linux, macOS and Windows locations, but this implementation was exercised on Linux; other platforms still need device verification. Playwright's [CDP connection](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) supports Chromium only and has lower fidelity than its native transport.

This first version does not add file uploads, download management, recording, browser extension management, or profile copying. Browser-internal pages and file URLs are excluded from navigation. Native browser permission prompts still need the user. Page JavaScript that starts timers or promises cannot have its earlier side effects undone; timed-out evaluations report that limitation. Synchronous scripts have an execution deadline and termination handling, without closing personal tabs. Closing Relay closes its managed browser; attached personal browsers are detached. The session's dedicated managed profile remains on disk.

## Research references

- [T3 Code repository](https://github.com/pingdotgg/t3code), researched at `f740a97`: server preview/MCP services and Electron CDP relay.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), `BrowserManager.ts`: consent-enabled Chrome discovery uses the selected browser's `DevToolsActivePort` metadata. Relay implements its own bounded parser.
- [Chrome DevTools screencast protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast).
- [Playwright browser lifecycle](https://playwright.dev/docs/api/class-browser#browser-close): closing a connected browser disconnects it; closing a launched browser quits it.

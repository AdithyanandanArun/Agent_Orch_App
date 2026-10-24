# Secure account sign-in storage UI

Settings → Account reports whether sign-in sessions can be persisted using the operating system's keyring. “Available” means OS-keyring-backed encrypted storage; Mingle never offers a plaintext fallback. A signed-in account says whether the current sign-in is saved securely. A pending sign-in says it will be saved when browser sign-in completes. A signed-out account says whether future sign-ins will be saved securely.

The storage status uses the optional `AccountState.storage` snapshot when supplied. It distinguishes browser memory mode, missing or unreachable keyrings, an unreadable encryption key, a secure-write failure, unavailable desktop IPC, and an unreadable existing encrypted session. Recognized backend IDs are displayed as friendly labels in both available and unavailable states; backend identifiers and operating-system error text are never shown raw. A nonretryable unreadable key is preserved with support guidance; a retryable one guides the user to unlock the keyring. Secure-write failures direct the user to check disk space and Mingle app-data write permissions. If no keyring is selected, install or start a desktop keyring and restart Mingle; Retry is offered only when the server marks the state retryable.

When a desktop condition is retryable, **Retry secure storage** refreshes the secure-storage state. It does not switch accounts or providers. The UI keeps the current account, pending browser sign-in, form drafts and saved preferences while the request runs. A successful confirmation is shown only when the returned snapshot says secure storage is available. An unreadable existing session is preserved and directs the user to support; no reset or delete action is offered.

For older servers that omit `storage`, the UI falls back to the legacy `sessionStorage` value. `os-encrypted` is described as operating-system-keyring storage. `memory` is described as memory-only, and the UI notes that the server cannot provide keyring diagnostics or a retry action.

## Browser acceptance

Run from the repository root:

```sh
node scripts/account-storage-browser-acceptance.mjs
```

The workflow starts a disposable local Mingle service with a temporary data directory and the Vite web app, then exercises the real Account Settings UI in headless Playwright. Account states and responses are deterministic, clearly synthetic fixtures. It does not sign in, read credentials, run provider inference or install dependencies. It uses Playwright's browser path by default; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium executable when the browser is cached elsewhere. The script validates the path and never installs a browser.

The acceptance covers browser memory mode; retry busy, success, and preservation of a pending sign-in; signed-in account/preferences continuity; a successful HTTP response that still reports unavailable storage; a failed retry with raw OS text redacted; an unreadable saved session at a narrow viewport; and a legacy snapshot without storage metadata. Screenshots are written to `/tmp/mingle-account-storage-acceptance` by default. Set `MINGLE_ACCOUNT_ACCEPTANCE_OUT` to choose a different output directory.

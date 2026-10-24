# Secure sign-in storage acceptance — 2026-10-24

The installed application's memory-only warning was reproduced on this Hyprland host: Electron selected `basic_text` despite a working GNOME Keyring. Selecting `gnome-libsecret` made secure storage available. Mingle now selects an evidenced Secret Service or KWallet provider before Electron initializes storage, honors explicit choices, and preserves native KDE/GNOME selection when both providers are present.

| Verification | Result |
| --- | --- |
| Server suite | 43 files, 277 tests passed, including real SDK OAuth against a local identity fixture. |
| Desktop storage modules | 31 tests passed: provider selection, preserved keys, bounded reads/IPC and recovery diagnostics. |
| Existing invitation, preload, SMTP and landing boundaries | 21 tests passed. |
| Account settings browser acceptance | Passed with explicit synthetic account/storage responses and cached Chromium. |
| Integrated web build | TypeScript and Vite passed with a 2 GiB build heap; existing Zod annotation warnings remain. |
| Native OS storage | Two independent Electron launches passed encrypted example-session write/restore using GNOME Keyring, production key helpers and private parent/child IPC. |
| Live Google restart | A real Google sign-in in a disposable desktop workspace restored the same verified account after restarting, with `sessionStorage: os-encrypted` and no second Google login. |

The native smoke is explicit: `node scripts/account-storage-native-smoke.mjs [electron-path]`. It uses a disposable application identity and workspace, writes only example tokens and does not inspect existing Mingle credentials. The live Google check used a separate temporary workspace; its test session was signed out afterward and the temporary workspace removed. No provider inference ran.

The retry path can save an active memory session or restore a login that startup could not unlock. It preserves pending PKCE sign-in and rejects stale IPC replies. OAuth storage changes are held until the returned Google user is verified; denied/unverified callbacks preserve prior ciphertext. Explicit sign-out still removes saved state. Unreadable keys/sessions are preserved rather than reset automatically, and plaintext fallback remains disabled.

Independent review identified and corrected the old responder/new IPC mismatch, failed-OAuth deletion of opaque saved sessions, unbounded wrapped-key reads and IPC history, and missing unavailable-provider labels. Packaging now includes all imported account-storage modules. The final integrated review and packaged-runtime results are recorded when completed.

These observations establish behavior on this Linux host. Windows/macOS keyring persistence, KWallet on a physical KDE system, and locked-keyring prompts on other desktops still need target-device acceptance. Browser checks use named fixtures; they are separate from the real Google/keyring evidence above.

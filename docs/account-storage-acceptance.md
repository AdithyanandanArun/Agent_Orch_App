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

Independent review identified and corrected the old responder/new IPC mismatch, failed-OAuth deletion of opaque saved sessions, unbounded wrapped-key reads and IPC history, and missing unavailable-provider labels. Packaging now includes all imported account-storage modules. The final independent Luna review at `a523fd7` found no blocking issues and passed 39 desktop tests and 10 focused server storage tests. The final account-settings browser acceptance also passed after the narrow-layout adjustment at `e5807fb`. GitHub validation passed typechecking, tests, production builds and the application smoke at that source commit.

These observations establish behavior on this Linux host. Windows/macOS keyring persistence, KWallet on a physical KDE system, and locked-keyring prompts on other desktops still need target-device acceptance. Browser checks use named fixtures; they are separate from the real Google/keyring evidence above.

The final Arch artifact (SHA-256 `b416f0e6e9b3fcc62112e7235fc37f279987bef24ed854df128766bb8ad4abbd`) was installed on this device with pacman. The installed app launched normally against the existing workspace, served its built UI, and reported `sessionStorage: os-encrypted`, storage `available`, backend `gnome_libsecret`. Its sandbox helper remains owned by root with mode 4755, and the `mingle://` handler remains `mingle.desktop`. The package source tree matches `e5807fb` (worker commit `69b2e87`). No existing account/key file was inspected.

Native Debian packaging [passed on Ubuntu 22.04](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40089759643), and Windows setup packaging [passed on Windows Server 2022](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40089762279), including installation, terminal, installed Electron rendering and removal checks. These installer checks do not establish Windows keyring persistence.

The [temporary `.deb`/`.exe` release](https://github.com/AdithyanandanArun/Mingle-dev/releases/tag/temporary-downloads-20261024-keyring) is published. [Release verification](https://github.com/AdithyanandanArun/Mingle-dev/actions/runs/40090120894) passed all four asset names, sizes and SHA-256 digests.

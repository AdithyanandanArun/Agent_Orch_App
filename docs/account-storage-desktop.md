# Desktop account-key storage

Electron owns the device-local wrapping key for account sessions. Linux selection happens before Electron is ready and before the child runtime starts:

- An explicit `--password-store` switch is left untouched.
- Otherwise, Mingle probes the session D-Bus with fixed `busctl` arguments, falling back to fixed `dbus-send` arguments. Both operations have short process timeouts and bounded output. It selects `gnome-libsecret` only when `org.freedesktop.secrets` is owned or activatable, or selects the detected KWallet 4/5/6 provider when its corresponding D-Bus service is owned or activatable.
- Recognized KDE/GNOME desktop hints break a tie only when D-Bus evidence shows both candidate providers are available. Otherwise the observed provider wins; unknown compositors retain the existing provider ordering. A desktop hint never selects a provider that was not observed. If the session bus, probe tools, and known services are unavailable, Electron's default is preserved; Mingle still refuses `basic_text` and `unknown` as secure storage.

The desktop uses Electron `safeStorage` on the main process, after the app is ready. See [Electron's safeStorage API](https://www.electronjs.org/docs/latest/api/safe-storage) for its platform-specific providers and backend identifiers. The currently pinned desktop dependency uses the synchronous API; no plaintext-encryption fallback is enabled.

For a workspace data directory, the existing key path remains `account-key-<first-16-hex-of-SHA-256(workspaceDataDir)>.enc` under Electron user data. The stored value is Electron-wrapped ciphertext for one canonical base64-encoded 32-byte key. Existing wrapped files must be regular files no larger than 64 KiB; an FD-based read checks file identity and caps bytes read if the file changes concurrently. New wrapped bytes are written to a unique same-directory temporary file opened exclusively with mode `0600`, then atomically renamed. Existing wrapped bytes are not replaced after an unavailable keyring, read/decryption error, or noncanonical unwrapped value. Temporary files are removed on write/rename failure.

The main process exchanges keys only with its local child through IPC:

```text
request:  { type: "mingle.account-key.request", requestId: <32 lowercase hex> }
response: { type: "mingle.account-key", requestId, key: <base64|null>,
            storage: { status: "available"|"unavailable", backend: <string|null>,
                       reason: <reason-code|null>, retryable: <boolean> } }
```

The IPC receiver validates request IDs, serializes keyring operations, keeps at most eight queued requests and a 128-ID recent-completion history, and suppresses live duplicates. Overflow receives a sanitized retryable `ipc-unavailable` response. The channel remains connected for later explicit retries. The account key is not sent to the renderer, environment, or command line. The child/server owns request timing and retry bounds.

`account-storage/account-key.mjs` exports `createAccountKeyManager` for fresh-process persistence checks and `accountKeyFilePath` to identify the scoped target without reading it. A native two-process smoke should supply a newly created disposable user-data directory and workspace path to each process; it must not point at the developer's normal Electron profile.

Unavailable diagnostics use stable codes rather than native exception text: `no-keyring` for a Linux basic/unknown backend, `keyring-unavailable` when Electron cannot access an otherwise selected provider, `key-unreadable` for existing bytes that cannot yield a canonical key, and `storage-write-failed` for failed creation. Native file-read or decryption failures are retryable because a locked keyring may recover after unlock; an unwrapped value that is not a canonical 32-byte key is nonretryable. Native error strings, wrapped bytes and key contents are not included in diagnostics.

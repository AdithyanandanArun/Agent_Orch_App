# Desktop project-invitation links

Mingle desktop accepts project invitations through this exact link shape:

```text
mingle://join?token=<base64url-token>
```

The token is unpadded, canonical base64url with a length from 32 through 512 characters. The desktop process rejects other schemes or hosts, credentials, ports, paths, fragments, control characters, duplicate query keys, extra parameters, invalid base64url and oversized links. It never logs the invitation value.

The Electron main process receives cold-launch links from `process.argv`, later launches from Electron's `second-instance` event, and macOS links from `open-url`. The existing single-instance lock remains in force. Valid links are held in a bounded in-memory queue until the local backend and workspace window are ready, then Mingle focuses its window and loads the fixed local route `/?join=<encoded-token>`. Links do not navigate to external origins, execute code, select a checkout, start a provider run or accept an invitation automatically.

The renderer should read `join` from the initial URL, begin the invitation flow, and remove the token from browser history once it has been captured. Its invitation UI is responsible for presenting local checkout selection and initial-agent selection before any invitation is accepted or paid work begins.

Linux packages include `x-scheme-handler/mingle` in `mingle.desktop` and pass the single URL argument to the `mingle` launcher. Windows per-user installation registers `HKCU\Software\Classes\mingle` with a quoted `"mingle.exe" "%1"` command. Uninstall removes the protocol registration only while its open command still exactly matches that installation's executable. Packaged Linux/Windows apps may register through Electron; development launches do not claim the machine-wide protocol handler.

Focused validation is available with:

```sh
node --check apps/desktop/main.mjs
node --check apps/desktop/project-invitation.mjs
node --test apps/desktop/project-invitation.test.mjs
```

These checks exercise parsing, bounded queuing and local-origin dispatch without modifying OS protocol settings. Native Linux desktop-handler and Windows registry registration were not changed or exercised by the tests.

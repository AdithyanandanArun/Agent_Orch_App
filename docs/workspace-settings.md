# Provider paths and project removal

## Choose a provider executable

Open **Settings → Providers**. Each provider card has an **Executable path** field, its currently resolved executable, and **Save path**.

- Enter the executable's full native path, without shell quotes or arguments. For example: `/home/your-name/.npm-global/bin/claude`, `/Applications/example/bin/opencode`, or `C:\Tools\codex.exe`.
- Select **Save path**. Mingle saves the setting and checks availability without sending a model prompt. A failed check appears on the provider card; saving a path does not install the provider or sign in.
- Choose **Use automatic detection** to clear the override. When no override is saved, **Use detected path** fills in the resolved path for you to save explicitly.

An explicit path takes precedence over automatic discovery. An invalid override produces a visible failure instead of silently choosing another executable. Keep Antigravity's native harness beside its ACP executable when using a custom installation.

Paths use the filesystem of the machine running Mingle's local server. A Windows executable needs to be runnable on that machine; entering a path does not translate between operating systems. The desktop package has its own Node runtime, while coding providers remain separately installed.

## Remove a project from Mingle

Open the project picker and choose **Remove project…**, or open **Settings → Project** and use the same action. The confirmation names the project and shows its folder.

Removal hides the project and its conversations from Mingle. It preserves the folder, repository, branches, worktrees, conversation history, tasks and sent attachments. It does not delete files or sign out providers.

Stop running agents and close the project's terminals first. Mingle also refuses removal while session creation, provider cleanup or a repository mutation is in progress. Pending team scheduling is paused when removal succeeds.

To restore the project, use **Open project → Local folder** and select the same folder. Mingle recognizes its canonical path and restores the existing history. Resume team scheduling explicitly when you are ready; reopening the folder starts no model work.

# Continuing CLI conversations in Mingle

Type `/import` in the composer, or choose **Import conversations** from the command palette or project menu. Pick Codex or Claude, browse local history, and select a conversation to preview it. The folder is shown before import. **Import and open** prepares the session; your next message resumes the original provider conversation in that folder.

Finish any active CLI run before continuing in Mingle. Imported sessions work directly in the existing folder, so changes affect the same files. A missing folder must be restored before import; Mingle does not create a substitute. Existing Mingle conversations are opened again rather than duplicated. Explicitly importing an archived Mingle conversation restores its session.

New imports start with Supervised permissions and Standard speed. Mingle keeps a reported model when it is in the current provider model list; otherwise it uses your saved model for that provider and says so. Model and effort remain editable before your next message. Existing Mingle sessions keep their settings.

The displayed transcript is a limited text preview. Images, hidden reasoning and historical tool activity are not reconstructed. The provider continues with its native saved context, including its own compaction rules. Imported history does not report guessed usage, elapsed time, tools or file changes. Very large or unreadable transcripts may show metadata only and an explanation.

## Native APIs

Codex discovery uses the installed app-server's `thread/list` and `thread/read` APIs, with paginated history where supported. Reading history does not resume a thread or start a turn. The next user send calls the adapter's existing `thread/resume` and `turn/start` flow. [Official Codex app-server documentation](https://developers.openai.com/codex/app-server/).

Claude discovery uses the official Agent SDK's `listSessions`, `getSessionInfo` and `getSessionMessages`. Its existing adapter passes `resume` and the original working directory on the next user send. Native history APIs use the current user's local CLI configuration; Mingle does not extract login credentials. [Official Claude SDK session documentation](https://code.claude.com/docs/en/agent-sdk/sessions).

Provider versions and native history formats can differ. Failures are shown in the picker or conversation. Mingle does not silently substitute a fresh conversation when resume fails.

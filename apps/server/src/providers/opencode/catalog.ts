import { existsSync, statSync } from 'node:fs';
import type { AppSettings, ProviderCatalog, Session } from '@mingle/contracts';
import { parseNativeCommands } from './metadata.js';
import { resolveOpencode, safeOpencodeError, withProbeSession } from './runtime.js';

const SKILL_NOTICE = 'OpenCode lists its skills as slash commands through ACP. They appear under commands; Relay’s separate skill picker is unavailable for OpenCode.';
const UNSUPPORTED_NOTICE = 'Only commands that OpenCode advertises over ACP are listed. Terminal-only commands such as /undo and /redo are not available through ACP.';

/**
 * Fresh native command discovery in the session's real directory, independent of any earlier run. Project commands, plugins and
 * configuration load as they would for OpenCode itself; no prompt is submitted and the throwaway native session is removed.
 */
export async function getOpencodeCatalog(session: Session, settings: AppSettings, env: NodeJS.ProcessEnv = process.env): Promise<ProviderCatalog> {
  if (session.provider !== 'opencode') return { commands: [], skills: [], warnings: ['This catalog is only for OpenCode.'] };
  const resolved = await resolveOpencode(settings, env);
  if (!resolved.ok) return { commands: [], skills: [], warnings: [resolved.reason] };
  if (!existsSync(session.worktreePath) || !statSync(session.worktreePath).isDirectory()) {
    return { commands: [], skills: [], warnings: ['The session folder no longer exists, so OpenCode commands cannot be discovered.'] };
  }
  try {
    const commands = await withProbeSession(resolved.executable.path, { env, cwd: session.worktreePath, timeoutMs: 30_000 }, async (probe) => parseNativeCommands(await probe.commands(2_500)));
    return { commands, skills: [], warnings: [SKILL_NOTICE, UNSUPPORTED_NOTICE, ...(commands.length ? [] : ['OpenCode reported no commands for this folder.'])] };
  } catch (error) {
    return { commands: [], skills: [], warnings: [`OpenCode command discovery failed: ${safeOpencodeError(error)}`, UNSUPPORTED_NOTICE] };
  }
}

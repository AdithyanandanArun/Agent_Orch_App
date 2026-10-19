import type { AppSettings, ProviderCatalog, ProviderCommand, ProviderSkill, Session } from '@relay/contracts';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { queryWithoutPrompt } from './capabilities.js';

/** Return commands and project skills reported by Claude Code during initialization, without sending a user turn. */
export async function getClaudeCatalog(session: Session, settings: AppSettings): Promise<ProviderCatalog> {
  const catalog: ProviderCatalog = { commands: [], skills: [], warnings: [] };
  let activeQuery: Query | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    activeQuery = await queryWithoutPrompt(settings, session.worktreePath, session.model);
    timeout = setTimeout(() => activeQuery?.close(), 15_000);
    timeout.unref?.();
    const commands = await activeQuery.supportedCommands();
    const seenCommands = new Set<string>();
    const seenSkills = new Set<string>();
    for (const entry of commands) {
      const name = entry.name.trim();
      if (!name) continue;
      const builtin = entry.builtin === true;
      for (const commandName of [name, ...(entry.aliases ?? [])]) {
        const alias = commandName.trim();
        if (!alias || seenCommands.has(alias)) continue;
        seenCommands.add(alias);
        const command: ProviderCommand = {
          id: `claude-command:${alias}`,
          name: alias,
          description: entry.description,
          ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
          source: builtin ? 'provider' : 'project',
          kind: builtin ? 'action' : 'prompt',
        };
        catalog.commands.push(command);
      }
      if (!builtin && !seenSkills.has(name)) {
        seenSkills.add(name);
        const skill: ProviderSkill = {
          id: `claude-skill:${name}`,
          name,
          description: entry.description,
          source: 'project',
          enabled: true,
        };
        catalog.skills.push(skill);
      }
    }
  } catch (error) {
    catalog.warnings.push(`Claude command and skill discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (timeout) clearTimeout(timeout);
    try { activeQuery?.close(); } catch { /* already closed */ }
  }

  // The SDK couples user settings to user skills, so adding that source would also import user hooks and permission rules.
  catalog.warnings.push('Personal Claude skills and commands are not loaded. The Agent SDK exposes user settings as a shared source for skills, hooks, and permission rules; Relay loads project customizations only.');
  return catalog;
}

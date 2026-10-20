import type { AppSettings, ProviderCatalog, ProviderCommand, ProviderSkill, Session } from '@mingle/contracts';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { isRecord, redactSecrets, truncate } from '../common.js';
import { withClaudeMetadataQuery } from './capabilities.js';

const MAX_COMMANDS = 500;
const MAX_SKILLS = 250;
const MAX_NAME = 150;
const MAX_DESCRIPTION = 1_000;

function safeCommandName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_NAME && /^[A-Za-z0-9_.:-]+$/.test(name) && redactSecrets(name) === name ? name : null;
}

function safeDescription(value: unknown): string {
  return typeof value === 'string' ? truncate(redactSecrets(value), MAX_DESCRIPTION) : '';
}

function chooseCanonicalCommands(rows: unknown[]): Map<string, SlashCommand> {
  const canonical = new Map<string, SlashCommand>();
  for (const candidate of rows) {
    if (!isRecord(candidate)) continue;
    const row = candidate as unknown as SlashCommand;
    const name = safeCommandName(candidate.name);
    if (!name) continue;
    const previous = canonical.get(name);
    // Claude Code dispatches the built-in row when custom and built-in definitions share a name.
    if (!previous || (row.builtin === true && previous.builtin !== true)) canonical.set(name, row);
  }
  return canonical;
}

/** Return SDK-reported commands and skills without sending a user turn. */
export async function getClaudeCatalog(session: Session, settings: AppSettings): Promise<ProviderCatalog> {
  const catalog: ProviderCatalog = { commands: [], skills: [], warnings: [] };
  try {
    const { commands, skills, skillWarning } = await withClaudeMetadataQuery(settings, session.worktreePath, session.model, async (activeQuery) => {
      const commandRows = await activeQuery.supportedCommands();
      try {
        const skillResponse = await activeQuery.reloadSkills();
        return { commands: commandRows, skills: skillResponse.skills, skillWarning: undefined };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          commands: commandRows,
          skills: [],
          skillWarning: `Claude skill discovery is unavailable; commands were still loaded. ${truncate(redactSecrets(message), 300)}`,
        };
      }
    });
    if (skillWarning) catalog.warnings.push(skillWarning);
    const canonical = chooseCanonicalCommands((Array.isArray(commands) ? commands : []).slice(0, MAX_COMMANDS));
    const actualNames = new Set(canonical.keys());
    const resolvedNames = new Map(canonical);

    // Canonical command names beat aliases. Preserve the SDK's first alias owner where no actual name shadows it.
    for (const [name, row] of canonical) {
      const aliases = Array.isArray(row.aliases) ? row.aliases.slice(0, 50) : [];
      for (const aliasValue of aliases) {
        const alias = safeCommandName(aliasValue);
        if (alias && !actualNames.has(alias) && !resolvedNames.has(alias)) resolvedNames.set(alias, row);
      }
    }

    for (const [name, entry] of [...resolvedNames].slice(0, MAX_COMMANDS)) {
      const description = safeDescription(entry.description);
      const hint = typeof entry.argumentHint === 'string' ? truncate(redactSecrets(entry.argumentHint), 300) : '';
      const command: ProviderCommand = {
        id: `claude-command:${name}`,
        name,
        description,
        ...(hint ? { argumentHint: hint } : {}),
        // Claude does not expose whether an unmarked entry came from a project file, plugin, or MCP server.
        source: 'provider',
        // SDK-reported slash commands are dispatched through Claude's prompt syntax regardless of builtin status.
        kind: 'prompt',
      };
      catalog.commands.push(command);
    }

    const seenSkills = new Set<string>();
    for (const candidate of (Array.isArray(skills) ? skills : []).slice(0, MAX_SKILLS)) {
      if (!isRecord(candidate)) continue;
      const name = safeCommandName(candidate.name);
      const dispatch = name ? canonical.get(name) : undefined;
      if (!name || !dispatch || seenSkills.has(name) || catalog.skills.length >= MAX_SKILLS) continue;
      // A built-in command with the same actual name shadows an unmarked custom skill.
      if (dispatch.builtin === true && candidate.builtin !== true) continue;
      seenSkills.add(name);
      catalog.skills.push({
        id: `claude-skill:${name}`,
        name,
        description: safeDescription(candidate.description),
        source: 'provider',
        enabled: true,
      } satisfies ProviderSkill);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    catalog.warnings.push(`Claude command and skill discovery failed: ${truncate(redactSecrets(message), 400)}`);
  }

  // The SDK couples user settings to user skills, so adding that source would also import user hooks and permission rules.
  catalog.warnings.push('Personal Claude skills and commands are not loaded. The Agent SDK exposes user settings as a shared source for skills, hooks, and permission rules; Mingle loads project customizations only.');
  catalog.warnings.push('Claude does not report the source of unmarked commands. Mingle labels these entries as provider commands.');
  return catalog;
}

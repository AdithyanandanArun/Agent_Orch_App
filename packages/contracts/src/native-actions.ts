import { z } from 'zod';
import type { AttachmentCapabilities } from './attachments';
import type { Provider } from './provider-config';
import type { ProviderCommand, ProviderSkill } from './index';

/** Local Relay controls win over provider commands with the same name and are never offered as provider actions. */
export const RELAY_RESERVED_COMMANDS: ReadonlySet<string> = new Set([
  'new', 'stop', 'settings', 'model', 'effort', 'permissions', 'tier', 'skills', 'usage', 'import', 'status', 'diff', 'help', 'members', 'agent',
]);

/**
 * Provider controls, account commands and interactive terminal flows. They configure the provider or its terminal UI rather than perform
 * a task, and Relay already owns model, effort, policy and tier through the member's settings.
 */
const CONTROL_COMMANDS: Record<Provider, ReadonlySet<string>> = {
  claude: new Set([
    'advisor', 'agents', 'auto-mode-setup', 'autocompact', 'clear', 'color', 'compact', 'config', 'context', 'cost', 'doctor', 'effort',
    'extra-usage', 'fast', 'focus', 'heapdump', 'import', 'mcp', 'model', 'name', 'new', 'output-style', 'peers', 'reload-plugins', 'reload-skills',
    'rename', 'reset', 'settings', 'stats', 'usage', 'usage-credits', 'list-agents', 'routines', 'proactive', 'design', 'design-consent',
    'design-revoke', 'design-sync', 'workflow-launch-exec', 'ultrareview', 'team-onboarding', 'insights', 'recap', 'goal', 'skill-doctor', 'checkup',
    'schedule', 'loop', 'run-skill-generator', 'login', 'logout', 'exit', 'resume', 'rewind', 'memory', 'permissions', 'hooks', 'ide', 'plugin',
    'terminal-setup', 'vim', 'theme', 'status', 'statusline', 'upgrade', 'release-notes', 'privacy-settings', 'bug', 'add-dir',
  ]),
  codex: new Set(),
  antigravity: new Set(['logout', 'usage']),
  opencode: new Set(['undo', 'redo', 'compact', 'share', 'unshare', 'exit', 'new', 'sessions', 'models', 'themes', 'editor', 'export', 'details', 'thinking', 'connect', 'help']),
};

const safeName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name);

/** Commands that perform a task when addressed to one agent; controls, Relay-reserved names and internal entries are dropped. */
export function nativeActionCommands(provider: Provider, commands: readonly ProviderCommand[]): ProviderCommand[] {
  const controls = CONTROL_COMMANDS[provider];
  return commands.filter((command) => {
    const name = command.name.toLowerCase();
    return safeName(command.name) && !name.startsWith('__') && !RELAY_RESERVED_COMMANDS.has(name) && !controls.has(name);
  });
}

/**
 * Skills a team message can select. Claude exposes project/provider skills only (personal skills are never loaded); OpenCode and
 * Antigravity have no selected-skill API, so OpenCode's native skills are commands and Antigravity has none.
 */
export function nativeActionSkills(provider: Provider, skills: readonly ProviderSkill[]): ProviderSkill[] {
  if (provider === 'opencode' || provider === 'antigravity') return [];
  return skills.filter((skill) => skill.enabled && safeName(skill.name) && (provider !== 'claude' || skill.source !== 'user')).map(({ path: _path, ...rest }) => rest);
}

export function unsupportedActionNotes(provider: Provider): string[] {
  switch (provider) {
    case 'claude': return ['Claude runs one native command or project skill per message. Personal skills are not loaded.'];
    case 'codex': return ['Codex exposes native skills ($skill) but no prompt-style slash commands over its app-server protocol.'];
    case 'opencode': return ['OpenCode exposes its native skills as slash commands; there is no separate skill selector. Native commands take text arguments only, so they cannot carry attachments.'];
    case 'antigravity': return ['Antigravity has a native /plan command but no selected-skill API.'];
  }
}

/** Live, no-inference action menu for one team member. */
export interface NativeActionCatalog {
  sessionId: string; provider: Provider; model: string;
  commands: ProviderCommand[]; skills: ProviderSkill[];
  warnings: string[]; unsupported: string[];
  attachments: AttachmentCapabilities;
}

export const NativeActionCatalogQuerySchema = z.object({ refresh: z.enum(['true', 'false']).optional() }).strict();

import { cleanEnv } from '../common.js';

/** Leave credential lookup to Claude Code; an explicit API key takes precedence over OAuth. */
export function claudeEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const apiKey = base.ANTHROPIC_API_KEY?.trim();
  const remove = ['OPENAI_API_KEY', 'CODEX_API_KEY'];
  if (apiKey) remove.push('CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN');
  else remove.push('ANTHROPIC_API_KEY');
  return cleanEnv(base, remove, apiKey ? { ANTHROPIC_API_KEY: apiKey } : {});
}

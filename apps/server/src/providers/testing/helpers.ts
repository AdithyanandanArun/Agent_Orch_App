import type { AdapterEvent, AppSettings, RunOptions, Session } from '@relay/contracts';

export const settings: AppSettings = {
  defaultProvider: 'codex', defaultCodexModel: 'gpt-6.1-sol', defaultClaudeModel: 'claude-sonnet-5-5', defaultEffort: 'high', defaultIsolated: true,
  defaultPolicy: 'supervised', theme: 'dark', claudeExecutable: '', codexExecutable: '',
};

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1', projectId: 'project-1', name: 'Test', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high',
    status: 'idle', policy: 'supervised', isolated: true, worktreePath: '/tmp/relay-test-worktree', branch: null,
    providerSessionId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', error: null,
    inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false, ...overrides,
  };
}

export interface RunHarness {
  options: RunOptions;
  events: AdapterEvent[];
  approvals: { tool: string; description: string; input: Record<string, unknown> }[];
  controller: AbortController;
}

export function makeRun(overrides: { session?: Partial<Session>; prompt?: string; approve?: (request: { tool: string; description: string; input: Record<string, unknown> }) => Promise<boolean> | boolean; settings?: Partial<AppSettings> } = {}): RunHarness {
  const controller = new AbortController();
  const events: AdapterEvent[] = [];
  const approvals: RunHarness['approvals'] = [];
  const options: RunOptions = {
    session: makeSession(overrides.session),
    prompt: overrides.prompt ?? 'Do the thing',
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    requestApproval: async (request) => {
      approvals.push(request);
      return overrides.approve ? overrides.approve(request) : true;
    },
    settings: { ...settings, ...overrides.settings },
  };
  return { options, events, approvals, controller };
}

export const text = (events: AdapterEvent[]): string => events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('');

export async function waitFor(condition: () => boolean, label = 'condition', timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

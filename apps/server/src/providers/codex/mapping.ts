import { resolve } from 'node:path';
import type { Policy, ToolActivity, ToolCategory, ToolStatus } from '@relay/contracts';
import { describeValue, isRecord, truncate, truncateTail } from '../common.js';

/**
 * Wire values below come from the JSON Schema emitted by `codex app-server generate-json-schema`
 * (codex-cli 0.160.1): AskForApproval is kebab-case, SandboxMode is kebab-case, SandboxPolicy.type is camelCase.
 */
export interface CodexPolicy {
  approvalPolicy: 'on-request' | 'never';
  approvalsReviewer: 'auto_review' | 'user';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  sandboxPolicy: { type: 'readOnly' } | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean } | { type: 'dangerFullAccess' };
}

/** Map Relay policies directly to app-server policy values; no policy is silently downgraded. */
export function codexPolicy(policy: Policy, worktreePath: string): CodexPolicy {
  if (policy === 'full-access') {
    return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
  }
  if (policy === 'auto') {
    return { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [resolve(worktreePath)], networkAccess: false } };
  }
  if (policy === 'balanced') {
    return {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [resolve(worktreePath)], networkAccess: false },
    };
  }
  return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } };
}

export interface ApprovalPrompt { tool: string; description: string; input: Record<string, unknown> }

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

function compact(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== null));
}

function safeStructured(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[omitted nested value]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value.length > 128 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) return '[omitted binary-like value]';
    return truncate(value, 4_000);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeStructured(item, depth + 1));
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (/image|audio|base64|bytes|blob|dataurl/i.test(key)) continue;
    const safe = safeStructured(item, depth + 1);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

function mcpResultText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const parts: string[] = [];
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  if (value.structuredContent !== undefined) {
    const safe = safeStructured(value.structuredContent);
    if (safe !== undefined) {
      try { parts.push(JSON.stringify(safe)); } catch { /* non-serializable provider payload */ }
    }
  }
  const text = parts.join('\n');
  return text ? truncate(text, 20_000) : undefined;
}

function dynamicResultText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value.filter(isRecord).filter((item) => item.type === 'inputText' && typeof item.text === 'string').map((item) => item.text as string).join('\n');
  return text ? truncate(text, 20_000) : undefined;
}

export function describeCommandApproval(params: Record<string, unknown>): ApprovalPrompt {
  const network = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : null;
  const reason = str(params.reason);
  const command = str(params.command);
  const cwd = str(params.cwd);
  const base = { threadId: str(params.threadId), turnId: str(params.turnId), itemId: str(params.itemId), reason, cwd };
  if (network) {
    const host = str(network.host) ?? 'unknown host';
    const protocol = str(network.protocol) ?? 'network';
    return {
      tool: 'network',
      description: truncate(`Allow ${protocol} network access to ${host}${reason ? ` — ${reason}` : ''}`, 500),
      input: compact({ ...base, host, protocol }),
    };
  }
  const writesStdin = params.kind === 'writeStdin';
  const subject = command ?? 'an unspecified command';
  return {
    tool: writesStdin ? 'terminal_input' : 'shell',
    description: truncate(`${writesStdin ? 'Send input to a running terminal for' : 'Run'}: ${subject}${cwd ? ` (in ${cwd})` : ''}${reason ? ` — ${reason}` : ''}`, 800),
    input: compact({ ...base, command: command ? truncate(command, 4_000) : undefined, commandActions: params.commandActions }),
  };
}

export interface FileChangeSummary { path: string; kind: string; diff?: string }

export function summarizeChanges(changes: unknown): FileChangeSummary[] {
  if (!Array.isArray(changes)) return [];
  return changes.filter(isRecord).map((change) => {
    const kind = isRecord(change.kind) ? str(change.kind.type) ?? 'change' : str(change.kind) ?? 'change';
    return { path: str(change.path) ?? '(unknown path)', kind, diff: str(change.diff) };
  });
}

export function describeFileChangeApproval(params: Record<string, unknown>, known: FileChangeSummary[]): ApprovalPrompt {
  const reason = str(params.reason);
  const grantRoot = str(params.grantRoot);
  const paths = known.slice(0, 8).map((change) => `${change.kind} ${change.path}`).join(', ');
  const extra = known.length > 8 ? ` and ${known.length - 8} more` : '';
  const grant = grantRoot ? ` Approving also grants write access under ${grantRoot}.` : '';
  return {
    tool: 'file_change',
    description: truncate(`Apply file changes${paths ? `: ${paths}${extra}` : ''}${reason ? ` — ${reason}` : ''}.${grant}`, 900),
    input: compact({
      threadId: str(params.threadId), turnId: str(params.turnId), itemId: str(params.itemId), reason, grantRoot,
      changes: known.slice(0, 20).map((change) => compact({ path: change.path, kind: change.kind, diff: change.diff ? truncate(change.diff, 2_000) : undefined })),
    }),
  };
}

export function describePermissionsApproval(params: Record<string, unknown>): ApprovalPrompt {
  const permissions = isRecord(params.permissions) ? params.permissions : {};
  const parts: string[] = [];
  const network = isRecord(permissions.network) ? permissions.network : null;
  if (network?.enabled) parts.push('network access');
  const fileSystem = isRecord(permissions.fileSystem) ? permissions.fileSystem : null;
  if (fileSystem) parts.push(`filesystem access (${describeValue(fileSystem, 300)})`);
  const reason = str(params.reason);
  return {
    tool: 'permissions',
    description: truncate(`Grant additional sandbox permissions: ${parts.join(', ') || describeValue(permissions, 200)}${reason ? ` — ${reason}` : ''}. Granted for this turn only.`, 700),
    input: compact({ threadId: str(params.threadId), turnId: str(params.turnId), itemId: str(params.itemId), reason, cwd: str(params.cwd), permissions }),
  };
}

export function describeLegacyApproval(method: string, params: Record<string, unknown>): ApprovalPrompt {
  if (method === 'execCommandApproval') {
    const command = Array.isArray(params.command) ? params.command.map(String).join(' ') : str(params.command) ?? 'an unspecified command';
    const reason = str(params.reason);
    return {
      tool: 'shell',
      description: truncate(`Run: ${command}${str(params.cwd) ? ` (in ${str(params.cwd)})` : ''}${reason ? ` — ${reason}` : ''}`, 800),
      input: compact({ command: truncate(command, 4_000), cwd: str(params.cwd), reason }),
    };
  }
  const files = isRecord(params.fileChanges) ? Object.keys(params.fileChanges) : [];
  return {
    tool: 'file_change',
    description: truncate(`Apply file changes${files.length ? `: ${files.slice(0, 8).join(', ')}` : ''}${str(params.reason) ? ` — ${str(params.reason)}` : ''}`, 800),
    input: compact({ files, reason: str(params.reason), grantRoot: str(params.grantRoot) }),
  };
}

/** Approval answers exactly as documented. `cancel` also interrupts the turn, so it is only used while aborting. */
export function commandDecision(approved: boolean, cancelling: boolean): { decision: 'accept' | 'decline' | 'cancel' } {
  return { decision: approved ? 'accept' : cancelling ? 'cancel' : 'decline' };
}

export function permissionsResponse(approved: boolean, requested: unknown): { permissions: Record<string, unknown>; scope: 'turn' } {
  if (!approved || !isRecord(requested)) return { permissions: {}, scope: 'turn' };
  return { permissions: compact({ network: requested.network, fileSystem: requested.fileSystem }), scope: 'turn' };
}

export function legacyDecision(approved: boolean, cancelling: boolean): { decision: 'approved' | 'denied' | 'abort' } {
  return { decision: approved ? 'approved' : cancelling ? 'abort' : 'denied' };
}

/** Maps app-server items to one evolving tool card. Returns null for non-tool items. */
export function itemToolActivity(item: Record<string, unknown>, phase: 'started' | 'completed'): ToolActivity | null {
  const done = phase === 'completed';
  const id = str(item.id);
  if (!id) return null;
  const rawStatus = str(item.status);
  const hasError = (isRecord(item.error) && Boolean(str(item.error.message))) || typeof item.error === 'string' && Boolean(item.error);
  const nonzeroExit = typeof item.exitCode === 'number' && item.exitCode !== 0;
  const status: ToolStatus = !done ? 'running' : rawStatus === 'interrupted' ? 'interrupted' : rawStatus === 'failed' || rawStatus === 'declined' || item.success === false || hasError || nonzeroExit ? 'failed' : 'completed';
  const base = { id, status, ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}) };
  switch (item.type) {
    case 'commandExecution': {
      const command = str(item.command);
      const cwd = str(item.cwd);
      return { ...base, name: 'shell', category: 'command', ...(command ? { summary: truncate(`$ ${command}`, 1_500) } : phase === 'started' ? { summary: 'Shell command' } : {}), ...(command ? { command: truncate(command, 4_000) } : {}), ...(command || cwd ? { input: describeValue(compact({ command, cwd }), 4_000) } : {}), ...(cwd ? { cwd } : {}),
        ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}), ...(typeof item.processId === 'string' ? { processId: item.processId } : {}),
        ...(str(item.aggregatedOutput) ? { output: truncateTail(str(item.aggregatedOutput)!, 20_000) } : {}) };
    }
    case 'fileChange': {
      const changes = summarizeChanges(item.changes);
      const list = changes.map((change) => `${change.kind} ${change.path}`).join('\n') || '(no file list)';
      const diff = changes.map((change) => change.diff ?? '').filter(Boolean).join('\n');
      return { ...base, name: 'file_change', category: 'file', ...(item.changes !== undefined ? { summary: truncate(list, 1_500), input: truncate(describeValue(item.changes, 4_000), 4_000) } : phase === 'started' ? { summary: truncate(list, 1_500) } : {}), ...(diff ? { output: truncate(diff, 8_000) } : {}) };
    }
    case 'mcpToolCall': {
      const name = `mcp:${str(item.server) ?? '?'}/${str(item.tool) ?? '?'}`;
      const failure = isRecord(item.error) ? str(item.error.message) : str(item.error);
      const identity = `${str(item.server) ?? ''} ${str(item.tool) ?? ''}`.toLowerCase();
      const category: ToolCategory = str(item.server) === 'relay_team' && /^team_/.test(str(item.tool) ?? '') ? 'agent'
        : /browser|playwright|puppeteer/.test(identity) || (/t3_code/.test(identity) && /preview_/.test(identity)) ? 'browser' : 'other';
      const output = [failure, done ? mcpResultText(item.result) : undefined].filter(Boolean).join('\n');
      return { ...base, name, category, summary: name, ...(item.arguments !== undefined ? { input: describeValue(item.arguments, 4_000) } : {}), ...(output ? { output: truncate(output, 20_000) } : {}) };
    }
    case 'dynamicToolCall': {
      const name = str(item.tool) ?? '?';
      const identity = `${str(item.namespace) ?? ''} ${name}`.toLowerCase();
      const category: ToolCategory = (str(item.namespace) === 'relay_team' && /^team_/.test(name)) || /^mcp__relay_team__team_/.test(name) ? 'agent'
        : /browser|playwright/.test(identity) || (/t3_code/.test(identity) && /preview_/.test(identity)) ? 'browser' : 'other';
      const output = done ? dynamicResultText(item.contentItems) : undefined;
      return { ...base, name: `tool:${name}`, category, summary: truncate(name, 300), ...(item.arguments !== undefined ? { input: describeValue(item.arguments, 4_000) } : {}), ...(output ? { output } : {}) };
    }
    case 'webSearch': {
      const action = isRecord(item.action) ? item.action : {};
      const actionType = str(action.type);
      const category: ToolCategory = actionType === 'search' ? 'search' : actionType === 'openPage' || actionType === 'findInPage' ? 'browser' : 'other';
      const name = actionType === 'search' ? 'web_search' : actionType === 'openPage' ? 'web_open_page' : actionType === 'findInPage' ? 'web_find_in_page' : 'web_action';
      const summary = actionType === 'search' ? str(action.query) ?? (Array.isArray(action.queries) ? action.queries.filter((query): query is string => typeof query === 'string').join(', ') : 'Search web')
        : str(action.url) ?? str(action.pattern) ?? 'Web action';
      return { ...base, name, category, ...(item.action !== undefined || item.query !== undefined || phase === 'started' ? { summary: truncate(summary, 600) } : {}), ...(item.action !== undefined || item.query !== undefined ? { input: describeValue(item.action ?? item.query, 4_000) } : {}), ...(str(item.result) ? { output: truncate(str(item.result)!, 20_000) } : {}) };
    }
    case 'collabToolCall':
    case 'collabAgentToolCall': {
      const tool = str(item.tool) ?? '?';
      const category: ToolCategory = ['spawnAgent', 'spawn_agent'].includes(tool) ? 'agent' : 'other';
      return { ...base, name: `agent:${tool}`, category, summary: truncate(str(item.prompt) ?? `Agent ${tool}`, 600), input: describeValue(item, 4_000), ...(str(item.output) ? { output: truncate(str(item.output)!, 20_000) } : {}) };
    }
    case 'imageView': return { ...base, name: 'image_view', category: 'other', summary: str(item.path) ?? 'View image', input: str(item.path) ?? '' };
    default:
      return null;
  }
}

interface Counters { input: number; output: number }

function counters(value: unknown): Counters | null {
  if (!isRecord(value) || typeof value.inputTokens !== 'number' || typeof value.outputTokens !== 'number') return null;
  return { input: value.inputTokens, output: value.outputTokens };
}

/**
 * thread/tokenUsage/updated reports thread-lifetime totals. A run's own usage is the growth since the
 * run began; the baseline is inferred from the first update as `total - last` (last = latest model call).
 */
export class CodexUsageTracker {
  private baseline: Counters | null = null;
  private latest: Counters | null = null;

  update(tokenUsage: unknown): void {
    if (!isRecord(tokenUsage)) return;
    const total = counters(tokenUsage.total);
    if (!total) return;
    const last = counters(tokenUsage.last);
    this.baseline ??= last ? { input: Math.max(0, total.input - last.input), output: Math.max(0, total.output - last.output) } : { input: 0, output: 0 };
    this.latest = total;
  }

  result(): { inputTokens: number; outputTokens: number } | null {
    if (!this.latest || !this.baseline) return null;
    return { inputTokens: Math.max(0, this.latest.input - this.baseline.input), outputTokens: Math.max(0, this.latest.output - this.baseline.output) };
  }
}

export function describeTurnError(error: unknown, fallback = 'Codex turn failed'): string {
  if (!isRecord(error)) return fallback;
  const message = str(error.message) ?? fallback;
  const info = error.codexErrorInfo;
  let tag: string | undefined;
  if (typeof info === 'string') tag = info;
  else if (isRecord(info)) tag = Object.keys(info)[0];
  const variant = isRecord(info) && tag ? info[tag] : undefined;
  const status = isRecord(variant) && typeof variant.httpStatusCode === 'number' ? ` HTTP ${variant.httpStatusCode}` : '';
  const details = str(error.additionalDetails);
  return truncate(`${message}${tag ? ` [${tag}${status}]` : ''}${details ? ` — ${details}` : ''}`, 1_200);
}

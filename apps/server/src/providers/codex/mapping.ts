import { resolve } from 'node:path';
import type { AdapterEvent, Policy, ToolActivity, ToolCategory, ToolStatus } from '@relay/contracts';
import { describeValue, isRecord, truncate, truncateTail } from '../common.js';

/**
 * Wire values below come from the JSON Schema emitted by `codex app-server generate-json-schema`
 * (codex-cli 0.160.1): AskForApproval is kebab-case, SandboxMode is kebab-case, SandboxPolicy.type is camelCase.
 */
export interface CodexPolicy {
  approvalPolicy: 'on-request';
  sandbox: 'read-only' | 'workspace-write';
  sandboxPolicy: { type: 'readOnly' } | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean };
}

/** Both policies keep approvals on; they differ in what the sandbox allows without asking. */
export function codexPolicy(policy: Policy, worktreePath: string): CodexPolicy {
  if (policy === 'balanced') {
    return {
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [resolve(worktreePath)], networkAccess: false },
    };
  }
  return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } };
}

export interface ApprovalPrompt { tool: string; description: string; input: Record<string, unknown> }

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

function compact(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== null));
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

function outputTail(value: unknown, max: number): string {
  const text = str(value);
  return text ? `\n${truncateTail(text.trimEnd(), max)}` : '';
}

/** Maps app-server items to one evolving tool card. Returns null for non-tool items. */
export function itemToolActivity(item: Record<string, unknown>, phase: 'started' | 'completed', fallbackId?: string): ToolActivity | null {
  const done = phase === 'completed';
  const id = str(item.id) ?? fallbackId;
  if (!id) return null;
  const rawStatus = str(item.status);
  const status: ToolStatus = !done ? 'running' : rawStatus === 'failed' || rawStatus === 'declined' ? 'failed' : rawStatus === 'interrupted' ? 'interrupted' : 'completed';
  const base = { id, status, ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}) };
  switch (item.type) {
    case 'commandExecution': {
      const command = str(item.command) ?? '(unknown command)';
      return { ...base, name: 'shell', category: 'command', summary: truncate(`$ ${command}`, 1_500), command: truncate(command, 4_000), input: describeValue({ command, cwd: item.cwd }, 4_000), cwd: str(item.cwd) ?? null,
        ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}), ...(typeof item.processId === 'string' ? { processId: item.processId } : {}),
        ...(str(item.aggregatedOutput) ? { output: truncateTail(str(item.aggregatedOutput)!, 20_000) } : {}) };
    }
    case 'fileChange': {
      const changes = summarizeChanges(item.changes);
      const list = changes.map((change) => `${change.kind} ${change.path}`).join('\n') || '(no file list)';
      const diff = changes.map((change) => change.diff ?? '').filter(Boolean).join('\n');
      return { ...base, name: 'file_change', category: 'file', summary: truncate(list, 1_500), input: truncate(describeValue(item.changes, 4_000), 4_000), ...(diff ? { output: truncate(diff, 8_000) } : {}) };
    }
    case 'mcpToolCall': {
      const name = `mcp:${str(item.server) ?? '?'}/${str(item.tool) ?? '?'}`;
      const failure = isRecord(item.error) ? str(item.error.message) : str(item.error);
      const identity = `${str(item.server) ?? ''} ${str(item.tool) ?? ''}`.toLowerCase();
      const category: ToolCategory = /browser|playwright|puppeteer/.test(identity) || (/t3_code/.test(identity) && /preview_/.test(identity)) ? 'browser' : 'other';
      return { ...base, name, category, summary: name, input: describeValue(item.arguments, 4_000), ...(failure ? { output: truncate(failure, 8_000) } : {}) };
    }
    case 'dynamicToolCall': {
      const name = str(item.tool) ?? '?';
      const identity = `${str(item.server) ?? ''} ${name}`.toLowerCase();
      const category: ToolCategory = /browser|playwright/.test(identity) || (/t3_code/.test(identity) && /preview_/.test(identity)) ? 'browser' : 'other';
      return { ...base, name: `tool:${name}`, category, summary: truncate(name, 300), input: describeValue(item.arguments, 4_000), ...(str(item.content) ? { output: truncate(str(item.content)!, 20_000) } : {}) };
    }
    case 'webSearch': {
      const action = isRecord(item.action) ? item.action : {};
      const actionType = str(action.type);
      const category: ToolCategory = actionType === 'search' ? 'search' : actionType === 'openPage' || actionType === 'findInPage' ? 'browser' : 'other';
      const name = actionType === 'search' ? 'web_search' : actionType === 'openPage' ? 'web_open_page' : actionType === 'findInPage' ? 'web_find_in_page' : 'web_action';
      const summary = actionType === 'search' ? str(action.query) ?? (Array.isArray(action.queries) ? action.queries.filter((query): query is string => typeof query === 'string').join(', ') : 'Search web')
        : str(action.url) ?? str(action.pattern) ?? 'Web action';
      return { ...base, name, category, summary: truncate(summary, 600), input: describeValue(action, 4_000), ...(str(item.result) ? { output: truncate(str(item.result)!, 20_000) } : {}) };
    }
    case 'collabAgentToolCall': return { ...base, name: `agent:${str(item.tool) ?? '?'}`, category: 'agent', summary: truncate(str(item.prompt) ?? 'Delegate task', 600), input: describeValue(item, 4_000), ...(str(item.output) ? { output: truncate(str(item.output)!, 20_000) } : {}) };
    case 'imageView': return { ...base, name: 'image_view', category: 'other', summary: str(item.path) ?? 'View image', input: str(item.path) ?? '' };
    default:
      return null;
  }
}

/** Compatibility projection for existing mapper checks; provider adapters emit structured activity. */
export function itemToolEvent(item: Record<string, unknown>, phase: 'started' | 'completed'): AdapterEvent | null {
  if (item.type === 'contextCompaction') return phase === 'completed' ? { type: 'info', content: 'Codex compacted the conversation context.' } : null;
  const activity = itemToolActivity(item, phase, str(item.id) ?? 'compat-item');
  return activity ? { type: 'tool', name: activity.name, content: truncate(`${activity.summary}${activity.output ? `\n${activity.output}` : ''}`, 8_000) } : null;
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

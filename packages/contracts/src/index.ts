import { z } from 'zod';

export const ProviderSchema = z.enum(['codex', 'claude']);
export type Provider = z.infer<typeof ProviderSchema>;
export const PolicySchema = z.enum(['supervised', 'balanced', 'auto', 'full-access']);
export type Policy = z.infer<typeof PolicySchema>;
// Harness model discovery advertises valid effort/tier identifiers; validate membership on the server.
export const EffortSchema = z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_-]*$/);
export type Effort = z.infer<typeof EffortSchema>;
export const ServiceTierSchema = z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_-]*$/);
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'interrupted' | 'error';
export type TaskStatus = 'backlog' | 'ready' | 'running' | 'blocked' | 'review' | 'done';
export interface Project { id: string; name: string; path: string; createdAt: string; isExample: boolean }
export interface Session {
  id: string; projectId: string; name: string; provider: Provider; model: string; effort: Effort;
  status: SessionStatus; policy: Policy; serviceTier?: string; isolated: boolean; worktreePath: string; branch: string | null;
  providerSessionId: string | null; createdAt: string; updatedAt: string; error: string | null;
  inputTokens: number; outputTokens: number; costUsd: number | null;
  pinned: boolean; unread: boolean;
}
export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type ToolCategory = 'command' | 'browser' | 'search' | 'file' | 'agent' | 'other';
export type ToolStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export interface SessionRun {
  id: string; sessionId: string; userMessageId: string; provider: Provider; model: string;
  status: RunStatus; startedAt: string; finishedAt: string | null; durationMs: number | null;
  toolCount: number; toolCounts: Partial<Record<ToolCategory, number>>;
  changes?: RunChangesSummary | null;
}
export interface RunChangedFile {
  path: string; status: 'A' | 'M' | 'D' | 'T'; additions: number | null; deletions: number | null; binary: boolean;
}
/** Saved net workspace edits between this run's start and end; unknown historical runs have no summary. */
export interface RunChangesSummary {
  status: 'available' | 'unavailable'; capturedAt: string;
  fileCount: number; files: RunChangedFile[]; additions: number; deletions: number;
  truncated: boolean; notices: string[];
}
export interface RunChanges { summary: RunChangesSummary; diff: string; diffTruncated: boolean }
/** One provider tool invocation, updated throughout its lifecycle rather than duplicated for start/result. */
export interface ToolCall {
  id: string; runId: string; sessionId: string; providerId: string; parentProviderId: string | null;
  name: string; category: ToolCategory; status: ToolStatus; summary: string; command: string | null;
  input: string; output: string; outputTruncated?: boolean; cwd: string | null; exitCode: number | null; processId: string | null;
  startedAt: string; finishedAt: string | null; durationMs: number | null;
}
/** Provider-supplied fields; host assigns durable IDs and timestamps. Missing fields retain their previous value. */
export interface ToolActivity {
  id: string; name: string; category: ToolCategory; status: ToolStatus;
  parentId?: string | null; summary?: string; command?: string | null; input?: string; output?: string;
  cwd?: string | null; exitCode?: number | null; processId?: string | null; durationMs?: number | null;
}
export interface Message { id: string; sessionId: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; createdAt: string; kind?: string; runId?: string }
export interface Task { id: string; projectId: string; title: string; description: string; acceptanceCriteria: string; sessionId: string | null; dependsOn: string[]; status: TaskStatus; createdAt: string; updatedAt: string }
export interface WorkspaceEvent { id: number; projectId: string | null; sessionId: string | null; type: string; summary: string; payload: Record<string, unknown>; createdAt: string }
export interface Approval { id: string; sessionId: string; tool: string; description: string; input: Record<string, unknown>; status: 'pending' | 'approved' | 'denied'; createdAt: string }
export interface ProviderModel {
  id: string; name: string;
  aliases?: string[];
  reasoningEfforts?: { id: string; label: string; description?: string }[];
  defaultReasoningEffort?: string;
  serviceTiers?: { id: string; name: string; description?: string }[];
  defaultServiceTier?: string;
  policies?: Policy[];
}
export interface ProviderInfo { id: Provider; name: string; available: boolean; version: string | null; executable: string | null; reason: string | null; models: ProviderModel[]; policies?: Policy[] }
export interface ProviderCommand {
  id: string; name: string; description: string; argumentHint?: string;
  source: 'provider' | 'project' | 'user' | 'relay'; kind: 'prompt' | 'action';
}
export interface ProviderSkill {
  id: string; name: string; description: string; path?: string;
  source: 'provider' | 'project' | 'user'; enabled: boolean;
}
export interface ProviderCatalog { commands: ProviderCommand[]; skills: ProviderSkill[]; warnings: string[] }
export interface UsageWindow {
  id: string; label: string; scope?: string;
  usedPercent: number | null; remainingPercent: number | null;
  resetAt: string | null; windowMinutes: number | null;
}
export interface UsageCredits {
  balance: string | null; unit: string | null; unlimited: boolean | null; resetAt: string | null;
}
export interface UsageResetGrant {
  id: string; label: string; expiresAt: string | null; grantedAt: string | null;
}
export interface ProviderUsage {
  provider: Provider; fetchedAt: string; status: 'available' | 'partial' | 'unavailable'; plan: string | null;
  windows: UsageWindow[]; credits: UsageCredits | null;
  resets: { available: number | null; grants: UsageResetGrant[]; detailsKnown: boolean; replenishesAt: string | null } | null;
  notices: string[];
}
export interface SessionUsage extends ProviderUsage {
  session: { id: string; inputTokens: number; outputTokens: number; costUsd: number | null };
}
export interface AppSettings {
  defaultProvider: Provider; defaultCodexModel: string; defaultClaudeModel: string; defaultEffort: Effort; defaultIsolated: boolean;
  defaultPolicy: Policy; defaultServiceTier?: string; theme: 'dark' | 'light'; claudeExecutable: string; codexExecutable: string;
}
export interface Bootstrap { projects: Project[]; sessions: Session[]; messages: Message[]; tasks: Task[]; events: WorkspaceEvent[]; approvals: Approval[]; providers: ProviderInfo[]; settings: AppSettings; version: string; runs: SessionRun[]; toolCalls: ToolCall[] }
export interface GitFile { path: string; status: string }
export interface GitStatus { branch: string; files: GitFile[]; diff: string; isRepo: boolean }
export interface FileEntry { path: string; name: string; type: 'file' | 'directory' }
export type ServerEvent =
  | { type: 'state.changed'; event?: WorkspaceEvent }
  | { type: 'session.delta'; sessionId: string; messageId: string; delta: string; offset?: number }
  | { type: 'terminal.ready'; terminalId: string }
  | { type: 'terminal.error'; message: string }
  | { type: 'terminal.output'; terminalId: string; data: string }
  | { type: 'terminal.exit'; terminalId: string; exitCode: number };
export type ClientEvent =
  | { type: 'terminal.start'; projectId: string; sessionId?: string; cols: number; rows: number }
  | { type: 'terminal.input'; terminalId: string; data: string }
  | { type: 'terminal.resize'; terminalId: string; cols: number; rows: number }
  | { type: 'terminal.stop'; terminalId: string };

export const CreateProjectSchema = z.object({ name: z.string().trim().min(1).max(100), path: z.string().trim().min(1).max(4096) });
export const UpdateProjectSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const CreateSessionSchema = z.object({
  projectId: z.string().min(1), name: z.string().trim().min(1).max(100).optional(), provider: ProviderSchema.optional(),
  model: z.string().trim().min(1).max(150).optional(), effort: EffortSchema.optional(),
  policy: PolicySchema.optional(), serviceTier: ServiceTierSchema.optional(), isolated: z.boolean().optional(),
});
export const UpdateSessionSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(), provider: ProviderSchema.optional(),
  model: z.string().trim().min(1).max(150).optional(), effort: EffortSchema.optional(), policy: PolicySchema.optional(), serviceTier: ServiceTierSchema.optional(),
  pinned: z.boolean().optional(), unread: z.boolean().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, 'Supply a session setting to update');
export const SendMessageSchema = z.object({ content: z.string().trim().min(1).max(100_000), skills: z.array(z.string().min(1).max(4096)).max(20).optional() }).strict();
export const CreateTaskSchema = z.object({ projectId: z.string().min(1), title: z.string().trim().min(1).max(200), description: z.string().max(20_000).default(''), acceptanceCriteria: z.string().max(10_000).default(''), sessionId: z.string().nullable().default(null), dependsOn: z.array(z.string()).max(100).default([]) });
export const UpdateTaskSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().max(20_000).optional(), acceptanceCriteria: z.string().max(10_000).optional(), sessionId: z.string().nullable().optional(), dependsOn: z.array(z.string()).max(100).optional(), status: z.enum(['backlog', 'ready', 'running', 'blocked', 'review', 'done']).optional() });
export const HandoffSchema = z.object({ fromSessionId: z.string().min(1), toSessionId: z.string().min(1), taskId: z.string().optional(), path: z.string().min(1).max(4096), revision: z.string().trim().min(1).max(100), note: z.string().max(10_000).default('') });
export const UpdateSettingsSchema = z.object({
  defaultProvider: ProviderSchema.optional(), defaultCodexModel: z.string().trim().min(1).max(150).optional(),
  defaultClaudeModel: z.string().trim().min(1).max(150).optional(), defaultEffort: EffortSchema.optional(),
  defaultIsolated: z.boolean().optional(),
  defaultPolicy: PolicySchema.optional(), defaultServiceTier: ServiceTierSchema.optional(), theme: z.enum(['dark', 'light']).optional(),
  claudeExecutable: z.string().max(4096).optional(), codexExecutable: z.string().max(4096).optional(),
});
export const ApprovalDecisionSchema = z.object({ decision: z.enum(['approved', 'denied']) });

// Provider boundary: implemented independently from persistence and transport.
export interface RunOptions { session: Session; prompt: string; skills?: ProviderSkill[]; signal: AbortSignal; onEvent: (event: AdapterEvent) => void; requestApproval: (request: { tool: string; description: string; input: Record<string, unknown> }) => Promise<boolean>; settings: AppSettings }
export type AdapterEvent =
  | { type: 'session'; providerSessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; content: string }
  | { type: 'tool.activity'; activity: ToolActivity }
  | { type: 'tool.output'; id: string; delta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number | null }
  | { type: 'info'; content: string };
export interface AgentAdapter { run(options: RunOptions): Promise<void> }

/**
 * Merge a text chunk at its absolute offset. A bootstrap snapshot may already contain some or all of it.
 * null means the client has a gap and must fetch a current snapshot rather than invent missing text.
 */
export { mergeTextDelta } from './stream';

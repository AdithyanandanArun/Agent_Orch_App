import { z } from 'zod';

export const ProviderSchema = z.enum(['codex', 'claude']);
export type Provider = z.infer<typeof ProviderSchema>;
export const PolicySchema = z.enum(['supervised', 'balanced']);
export type Policy = z.infer<typeof PolicySchema>;
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'interrupted' | 'error';
export type TaskStatus = 'backlog' | 'ready' | 'running' | 'blocked' | 'review' | 'done';
export interface Project { id: string; name: string; path: string; createdAt: string; isExample: boolean }
export interface Session {
  id: string; projectId: string; name: string; provider: Provider; model: string; effort: 'low' | 'medium' | 'high';
  status: SessionStatus; policy: Policy; isolated: boolean; worktreePath: string; branch: string | null;
  providerSessionId: string | null; createdAt: string; updatedAt: string; error: string | null;
  inputTokens: number; outputTokens: number; costUsd: number | null;
}
export interface Message { id: string; sessionId: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; createdAt: string; kind?: string }
export interface Task { id: string; projectId: string; title: string; description: string; acceptanceCriteria: string; sessionId: string | null; dependsOn: string[]; status: TaskStatus; createdAt: string; updatedAt: string }
export interface WorkspaceEvent { id: number; projectId: string | null; sessionId: string | null; type: string; summary: string; payload: Record<string, unknown>; createdAt: string }
export interface Approval { id: string; sessionId: string; tool: string; description: string; input: Record<string, unknown>; status: 'pending' | 'approved' | 'denied'; createdAt: string }
export interface ProviderInfo { id: Provider; name: string; available: boolean; version: string | null; executable: string | null; reason: string | null; models: { id: string; name: string }[] }
export interface AppSettings { defaultPolicy: Policy; theme: 'dark' | 'light'; claudeExecutable: string; codexExecutable: string }
export interface Bootstrap { projects: Project[]; sessions: Session[]; messages: Message[]; tasks: Task[]; events: WorkspaceEvent[]; approvals: Approval[]; providers: ProviderInfo[]; settings: AppSettings; version: string }
export interface GitFile { path: string; status: string }
export interface GitStatus { branch: string; files: GitFile[]; diff: string; isRepo: boolean }
export interface FileEntry { path: string; name: string; type: 'file' | 'directory' }
export type ServerEvent =
  | { type: 'state.changed'; event?: WorkspaceEvent }
  | { type: 'session.delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'terminal.ready'; terminalId: string }
  | { type: 'terminal.output'; terminalId: string; data: string }
  | { type: 'terminal.exit'; terminalId: string; exitCode: number };
export type ClientEvent =
  | { type: 'terminal.start'; projectId: string; sessionId?: string; cols: number; rows: number }
  | { type: 'terminal.input'; terminalId: string; data: string }
  | { type: 'terminal.resize'; terminalId: string; cols: number; rows: number }
  | { type: 'terminal.stop'; terminalId: string };

export const CreateProjectSchema = z.object({ name: z.string().trim().min(1).max(100), path: z.string().trim().min(1).max(4096) });
export const CreateSessionSchema = z.object({
  projectId: z.string().min(1), name: z.string().trim().min(1).max(100), provider: ProviderSchema,
  model: z.string().trim().min(1).max(150), effort: z.enum(['low', 'medium', 'high']).default('high'),
  policy: PolicySchema.default('supervised'), isolated: z.boolean().default(true),
});
export const SendMessageSchema = z.object({ content: z.string().trim().min(1).max(100_000) });
export const CreateTaskSchema = z.object({ projectId: z.string().min(1), title: z.string().trim().min(1).max(200), description: z.string().max(20_000).default(''), acceptanceCriteria: z.string().max(10_000).default(''), sessionId: z.string().nullable().default(null), dependsOn: z.array(z.string()).max(100).default([]) });
export const UpdateTaskSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().max(20_000).optional(), acceptanceCriteria: z.string().max(10_000).optional(), sessionId: z.string().nullable().optional(), dependsOn: z.array(z.string()).max(100).optional(), status: z.enum(['backlog', 'ready', 'running', 'blocked', 'review', 'done']).optional() });
export const HandoffSchema = z.object({ fromSessionId: z.string().min(1), toSessionId: z.string().min(1), taskId: z.string().optional(), path: z.string().min(1).max(4096), revision: z.string().trim().min(1).max(100), note: z.string().max(10_000).default('') });
export const UpdateSettingsSchema = z.object({ defaultPolicy: PolicySchema.optional(), theme: z.enum(['dark', 'light']).optional(), claudeExecutable: z.string().max(4096).optional(), codexExecutable: z.string().max(4096).optional() });
export const ApprovalDecisionSchema = z.object({ decision: z.enum(['approved', 'denied']) });

// Provider boundary: implemented independently from persistence and transport.
export interface RunOptions { session: Session; prompt: string; signal: AbortSignal; onEvent: (event: AdapterEvent) => void; requestApproval: (request: { tool: string; description: string; input: Record<string, unknown> }) => Promise<boolean>; settings: AppSettings }
export type AdapterEvent =
  | { type: 'session'; providerSessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; content: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number | null }
  | { type: 'info'; content: string };
export interface AgentAdapter { run(options: RunOptions): Promise<void> }

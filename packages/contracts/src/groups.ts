import { z } from 'zod';
import { ProviderSchema, PolicySchema, EffortSchema, ServiceTierSchema } from './provider-config';

export const GroupModeSchema = z.enum(['cowork', 'orchestrated', 'current-leads']);
export type GroupMode = z.infer<typeof GroupModeSchema>;
export const AgentConfigurationSchema = z.object({
  provider: ProviderSchema, model: z.string().trim().min(1).max(150), effort: EffortSchema,
  policy: PolicySchema, serviceTier: ServiceTierSchema.default('standard'),
}).strict();
export type AgentConfiguration = z.infer<typeof AgentConfigurationSchema>;
export const GroupDefaultsSchema = z.object({
  orchestrator: AgentConfigurationSchema.optional(), worker: AgentConfigurationSchema.optional(),
  maxParallel: z.number().int().min(1).max(6).default(2), maxTurns: z.number().int().min(2).max(80).default(16),
  maxHops: z.number().int().min(1).max(12).default(6),
}).strict();
export type GroupDefaults = z.infer<typeof GroupDefaultsSchema>;
export const AgentHandleSchema = z.string().trim().toLowerCase().min(2).max(32).regex(/^[a-z][a-z0-9_-]*$/, 'Use letters, numbers, underscores or hyphens; start with a letter');
export const AddGroupAgentSchema = z.object({
  configuration: AgentConfigurationSchema, handle: AgentHandleSchema,
  isolated: z.boolean().default(true),
}).strict();
export type AddGroupAgent = z.infer<typeof AddGroupAgentSchema>;
export const CreateGroupSchema = z.object({
  sessionId: z.string().min(1).max(100), mode: GroupModeSchema, agent: AddGroupAgentSchema,
  orchestrator: AgentConfigurationSchema.optional(),
  currentConfiguration: AgentConfigurationSchema.omit({ provider: true }).optional(),
}).strict();
export type CreateGroup = z.infer<typeof CreateGroupSchema>;
export const UpdateGroupSchema = z.object({
  mode: GroupModeSchema.optional(), orchestratorMemberId: z.string().min(1).max(100).optional(),
  maxParallel: z.number().int().min(1).max(6).optional(), maxTurns: z.number().int().min(2).max(80).optional(),
  maxHops: z.number().int().min(1).max(12).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, 'Supply a group setting to update');
export const SendGroupMessageSchema = z.object({
  content: z.string().trim().min(1).max(100_000), recipients: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
  clientMessageId: z.string().min(1).max(100).optional(),
}).strict();
export type SendGroupMessage = z.infer<typeof SendGroupMessageSchema>;
export interface ConversationGroup {
  id: string; projectId: string; title: string; anchorSessionId: string; mode: GroupMode;
  orchestratorMemberId: string | null; paused: boolean; pauseReason: string | null;
  maxParallel: number; maxTurns: number; maxHops: number; createdAt: string; updatedAt: string;
}
export interface GroupMember {
  id: string; groupId: string; sessionId: string; handle: string; role: 'peer' | 'orchestrator' | 'worker';
  joinedAt: string; removedAt: string | null;
}
export interface GroupMessage {
  id: string; seq: number; groupId: string; senderMemberId: string | null; recipientMemberIds: string[];
  kind: 'user' | 'agent' | 'assignment' | 'status' | 'artifact'; content: string;
  requestId: string | null; replyToId: string | null; sourceMessageId: string | null;
  sourceRunId: string | null; createdAt: string;
}
export interface GroupRequest {
  id: string; groupId: string; messageId: string; plannerMemberId: string;
  status: 'active' | 'completed' | 'paused'; turnsUsed: number; createdAt: string;
}
export interface GroupDelivery {
  id: string; groupId: string; requestId: string; messageId: string; memberId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  runId: string | null; hop: number; error: string | null; createdAt: string; updatedAt: string;
}
export interface GroupAssignment {
  id: string; groupId: string; requestId: string; fromMemberId: string; toMemberId: string;
  taskId: string; deliveryId: string; scope: string[]; createdAt: string;
}
export interface GroupSnapshot {
  group: ConversationGroup; members: GroupMember[]; messages: GroupMessage[];
  requests: GroupRequest[]; deliveries: GroupDelivery[]; assignments: GroupAssignment[];
}
export interface GroupRunContext { groupId: string; memberId: string; requestId: string; deliveryId: string; hop: number; instructions: string }
export interface TeamMcpConnection { url: string; token: string }
export const TeamAssignSchema = z.object({
  recipient: AgentHandleSchema, title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(12000), acceptanceCriteria: z.string().max(4000).default(''),
  scope: z.array(z.string().min(1).max(1000)).min(1).max(40),
  dependsOn: z.array(z.string().min(1).max(100)).max(30).default([]),
  inputArtifacts: z.array(z.object({ taskId: z.string().min(1).max(100), path: z.string().min(1).max(4096) }).strict()).max(30).default([]),
}).strict();
export const TeamMessageSchema = z.object({
  recipient: AgentHandleSchema, content: z.string().trim().min(1).max(12000),
  expectsReply: z.boolean().default(false), replyToId: z.string().min(1).max(100).optional(),
}).strict();
export const TeamArtifactSchema = z.object({
  recipient: AgentHandleSchema, path: z.string().min(1).max(4096), revision: z.string().min(1).max(100),
  note: z.string().max(4000).default(''), taskId: z.string().min(1).max(100).optional(),
}).strict();
export const TeamStatusSchema = z.object({ taskId: z.string().min(1).max(100), status: z.enum(['running','blocked','review']), note: z.string().max(4000).default('') }).strict();

import { z } from 'zod';
import { PolicySchema, ProviderSchema } from './provider-config';

export const RemoteExecutableProviderSchema = z.enum(['claude', 'codex', 'opencode']);
export const RemotePresenceSchema = z.enum(['idle', 'busy', 'offline', 'unknown']);
export const RemoteQuotaStateSchema = z.enum(['available', 'exhausted', 'unknown']);
export const RemoteExecutionStateSchema = z.enum([
  'suggested', 'awaiting-approval', 'approved', 'denied', 'dispatching', 'dispatched', 'completed', 'failed', 'uncertain', 'cancelled', 'expired',
]);

export const RemoteProjectBindingSchema = z.object({
  teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100), localProjectId: z.string().min(1).max(100),
  ownerId: z.string().uuid(), deviceId: z.string().min(1).max(100), createdAt: z.string().datetime({ offset: true }),
}).strict();

export const RemoteAgentSchema = z.object({
  id: z.string().min(1).max(100), teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100),
  deviceId: z.string().min(1).max(100), ownerId: z.string().uuid(), sessionId: z.string().min(1).max(100),
  name: z.string().min(1).max(100), provider: RemoteExecutableProviderSchema, model: z.string().min(1).max(150),
  policy: PolicySchema, configDigest: z.string().regex(/^[a-f0-9]{64}$/), publishedAt: z.string().datetime({ offset: true }),
  presence: RemotePresenceSchema, presenceKnown: z.boolean(), presenceObservedAt: z.string().datetime({ offset: true }).nullable(),
  quotaState: RemoteQuotaStateSchema, quotaKnown: z.boolean(), quotaObservedAt: z.string().datetime({ offset: true }).nullable(),
  quotaReason: z.string().max(300).nullable(), activeGroupId: z.string().max(100).nullable(),
}).strict();

/** Recovery evidence is intentionally a small, non-executable summary. It contains no tool inputs or approvals. */
export const RemoteRecoveryEvidenceSchema = z.object({
  unverifiedAtDestination: z.literal(true), sourceDeviceId: z.string().min(1).max(100), sourceSessionId: z.string().min(1).max(100),
  sourceRunId: z.string().max(100).nullable(), failureKind: z.enum(['quota_exhausted', 'provider_unavailable', 'human_requested_recovery']),
  failureMessage: z.string().max(500).nullable(), checkpointId: z.string().max(100).nullable(),
  objective: z.string().max(1000).nullable(), taskProgress: z.array(z.object({
    id: z.string().max(100), title: z.string().max(200), status: z.enum(['backlog', 'ready', 'running', 'blocked', 'review', 'done']),
    acceptanceCriteria: z.string().max(500),
  }).strict()).max(50),
  worktree: z.object({ branch: z.string().max(200).nullable(), head: z.string().max(100).nullable(),
    dirtyPaths: z.array(z.string().max(300)).max(100), statusKnown: z.boolean() }).strict().nullable(),
  committedReferences: z.array(z.object({ id: z.string().max(100), path: z.string().max(500), revision: z.string().max(100), taskId: z.string().max(100).nullable() }).strict()).max(50),
  notices: z.array(z.string().max(300)).max(20),
}).strict();

export const RemoteExecutionRequestSchema = z.object({
  id: z.string().min(1).max(100), teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100),
  sourceDeviceId: z.string().min(1).max(100), sourceOwnerId: z.string().uuid(), targetDeviceId: z.string().min(1).max(100),
  targetOwnerId: z.string().uuid(), agentId: z.string().min(1).max(100), targetSessionId: z.string().min(1).max(100),
  sourceSessionId: z.string().min(1).max(100), taskId: z.string().min(1).max(100).nullable(),
  task: z.object({ title: z.string().max(200), description: z.string().max(2000), acceptanceCriteria: z.string().max(1000),
    dependsOn: z.array(z.string().max(100)).max(50), groupId: z.string().max(100).nullable() }).strict().nullable(),
  content: z.string().min(1).max(20_000), mode: z.enum(['provider-failure', 'unpublished-recovery']),
  evidence: RemoteRecoveryEvidenceSchema,
  /** Informational estimate only. SessionRuntime has no provider-enforced dollar ceiling. */
  maxSpendUsd: z.number().finite().positive().max(10_000).nullable().optional(),
  /** Allows asking the destination owner to decide with unknown quota; it never implies quota availability. */
  allowUnverifiedTarget: z.boolean().default(false),
  currency: z.literal('USD'), targetConfigDigest: z.string().regex(/^[a-f0-9]{64}$/), digest: z.string().regex(/^[a-f0-9]{64}$/),
  state: RemoteExecutionStateSchema, runId: z.string().max(100).nullable(), createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const RemoteApprovalSchema = z.object({
  id: z.string().min(1).max(100), requestId: z.string().min(1).max(100), teamId: z.string().min(1).max(100),
  ownerId: z.string().uuid(), deviceId: z.string().min(1).max(100), digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approved', 'denied']), allowProviderSpend: z.boolean(), allowUnverifiedQuota: z.boolean(),
  shareProgress: z.boolean(), approvedAt: z.string().datetime({ offset: true }),
  consumedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const RemoteCollaborationMessageSchema = z.object({
  id: z.string().min(1).max(100), teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100),
  deviceId: z.string().min(1).max(100), ownerId: z.string().uuid(), agentId: z.string().max(100).nullable(),
  groupId: z.string().max(100).nullable(), taskId: z.string().max(100).nullable(), dependsOn: z.array(z.string().max(100)).max(50),
  kind: z.enum(['message', 'status', 'progress', 'result', 'task']), content: z.string().max(20_000),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const RemoteCollaborationTaskSchema = z.object({
  id: z.string().min(1).max(100), teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100),
  deviceId: z.string().min(1).max(100), ownerId: z.string().uuid(), agentId: z.string().max(100).nullable(),
  groupId: z.string().max(100).nullable(), title: z.string().min(1).max(200), description: z.string().max(2000),
  acceptanceCriteria: z.string().max(1000), status: z.enum(['backlog', 'ready', 'running', 'blocked', 'review', 'done']),
  dependsOn: z.array(z.string().max(100)).max(50), createdAt: z.string().datetime({ offset: true }),
}).strict();

export const RemoteExecutionEventSchema = z.object({
  id: z.number().int().positive(), teamId: z.string().min(1).max(100), sharedProjectId: z.string().max(100).nullable(),
  ownerId: z.string().uuid(), deviceId: z.string().min(1).max(100), type: z.string().min(1).max(100),
  summary: z.string().max(500), payload: z.record(z.string(), z.unknown()), createdAt: z.string().datetime({ offset: true }),
}).strict();

export const RemoteExecutionSnapshotSchema = z.object({
  bindings: z.array(RemoteProjectBindingSchema), agents: z.array(RemoteAgentSchema),
  requests: z.array(RemoteExecutionRequestSchema), approvals: z.array(RemoteApprovalSchema),
  messages: z.array(RemoteCollaborationMessageSchema), tasks: z.array(RemoteCollaborationTaskSchema),
  events: z.array(RemoteExecutionEventSchema),
}).strict();

export const BindRemoteProjectSchema = z.object({ teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100), localProjectId: z.string().min(1).max(100) }).strict();
export const PublishRemoteAgentsSchema = z.object({ teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100), sessionIds: z.array(z.string().min(1).max(100)).min(1).max(50) }).strict();
/** Refreshes metadata for the already-published local roster without probing provider quota or inference. */
export const RefreshRemoteAgentsSchema = z.object({ teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100) }).strict();
export const SuggestRemoteFallbackSchema = z.object({ teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100), sourceSessionId: z.string().min(1).max(100), taskId: z.string().min(1).max(100) }).strict();
export const RequestRemoteDelegationSchema = z.object({
  teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100), sourceSessionId: z.string().min(1).max(100),
  taskId: z.string().min(1).max(100), agentId: z.string().min(1).max(100), mode: z.enum(['provider-failure', 'unpublished-recovery']),
  content: z.string().trim().min(1).max(20_000), maxSpendUsd: z.number().finite().positive().max(10_000).nullable().optional(),
  allowUnverifiedTarget: z.boolean().default(false), idempotencyKey: z.string().min(1).max(100),
}).strict();
export const DecideRemoteExecutionSchema = z.object({ requestId: z.string().min(1).max(100), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approved', 'denied']), allowProviderSpend: z.boolean(), allowUnverifiedQuota: z.boolean().default(false),
  shareProgress: z.boolean().default(false) }).strict();
export const SendRemoteMessageSchema = z.object({
  teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100), content: z.string().trim().min(1).max(20_000),
  agentId: z.string().min(1).max(100).optional(), groupId: z.string().min(1).max(100).optional(), taskId: z.string().min(1).max(100).optional(),
  dependsOn: z.array(z.string().min(1).max(100)).max(50).default([]), idempotencyKey: z.string().min(1).max(100),
}).strict();
export const PublishRemoteTaskSchema = z.object({
  teamId: z.string().min(1).max(100), sharedProjectId: z.string().min(1).max(100), taskId: z.string().min(1).max(100),
  agentId: z.string().min(1).max(100).optional(), groupId: z.string().min(1).max(100).optional(),
}).strict();

export type RemoteProjectBinding = z.infer<typeof RemoteProjectBindingSchema>;
export type RemoteAgent = z.infer<typeof RemoteAgentSchema>;
export type RemoteRecoveryEvidence = z.infer<typeof RemoteRecoveryEvidenceSchema>;
export type RemoteExecutionRequest = z.infer<typeof RemoteExecutionRequestSchema>;
export type RemoteApproval = z.infer<typeof RemoteApprovalSchema>;
export type RemoteCollaborationMessage = z.infer<typeof RemoteCollaborationMessageSchema>;
export type RemoteCollaborationTask = z.infer<typeof RemoteCollaborationTaskSchema>;
export type RemoteExecutionEvent = z.infer<typeof RemoteExecutionEventSchema>;
export type RemoteExecutionSnapshot = z.infer<typeof RemoteExecutionSnapshotSchema>;
export type RemoteExecutableProvider = z.infer<typeof RemoteExecutableProviderSchema>;
export type RemotePresence = z.infer<typeof RemotePresenceSchema>;
export type RemoteQuotaState = z.infer<typeof RemoteQuotaStateSchema>;
export type RemoteProvider = z.infer<typeof ProviderSchema>;

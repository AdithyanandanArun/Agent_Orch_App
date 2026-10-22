import { z } from 'zod';

const id = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i);
const safeName = z.string().trim().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f\s]/.test(value), 'Name contains control characters or whitespace');

export const DistributedProjectBindingSchema = z.object({
  teamId: id,
  sharedProjectId: id,
  localProjectId: id,
}).strict();
export type DistributedProjectBindingInput = z.infer<typeof DistributedProjectBindingSchema>;

export const GitTransferRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  teamId: id,
  sharedProjectId: id,
  toDeviceId: id,
  expectedHead: gitObjectId,
  /** Optional common ancestor. When omitted the bounded bundle includes all history reachable from expectedHead. */
  baseHead: gitObjectId.optional(),
  branch: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .refine((value) => !value.includes('..') && !value.includes('@{') && !value.endsWith('.lock'), 'Invalid branch label').optional(),
}).strict();
export type GitTransferRequestInput = z.infer<typeof GitTransferRequestSchema>;

export const GitIntegrationRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  teamId: id,
  sharedProjectId: id,
  incomingRequestId: id,
  action: z.enum(['merge', 'push']),
  expectedHead: gitObjectId,
  expectedFingerprint: sha256,
  /** Existing local remote name, required for push and never accepted from a peer. */
  remoteName: safeName.optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'push' && !value.remoteName) context.addIssue({ code: 'custom', path: ['remoteName'], message: 'Select a configured remote for an approved push' });
  if (value.action === 'merge' && value.remoteName) context.addIssue({ code: 'custom', path: ['remoteName'], message: 'A merge does not accept a remote' });
});
export type GitIntegrationRequestInput = z.infer<typeof GitIntegrationRequestSchema>;

export const RemoteCommandOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('git.version') }).strict(),
  z.object({ kind: z.literal('git.status') }).strict(),
  z.object({ kind: z.literal('git.head') }).strict(),
  z.object({ kind: z.literal('git.branch') }).strict(),
  z.object({ kind: z.literal('git.log'), limit: z.number().int().min(1).max(50).default(10) }).strict(),
  z.object({ kind: z.literal('git.showStat'), commit: gitObjectId }).strict(),
  z.object({ kind: z.literal('git.diffStat'), base: gitObjectId, head: gitObjectId }).strict(),
]);
export type RemoteCommandOperation = z.infer<typeof RemoteCommandOperationSchema>;

export const RemoteCommandRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  teamId: id,
  sharedProjectId: id,
  toDeviceId: id,
  operation: RemoteCommandOperationSchema,
  /** Relative directory inside the owner-bound project. Every path component is checked for symlinks. */
  cwd: z.string().max(1024).default('.'),
}).strict();
export type RemoteCommandRequestInput = z.infer<typeof RemoteCommandRequestSchema>;
export const RemoteCommandResultSchema = z.object({
  requestId: id, status: z.enum(['completed', 'failed', 'denied', 'unknown']),
  exitCode: z.number().int().nullable(), output: z.string().max(64 * 1024), outputTruncated: z.boolean(), error: z.string().max(1000).nullable(),
}).strict();

export const DistributedDecisionSchema = z.object({ decision: z.enum(['approved', 'denied']) }).strict();
export type DistributedDecision = z.infer<typeof DistributedDecisionSchema>;
export const DistributedRequestDecisionSchema = DistributedDecisionSchema.extend({ requestId: id, expectedDigest: sha256 }).strict();
export type DistributedRequestDecision = z.infer<typeof DistributedRequestDecisionSchema>;

export const GitTransferOfferSchema = z.object({
  requestId: id, sharedProjectId: id, sourceHead: gitObjectId, baseHead: gitObjectId.nullable(), branch: z.string().max(120).nullable(),
  bundleSha256: sha256, bundleSizeBytes: z.number().int().positive().max(16 * 1024 * 1024), chunkCount: z.number().int().positive().max(64),
}).strict();
export type GitTransferOffer = z.infer<typeof GitTransferOfferSchema>;
export const GitBundleChunkSchema = z.object({
  requestId: id, index: z.number().int().min(0).max(63), chunkCount: z.number().int().positive().max(64), data: z.string().min(1).max(350_000),
}).strict();
export const GitTransferResultSchema = z.object({
  requestId: id, status: z.enum(['imported', 'conflict', 'stale', 'failed']), conflictPaths: z.array(z.string().max(4096)).max(500).default([]),
  message: z.string().max(1000).optional(),
}).strict();
export const GitIntegrationResultSchema = z.object({
  requestId: id, status: z.enum(['completed', 'failed', 'unknown']), head: gitObjectId.nullable(), message: z.string().max(1000).optional(),
}).strict();

export const DistributedDeviceEnvelopeSchema = z.object({
  id,
  teamId: id,
  fromDeviceId: id,
  toDeviceId: id,
  kind: z.string().min(1).max(80),
  payload: z.unknown(),
}).strict();
export type DistributedDeviceEnvelope = z.infer<typeof DistributedDeviceEnvelopeSchema>;

export type GitRequestStatus =
  | 'awaiting-source-approval' | 'awaiting-destination-approval' | 'awaiting-bundle'
  | 'receiving' | 'importing' | 'imported' | 'conflict' | 'stale' | 'denied'
  | 'approved' | 'dispatched' | 'completed' | 'failed' | 'unknown';
export interface GitRequestSnapshot {
  id: string; teamId: string; sharedProjectId: string; direction: 'incoming' | 'outgoing' | 'local';
  peerDeviceId: string; kind: 'transfer' | 'integration'; status: GitRequestStatus;
  sourceHead?: string; baseHead?: string | null; branch?: string | null;
  requestDigest: string;
  bundleSha256?: string; bundleSizeBytes?: number; expectedHead?: string | null;
  expectedFingerprint?: string; action?: 'merge' | 'push'; remoteName?: string;
  conflictPaths?: string[]; notices: string[]; createdAt: string; updatedAt: string;
}
export interface GitAuditEntry {
  id: string; requestId: string | null; action: string; actorDeviceId: string | null;
  digest: string | null; details: Record<string, unknown>; createdAt: string;
}
export interface GitSyncSnapshot {
  bindings: Array<{ teamId: string; sharedProjectId: string; localProjectId: string; canonicalPath: string; ownerId: string; updatedAt: string }>;
  requests: GitRequestSnapshot[];
  audit: GitAuditEntry[];
}

export type RemoteCommandStatus = 'awaiting-approval' | 'approved' | 'dispatched' | 'completed' | 'failed' | 'denied' | 'unknown';
export interface RemoteCommandSnapshot {
  id: string; teamId: string; sharedProjectId: string; direction: 'incoming' | 'outgoing';
  peerDeviceId: string; status: RemoteCommandStatus; operation: RemoteCommandOperation;
  cwd: string; expectedHead: string | null; expectedFingerprint: string | null;
  requestDigest: string;
  exitCode: number | null; output: string | null; outputTruncated: boolean;
  error: string | null; createdAt: string; updatedAt: string;
}
export interface CommandAuditEntry extends GitAuditEntry {}
export interface RemoteCommandServiceSnapshot {
  bindings: GitSyncSnapshot['bindings'];
  requests: RemoteCommandSnapshot[];
  audit: CommandAuditEntry[];
}

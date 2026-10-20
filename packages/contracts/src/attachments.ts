import { z } from 'zod';

const MiB = 1024 * 1024;

/** Bounds applied by the upload endpoint, the send routes and the provider adapters. Provider-specific caps only ever lower these. */
export const ATTACHMENT_LIMITS = {
  imageBytes: 10 * MiB,
  fileBytes: 25 * MiB,
  filesPerMessage: 10,
  totalBytes: 50 * MiB,
  nameChars: 180,
  /** Largest image Claude's Messages API accepts as an inline base64 block. */
  claudeImageBytes: 5 * MiB,
} as const;

/** Raster formats that are validated by signature and may be previewed inline. SVG, HTML and every other type are downloads only. */
export const RASTER_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type RasterImageType = (typeof RASTER_IMAGE_TYPES)[number];

export type AttachmentKind = 'image' | 'file';

/** Metadata only. Bytes, storage names and filesystem paths never leave the server. */
export interface AttachmentRef {
  id: string; name: string; mimeType: string; size: number; kind: AttachmentKind; createdAt: string;
}

export const AttachmentIdSchema = z.string().regex(/^att_[a-f0-9]{32}$/);
export const AttachmentIdsSchema = z.array(AttachmentIdSchema).max(ATTACHMENT_LIMITS.filesPerMessage);

/** A client-selected native action. Only identities are accepted: the server resolves every path and name from a fresh provider catalog. */
export const NativeInvocationInputSchema = z.object({
  kind: z.enum(['command', 'skill']),
  /** Catalog identity (`ProviderCommand.id` / `ProviderSkill.id`); never treated as a trusted client-supplied path. */
  id: z.string().min(1).max(4096),
  name: z.string().min(1).max(150).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  arguments: z.string().max(20_000).default(''),
  /** Member id or handle the action is addressed to. */
  recipient: z.string().min(1).max(100),
}).strict();
export type NativeInvocationInput = z.infer<typeof NativeInvocationInputSchema>;

/** The validated, durable form stored with a group request. */
export interface GroupInvocation {
  kind: 'command' | 'skill'; id: string; name: string; arguments: string;
  memberId: string; sessionId: string; provider: string; model: string;
}

/** What a provider adapter receives for one explicit native invocation. Paths come from the provider's own fresh catalog. */
export interface NativeInvocation {
  kind: 'command' | 'skill'; name: string; arguments: string;
  /** Present for skills: the catalog entry the host resolved (Codex needs its path). */
  skill?: import('./index').ProviderSkill;
}

/** One attachment staged for a single run. The path is private to that run and removed when it ends. */
export interface RunAttachment {
  id: string; name: string; mimeType: string; size: number; kind: AttachmentKind; path: string;
}

/** What each provider can take natively, shown to users before they send. */
export interface AttachmentCapabilities {
  images: boolean; files: boolean; imageBytes: number; note?: string;
}

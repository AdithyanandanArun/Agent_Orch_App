import { z } from 'zod';

export const MESSAGE_CONTEXT_LIMITS = {
  references: 10,
  files: 8,
  quotes: 4,
  quoteChars: 2_000,
  fileChars: 24_000,
  totalChars: 64_000,
} as const;

export const FileContextRefSchema = z.object({
  kind: z.literal('file'),
  path: z.string().trim().min(1).max(4096),
  sourceSessionId: z.string().min(1).max(200),
}).strict();

export const QuoteCitationSchema = z.object({
  kind: z.literal('quote'),
  sourceMessageId: z.string().min(1).max(200),
  sourceSessionId: z.string().min(1).max(200),
  sourceGroupId: z.string().min(1).max(200).optional(),
  excerpt: z.string().trim().min(1).max(MESSAGE_CONTEXT_LIMITS.quoteChars),
}).strict();

export const MessageContextRefSchema = z.discriminatedUnion('kind', [FileContextRefSchema, QuoteCitationSchema]);
export const MessageContextRefsSchema = z.array(MessageContextRefSchema).max(MESSAGE_CONTEXT_LIMITS.references).superRefine((refs, ctx) => {
  const files = refs.filter((ref) => ref.kind === 'file');
  const quotes = refs.filter((ref) => ref.kind === 'quote');
  if (files.length > MESSAGE_CONTEXT_LIMITS.files) ctx.addIssue({ code: 'custom', message: `A message can include at most ${MESSAGE_CONTEXT_LIMITS.files} file references.` });
  if (quotes.length > MESSAGE_CONTEXT_LIMITS.quotes) ctx.addIssue({ code: 'custom', message: `A message can include at most ${MESSAGE_CONTEXT_LIMITS.quotes} quoted references.` });
});

export type FileContextRef = z.infer<typeof FileContextRefSchema>;
export type QuoteCitation = z.infer<typeof QuoteCitationSchema>;
export type MessageContextRef = z.infer<typeof MessageContextRefSchema>;

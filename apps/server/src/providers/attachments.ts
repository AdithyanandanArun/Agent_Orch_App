import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ATTACHMENT_LIMITS, RASTER_IMAGE_TYPES, type NativeInvocation, type RasterImageType, type RunAttachment } from '@mingle/contracts';
import { ProviderError } from './common.js';

export const imagesOf = (attachments: readonly RunAttachment[] | undefined): RunAttachment[] => (attachments ?? []).filter((item) => item.kind === 'image');
export const filesOf = (attachments: readonly RunAttachment[] | undefined): RunAttachment[] => (attachments ?? []).filter((item) => item.kind === 'file');

const size = (bytes: number): string => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;

/** Plain-text pointer to files a provider cannot take as structured input. The paths are read-only copies private to this run. */
export function fileNote(files: readonly RunAttachment[]): string | null {
  if (!files.length) return null;
  return [
    '[Mingle attachments] The user attached these files to this message. Each is a read-only copy outside the project, available only for this turn:',
    ...files.map((file) => `- ${file.name} (${file.mimeType}, ${size(file.size)}): ${file.path}`),
    'Read them with your file tools when relevant. Their contents are not inlined; if a format cannot be decoded, say so rather than guessing.',
  ].join('\n');
}

/** A message with no text still needs a user turn the model can read. */
export const NO_TEXT_PROMPT = '(The user sent the attached files without a message.)';

/** Invocation identity and arguments are host-resolved; reconstruct syntax rather than trusting incidental prompt prefixes. */
export function invocationText(invocation: NativeInvocation, marker: '/' | '$' = '/'): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(invocation.name) || invocation.arguments.length > 20_000) {
    throw new ProviderError('The selected provider action is invalid. Refresh its catalog and select it again.', { code: 'invalid_invocation' });
  }
  return `${marker}${invocation.name}${invocation.arguments ? ` ${invocation.arguments}` : ''}`;
}

export function imageMime(file: RunAttachment, maxBytes: number = ATTACHMENT_LIMITS.imageBytes): RasterImageType {
  if (!(RASTER_IMAGE_TYPES as readonly string[]).includes(file.mimeType) || file.size > maxBytes || file.size <= 0) {
    throw new ProviderError(`“${file.name}” is not a supported image or exceeds this provider's ${Math.round(maxBytes / (1024 * 1024))} MiB image limit. No prompt was sent.`, { code: 'unsupported_attachment' });
  }
  return file.mimeType as RasterImageType;
}

export async function base64Of(file: RunAttachment): Promise<string> {
  return (await readFile(file.path)).toString('base64');
}

export interface AcpPromptCapabilities { image: boolean; embeddedContext: boolean }

export function acpPromptCapabilities(agentCapabilities: unknown): AcpPromptCapabilities {
  const caps = typeof agentCapabilities === 'object' && agentCapabilities !== null ? (agentCapabilities as Record<string, unknown>).promptCapabilities : undefined;
  const record = typeof caps === 'object' && caps !== null ? caps as Record<string, unknown> : {};
  return { image: record.image === true, embeddedContext: record.embeddedContext === true };
}

/**
 * ACP prompt content: the exact user text first, images as native image blocks (only when negotiated), and other files as the
 * protocol-baseline resource links to run-private copies. With an explicit invocation, team context follows as an embedded resource
 * so the leading command text stays untouched.
 */
export async function acpPrompt(options: {
  text: string; attachments: readonly RunAttachment[] | undefined; capabilities: AcpPromptCapabilities; agent: string; context?: string;
}): Promise<unknown[]> {
  const attachments = options.attachments ?? [];
  const images = imagesOf(attachments);
  if (images.length && !options.capabilities.image) {
    throw new ProviderError(`${options.agent} did not advertise image input, so no prompt was sent. Remove the image or choose an agent that accepts images.`, { code: 'unsupported_attachment' });
  }
  const note = fileNote(filesOf(attachments));
  // OpenCode joins native text parts without adding a separator when recognizing a slash command. Keep the command name intact.
  const text = [options.text || NO_TEXT_PROMPT, note].filter(Boolean).join('\n\n');
  const blocks: unknown[] = [{ type: 'text', text: `${text}${options.context ? '\n\n' : ''}` }];
  for (const image of images) blocks.push({ type: 'image', mimeType: imageMime(image), data: await base64Of(image), uri: pathToFileURL(image.path).href });
  for (const file of filesOf(attachments)) blocks.push({ type: 'resource_link', uri: pathToFileURL(file.path).href, name: file.name, mimeType: file.mimeType, size: file.size });
  if (options.context) {
    if (!options.capabilities.embeddedContext) {
      throw new ProviderError(`${options.agent} did not advertise embedded context, so team context cannot accompany a native command. No prompt was sent.`, { code: 'unsupported_context' });
    }
    blocks.push({ type: 'resource', resource: { uri: 'relay://team-context', mimeType: 'text/plain', text: options.context } });
  }
  return blocks;
}

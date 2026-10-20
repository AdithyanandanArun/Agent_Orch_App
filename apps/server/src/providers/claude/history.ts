import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  type SDKSessionInfo,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AppSettings,
  ConversationListOptions,
  ExternalConversation,
  ExternalConversationDetails,
  ExternalConversationList,
  ExternalConversationMessage,
} from '@mingle/contracts';
import { ConversationIdSchema } from '@mingle/contracts';
import { isRecord, redactSecrets, truncate } from '../common.js';

const PAGE_SIZE = 50;
const MAX_OFFSET = 1_000_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGES = 200;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 20 * 1024;

function validDirectory(directory: unknown): string | undefined {
  if (directory === undefined) return undefined;
  if (typeof directory !== 'string' || directory.length === 0 || directory.length > 4096 || directory.includes('\0')) {
    throw new Error('Claude history directory is invalid');
  }
  return directory;
}

function parseOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9]\d{0,6})$/.test(cursor)) throw new Error('Claude history cursor is invalid');
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset > MAX_OFFSET) throw new Error('Claude history cursor is out of range');
  return offset;
}

function isoTime(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function publicLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? truncate(redactSecrets(value.trim()), 300)
    : fallback;
}

function toConversation(info: SDKSessionInfo): ExternalConversation {
  const title = info.customTitle?.trim() || info.summary?.trim() || info.firstPrompt?.trim() || 'Claude conversation';
  return {
    provider: 'claude',
    id: info.sessionId,
    title: publicLabel(title, 'Claude conversation'),
    // Preserve the native cwd exactly: callers use this value to reopen the original workspace.
    directory: typeof info.cwd === 'string' ? info.cwd : null,
    updatedAt: isoTime(info.lastModified),
    createdAt: isoTime(info.createdAt),
    // Session metadata does not report a model. Details may fill this from a real assistant message.
    model: null,
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(redactSecrets(message), 300);
}

/** List native Claude Code sessions without starting an agent turn. */
export async function listClaudeConversations(
  _settings: AppSettings,
  options: ConversationListOptions,
): Promise<ExternalConversationList> {
  let directory: string | undefined;
  let offset: number;
  try {
    directory = validDirectory(options.directory);
    offset = parseOffset(options.cursor);
  } catch (error) {
    return { conversations: [], nextCursor: null, notices: [`Claude history request was rejected: ${safeError(error)}`] };
  }

  try {
    const rows = await listSessions({
      ...(directory ? { dir: directory } : {}),
      limit: PAGE_SIZE,
      offset,
      includeProgrammatic: false,
    });
    const conversations = rows.slice(0, PAGE_SIZE).map(toConversation);
    return {
      conversations,
      nextCursor: rows.length >= PAGE_SIZE && offset + PAGE_SIZE <= MAX_OFFSET ? String(offset + PAGE_SIZE) : null,
      notices: [],
    };
  } catch (error) {
    return {
      conversations: [],
      nextCursor: null,
      notices: [`Claude conversation history is unavailable: ${safeError(error)}`],
    };
  }
}

function extractPublicText(message: SessionMessage): { content: string; model: string | null; createdAt: string | null } | null {
  if (message.type !== 'user' && message.type !== 'assistant') return null;
  const raw = message.message;
  if (!isRecord(raw)) return null;
  const blocks = raw.content;
  let content = '';
  if (typeof blocks === 'string') {
    content = blocks;
  } else if (Array.isArray(blocks)) {
    content = blocks
      .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => (block as Record<string, unknown>).text as string)
      .join('');
  }
  if (!content.trim()) return null;
  const model = message.type === 'assistant' && typeof raw.model === 'string' && raw.model.trim()
    ? truncate(redactSecrets(raw.model.trim()), 150)
    : null;
  const createdAt = isoTime((message as unknown as Record<string, unknown>).timestamp);
  return { content, model, createdAt };
}

function fitUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false, bytes: Buffer.byteLength(text, 'utf8') };
  let result = '';
  let bytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return { text: result, truncated: true, bytes };
}

function metadataOnly(conversation: ExternalConversation, notice: string): ExternalConversationDetails {
  return { conversation, messages: [], truncated: true, notices: [notice] };
}

/** Read a bounded public-text view of a Claude transcript. */
export async function readClaudeConversation(
  _settings: AppSettings,
  id: string,
): Promise<ExternalConversationDetails> {
  const parsedId = ConversationIdSchema.safeParse(id);
  if (!parsedId.success) throw new Error('Claude conversation id is invalid');

  let info: SDKSessionInfo | undefined;
  try {
    info = await getSessionInfo(parsedId.data);
  } catch (error) {
    throw new Error(`Claude conversation metadata could not be read: ${safeError(error)}`);
  }
  if (!info) throw new Error('Claude conversation was not found');

  const conversation = toConversation(info);
  if (typeof info.fileSize !== 'number' || !Number.isFinite(info.fileSize) || info.fileSize < 0) {
    return metadataOnly(conversation, 'Transcript size could not be verified, so message content was not loaded.');
  }
  if (info.fileSize > MAX_FILE_BYTES) {
    return metadataOnly(conversation, 'Transcript exceeds the 16 MiB read limit; only session metadata is available.');
  }

  let nativeMessages: SessionMessage[];
  try {
    // The file-size gate above bounds the SDK's native full transcript parse. Slice afterward to preserve the
    // most recent messages because the SDK's offset/limit selection is chronological from the beginning.
    nativeMessages = await getSessionMessages(parsedId.data);
  } catch (error) {
    return metadataOnly(conversation, `Transcript messages could not be read: ${safeError(error)}`);
  }

  const eligible = nativeMessages.flatMap((message) => {
    const extracted = extractPublicText(message);
    if (!extracted) return [];
    return [{ role: message.type as 'user' | 'assistant', ...extracted }];
  });
  let usedBytes = 0;
  let truncated = eligible.length > MAX_MESSAGES;
  const newestFirst: ExternalConversationMessage[] = [];
  for (let index = eligible.length - 1; index >= Math.max(0, eligible.length - MAX_MESSAGES); index -= 1) {
    const item = eligible[index];
    const redacted = redactSecrets(item.content);
    const remaining = MAX_TOTAL_BYTES - usedBytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const fitted = fitUtf8(redacted, Math.min(MAX_MESSAGE_BYTES, remaining));
    if (fitted.truncated) truncated = true;
    if (!fitted.text.trim()) {
      truncated = true;
      break;
    }
    newestFirst.push({ role: item.role, content: fitted.text, createdAt: item.createdAt });
    usedBytes += fitted.bytes;
    if (fitted.truncated) truncated = true;
  }
  const messages = newestFirst.reverse();

  const model = [...eligible].reverse().find((message) => message.role === 'assistant' && message.model)?.model ?? null;
  conversation.model = model;
  return {
    conversation,
    messages,
    truncated,
    notices: truncated ? ['Transcript preview is truncated to the 200 most recent public text messages, 20 KiB per message, and 2 MiB total.'] : [],
  };
}

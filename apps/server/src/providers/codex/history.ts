import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type {
  AppSettings, ConversationListOptions, ExternalConversation, ExternalConversationDetails,
  ExternalConversationList, ExternalConversationMessage,
} from '@relay/contracts';
import { ProviderError, TextTail, isRecord, redactSecrets, truncate } from '../common.js';
import { resolveExecutableCached } from '../discovery.js';
import { shutdownChild, type ChildLike } from '../process.js';
import { JsonRpcConnection, RpcError } from './rpc.js';

const INITIALIZE_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 500;
const MAX_PAGE_SIZE = 50;
const MAX_CURSOR_CHARS = 2_048;
const MAX_MESSAGES = 200;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100;
const CLIENT_INFO = { name: 'relay', title: 'Relay', version: '0.1.0' };

interface RpcRuntime {
  conn: JsonRpcConnection;
  child: ChildLike;
  stderr: TextTail;
}

function safeString(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return truncate(redactSecrets(value.trim()), max);
}

function dateFromSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 8.64e12) return null;
  try { return new Date(value * 1000).toISOString(); } catch { return null; }
}

function dateFromMilliseconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 8.64e15) return null;
  try { return new Date(value).toISOString(); } catch { return null; }
}

function mapThread(value: unknown): ExternalConversation | null {
  if (!isRecord(value)) return null;
  const id = safeString(value.id, 200);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) return null;
  const name = safeString(value.name, 500);
  const preview = safeString(value.preview, 500);
  return {
    provider: 'codex', id,
    title: name ?? preview ?? 'Codex conversation',
    directory: safeString(value.cwd, 4_096),
    updatedAt: dateFromSeconds(value.updatedAt) ?? dateFromSeconds(value.recencyAt),
    createdAt: dateFromSeconds(value.createdAt),
    model: safeString(value.model, 150),
  };
}

function validCursor(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CURSOR_CHARS ? value : null;
}

function resultData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProviderError('Codex returned an invalid history response.', { code: 'protocol_error' });
  return value;
}

function safeRpcError(error: unknown): Error {
  if (error instanceof RpcError) {
    const message = truncate(redactSecrets(error.message), 300);
    return new ProviderError(`Codex history request failed: ${message}`, { code: 'history_request_failed', cause: error });
  }
  if (error instanceof Error) return new ProviderError(truncate(redactSecrets(error.message), 500), { code: 'history_failed', cause: error });
  return new ProviderError('Codex history could not be read.', { code: 'history_failed' });
}

async function start(settings: AppSettings): Promise<RpcRuntime> {
  let resolved: Awaited<ReturnType<typeof resolveExecutableCached>>;
  try {
    resolved = await resolveExecutableCached({ name: 'codex', override: settings.codexExecutable });
  } catch (error) {
    throw new ProviderError(`Codex history is unavailable: ${truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 300)}`, { code: 'executable_unavailable', cause: error });
  }
  if (!resolved.ok) throw new ProviderError(`Codex history is unavailable: ${truncate(redactSecrets(resolved.reason), 300)}`, { code: 'executable_unavailable' });

  let child: ChildLike;
  try {
    child = spawn(resolved.executable.path, ['app-server'], {
      cwd: tmpdir(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    }) as unknown as ChildLike;
  } catch (error) {
    throw new ProviderError(`Codex app-server could not be started: ${truncate(redactSecrets(error instanceof Error ? error.message : String(error)), 300)}`, { code: 'process_start_failed', cause: error });
  }
  const stderr = new TextTail();
  child.stderr?.on('data', (chunk: string | Buffer) => stderr.push(chunk.toString()));
  const conn = new JsonRpcConnection(child, {
    onNotification: () => undefined,
    onRequest: async () => { throw new RpcError(-32601, 'History client does not accept server requests.'); },
    formatClose: (info) => {
      const how = info.error ? `could not be started (${info.error.message})` : `exited unexpectedly with code ${info.exitCode}`;
      const detail = stderr.summary(700);
      return `Codex app-server ${how}.${detail ? ` stderr: ${detail}` : ''}`;
    },
  });
  try {
    await conn.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: false, optOutNotificationMethods: ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta'] },
    }, INITIALIZE_TIMEOUT_MS);
    conn.notify('initialized', {});
  } catch (error) {
    await shutdownChild(child, { closed: conn.closed, group: process.platform !== 'win32', graceMs: 0, termMs: 500, killMs: 500 });
    throw safeRpcError(error);
  }
  return { conn, child, stderr };
}

async function close(runtime: RpcRuntime): Promise<void> {
  const outcome = await shutdownChild(runtime.child, {
    closed: runtime.conn.closed, group: process.platform !== 'win32',
    graceMs: SHUTDOWN_GRACE_MS, termMs: 1_000, killMs: 1_000,
  });
  if (outcome === 'unresponsive') throw new ProviderError('Codex app-server did not stop after the history request.', { code: 'process_cleanup_failed' });
}

/** Lists native Codex CLI and VS Code threads without starting or resuming a turn. */
export async function listCodexConversations(
  settings: AppSettings,
  options: ConversationListOptions,
): Promise<ExternalConversationList> {
  const cursor = options.cursor === undefined ? null : validCursor(options.cursor);
  if (options.cursor !== undefined && cursor === null) throw new ProviderError('Codex history cursor is invalid or too large.', { code: 'invalid_cursor' });
  const directory = options.directory;
  if (directory !== undefined && (typeof directory !== 'string' || !directory.trim() || directory.length > 4_096)) {
    throw new ProviderError('Codex history directory is invalid.', { code: 'invalid_directory' });
  }

  const runtime = await start(settings);
  let failure: unknown;
  let result: ExternalConversationList | undefined;
  try {
    const response = resultData(await runtime.conn.request('thread/list', {
      ...(cursor ? { cursor } : {}), ...(directory ? { cwd: directory } : {}),
      limit: MAX_PAGE_SIZE, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['cli', 'vscode'],
    }, REQUEST_TIMEOUT_MS));
    const rows = Array.isArray(response.data) ? response.data : [];
    const conversations = rows.slice(0, MAX_PAGE_SIZE).flatMap((row) => {
      const conversation = mapThread(row);
      return conversation ? [conversation] : [];
    });
    const nextCursor = validCursor(response.nextCursor);
    result = {
      conversations, nextCursor,
      notices: rows.length > MAX_PAGE_SIZE || (response.nextCursor !== null && response.nextCursor !== undefined && !nextCursor)
        ? ['Codex returned an invalid or oversized history page cursor; more conversations may be available.'] : [],
    };
  } catch (error) {
    failure = safeRpcError(error);
  } finally {
    try { await close(runtime); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  return result!;
}

function itemText(item: Record<string, unknown>): { role: 'user' | 'assistant'; content: string } | null {
  if (item.type === 'agentMessage' && typeof item.text === 'string') return { role: 'assistant', content: item.text };
  if (item.type !== 'userMessage' || !Array.isArray(item.content)) return null;
  const parts = item.content.flatMap((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []);
  return parts.length ? { role: 'user', content: parts.join('') } : null;
}

/** Reads bounded public user/assistant text from a native thread using the app-server item pager. */
export async function readCodexConversation(settings: AppSettings, id: string): Promise<ExternalConversationDetails> {
  if (typeof id !== 'string' || id.length < 1 || id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) {
    throw new ProviderError('Codex conversation id is invalid.', { code: 'invalid_conversation_id' });
  }
  const runtime = await start(settings);
  let failure: unknown;
  let result: ExternalConversationDetails | undefined;
  try {
    const read = resultData(await runtime.conn.request('thread/read', { threadId: id, includeTurns: false }, REQUEST_TIMEOUT_MS));
    const conversation = mapThread(read.thread);
    if (!conversation || conversation.id !== id) throw new ProviderError('Codex did not return the requested conversation.', { code: 'conversation_unavailable' });

    const messages: ExternalConversationMessage[] = [];
    let bytes = 0;
    let cursor: unknown = null;
    let truncated = false;
    let pages = 0;
    while (pages < MAX_PAGES) {
      const page = resultData(await runtime.conn.request('thread/items/list', {
        threadId: id, ...(cursor ? { cursor } : {}), limit: MAX_PAGE_SIZE, sortDirection: 'asc',
      }, REQUEST_TIMEOUT_MS));
      pages += 1;
      const rows = Array.isArray(page.data) ? page.data : [];
      for (const row of rows) {
        if (!isRecord(row) || !isRecord(row.item)) continue;
        const text = itemText(row.item);
        if (!text) continue;
        const content = redactSecrets(text.content);
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (messages.length >= MAX_MESSAGES || bytes + contentBytes > MAX_TEXT_BYTES) {
          truncated = true;
          break;
        }
        bytes += contentBytes;
        messages.push({ role: text.role, content, createdAt: dateFromMilliseconds(row.startedAtMs) ?? dateFromMilliseconds(row.completedAtMs) });
      }
      if (truncated) break;
      const next = validCursor(page.nextCursor);
      if (page.nextCursor !== null && page.nextCursor !== undefined && !next) {
        truncated = true;
        break;
      }
      if (!next) break;
      if (next === cursor) { truncated = true; break; }
      cursor = next;
    }
    if (pages >= MAX_PAGES && cursor) truncated = true;
    result = { conversation, messages, truncated, notices: truncated ? ['Conversation history was clipped at Relay’s import limits.'] : [] };
  } catch (error) {
    failure = safeRpcError(error);
  } finally {
    try { await close(runtime); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  return result!;
}

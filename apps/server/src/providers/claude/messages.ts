import type { AdapterEvent, Policy } from '@relay/contracts';
import { ProviderError, describeValue, isRecord, truncate } from '../common.js';

export type ClaudePermissionMode = 'default' | 'acceptEdits';

/** supervised: ask for everything except read-only tools. balanced: edits inside the worktree are pre-approved, the rest still asks. */
export function claudePermissionMode(policy: Policy): ClaudePermissionMode {
  return policy === 'balanced' ? 'acceptEdits' : 'default';
}

export const CLAUDE_MODELS: { id: string; name: string }[] = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
];

export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5-5';

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

/** Copy of a tool input that is safe to show or store: long strings are shortened. */
export function previewInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === 'string' ? truncate(value, 4_000) : isRecord(value) || Array.isArray(value) ? truncate(JSON.stringify(value), 4_000) : value;
  }
  return out;
}

export function describeToolUse(toolName: string, input: Record<string, unknown>, sdkTitle?: string): string {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  let text: string;
  switch (toolName) {
    case 'Bash': text = `Run command: ${str(input.command) ?? describeValue(input, 300)}`; break;
    case 'Write': text = `Write file ${path ?? '(unknown path)'}`; break;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': text = `Edit file ${path ?? '(unknown path)'}`; break;
    case 'WebFetch': text = `Fetch ${str(input.url) ?? 'a URL'}`; break;
    case 'WebSearch': text = `Search the web for "${str(input.query) ?? ''}"`; break;
    default: text = sdkTitle ?? `Use tool ${toolName}: ${describeValue(input, 300)}`;
  }
  return truncate(text, 900);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : isRecord(part) ? `[${String(part.type ?? 'content')}]` : String(part))).join('\n');
  }
  return describeValue(content, 800);
}

export interface ClaudeStreamResult { sessionId: string | null; finished: boolean }

/**
 * Turns Agent SDK messages into host events.
 * Text comes from partial stream events; the complete assistant message supplies tool calls and only
 * contributes text when the same message was not streamed (so nothing is shown twice).
 */
export class ClaudeMessageMapper {
  private sessionId: string | null = null;
  private currentMessageId: string | null = null;
  private readonly streamedMessages = new Set<string>();
  private readonly toolNames = new Map<string, string>();
  private emittedText = false;
  private textBlockOpen = false;
  private lastAssistantError: string | null = null;
  finished = false;

  constructor(private readonly requestedModel: string, private readonly emit: (event: AdapterEvent) => void) {}

  get providerSessionId(): string | null { return this.sessionId; }

  private noteSession(id: unknown): void {
    if (typeof id === 'string' && id && id !== this.sessionId) {
      this.sessionId = id;
      this.emit({ type: 'session', providerSessionId: id });
    }
  }

  private text(delta: string): void {
    if (!delta) return;
    const separator = this.emittedText && !this.textBlockOpen ? '\n\n' : '';
    this.textBlockOpen = true;
    this.emittedText = true;
    this.emit({ type: 'text', text: separator + delta });
  }

  /** Processes one SDK message. Throws ProviderError for failures that must end the run. */
  handle(message: unknown): void {
    if (!isRecord(message) || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'system': return this.system(message);
      case 'stream_event': return this.streamEvent(message);
      case 'assistant': return this.assistant(message);
      case 'user': return this.user(message);
      case 'result': return this.result(message);
      default: return; // task, hook, status and other bookkeeping messages are not surfaced
    }
  }

  private system(message: Record<string, unknown>): void {
    switch (message.subtype) {
      case 'init': {
        this.noteSession(message.session_id);
        const model = str(message.model);
        if (model && model !== this.requestedModel && !model.startsWith(this.requestedModel) && !this.requestedModel.startsWith(model)) {
          this.emit({ type: 'info', content: `Claude is running model ${model} although ${this.requestedModel} was requested.` });
        }
        return;
      }
      case 'api_retry':
        this.emit({ type: 'info', content: `Claude API request failed (${String(message.error ?? 'error')}${message.error_status ? ` HTTP ${String(message.error_status)}` : ''}); retry ${String(message.attempt)} of ${String(message.max_retries)}.` });
        return;
      case 'model_refusal_fallback':
        throw new ProviderError(`Claude retried on a fallback model (${String(message.original_model)} → ${String(message.fallback_model)}). Relay does not allow automatic model substitution, so the run was stopped.`, { code: 'model_substitution' });
      case 'model_refusal_no_fallback':
        this.emit({ type: 'info', content: truncate(str(message.content) ?? `${String(message.original_model)} declined to respond.`, 600) });
        return;
      default:
        return;
    }
  }

  private streamEvent(message: Record<string, unknown>): void {
    this.noteSession(message.session_id);
    if (message.parent_tool_use_id) return; // subagent output is represented by its tool calls
    const event = isRecord(message.event) ? message.event : null;
    if (!event) return;
    switch (event.type) {
      case 'message_start': {
        const inner = isRecord(event.message) ? event.message : null;
        this.currentMessageId = inner ? str(inner.id) ?? null : null;
        return;
      }
      case 'content_block_start': {
        const block = isRecord(event.content_block) ? event.content_block : null;
        if (block?.type === 'text') this.textBlockOpen = false;
        return;
      }
      case 'content_block_delta': {
        const delta = isRecord(event.delta) ? event.delta : null;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          if (this.currentMessageId) this.streamedMessages.add(this.currentMessageId);
          this.text(delta.text);
        }
        return;
      }
      default:
        return;
    }
  }

  private assistant(message: Record<string, unknown>): void {
    this.noteSession(message.session_id);
    const inner = isRecord(message.message) ? message.message : null;
    if (!inner || !Array.isArray(inner.content)) return;
    const subagent = Boolean(message.parent_tool_use_id);
    if (typeof message.error === 'string') {
      this.lastAssistantError = message.error;
      return; // synthetic API-error text is reported through the result message instead
    }
    const id = str(inner.id);
    const streamed = id !== undefined && this.streamedMessages.has(id);
    for (const block of inner.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && !streamed && !subagent) {
        this.textBlockOpen = false;
        this.text(block.text);
      } else if (block.type === 'tool_use') {
        const name = str(block.name) ?? 'tool';
        if (typeof block.id === 'string') this.toolNames.set(block.id, name);
        const input = isRecord(block.input) ? block.input : {};
        this.emit({ type: 'tool', name: subagent ? `subagent:${name}` : name, content: describeToolUse(name, input) });
      }
    }
  }

  private user(message: Record<string, unknown>): void {
    if (message.isReplay === true) return;
    const inner = isRecord(message.message) ? message.message : null;
    if (!inner || !Array.isArray(inner.content)) return;
    for (const block of inner.content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const name = (typeof block.tool_use_id === 'string' ? this.toolNames.get(block.tool_use_id) : undefined) ?? 'tool';
      const body = truncate(toolResultText(block.content).trim(), 2_000);
      this.emit({ type: 'tool', name: `${name}:result`, content: `${block.is_error === true ? '[error] ' : ''}${body}` });
    }
  }

  private result(message: Record<string, unknown>): void {
    this.noteSession(message.session_id);
    this.finished = true;
    this.emitUsage(message);
    const errors = Array.isArray(message.errors) ? message.errors.filter((e): e is string => typeof e === 'string') : [];
    if (message.subtype === 'success' && message.is_error !== true) {
      const text = str(message.result);
      if (!this.emittedText && text) this.text(text);
      return;
    }
    const detail = message.subtype === 'success'
      ? str(message.result)
      : errors.join('; ') || str(message.result);
    const label = message.subtype === 'success' ? 'Claude reported an error' : `Claude run ended with ${String(message.subtype)}`;
    const assistantHint = this.lastAssistantError ? ` (${this.lastAssistantError})` : '';
    throw new ProviderError(truncate(`${label}${assistantHint}${detail ? `: ${detail}` : ''}`, 1_500), { code: `claude_${String(message.subtype)}` });
  }

  private emitUsage(message: Record<string, unknown>): void {
    let input = 0;
    let output = 0;
    let found = false;
    const modelUsage = isRecord(message.modelUsage) ? Object.values(message.modelUsage).filter(isRecord) : [];
    const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    if (modelUsage.length > 0) {
      for (const usage of modelUsage) {
        input += num(usage.inputTokens) + num(usage.cacheReadInputTokens) + num(usage.cacheCreationInputTokens);
        output += num(usage.outputTokens);
      }
      found = true;
    } else if (isRecord(message.usage)) {
      input = num(message.usage.input_tokens) + num(message.usage.cache_read_input_tokens) + num(message.usage.cache_creation_input_tokens);
      output = num(message.usage.output_tokens);
      found = true;
    }
    const cost = typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd) ? message.total_cost_usd : null;
    if (found || cost !== null) this.emit({ type: 'usage', inputTokens: input, outputTokens: output, costUsd: cost });
  }
}

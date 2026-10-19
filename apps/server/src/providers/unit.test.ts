import { describe, expect, it } from 'vitest';
import { createAdapter } from './index.js';
import { TextTail, redactSecrets } from './common.js';
import { CodexUsageTracker, codexPolicy, describeTurnError, itemToolEvent } from './codex/mapping.js';
import { ClaudeMessageMapper, claudePermissionMode } from './claude/messages.js';

describe('createAdapter', () => {
  it('returns an adapter for each provider and rejects unknown ones', () => {
    expect(typeof createAdapter('codex').run).toBe('function');
    expect(typeof createAdapter('claude').run).toBe('function');
    expect(() => createAdapter('other' as never)).toThrow(/Unknown provider/);
  });
});

describe('redaction', () => {
  it('masks credentials in the shapes that show up in logs', () => {
    const input = 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghij Authorization: Bearer abcdefghijklmnopqrstuv {"access_token":"abc123"} eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl ghp_abcdefghijklmnopqrstuvwx';
    const out = redactSecrets(input);
    for (const secret of ['abcdefghij', 'abcdefghijklmnopqrstuv', 'abc123', 'c2lnbmF0dXJl', 'ghp_abcdefghijklmnopqrstuvwx']) expect(out).not.toContain(secret);
    expect(redactSecrets('plain text stays')).toBe('plain text stays');
    expect(redactSecrets('value is hunter2hunter2', ['hunter2hunter2'])).toBe('value is [redacted]');
  });

  it('keeps only the tail of a long stream', () => {
    const tail = new TextTail(100);
    for (let i = 0; i < 50; i += 1) tail.push(`line ${i}\n`);
    const summary = tail.summary(60);
    expect(summary).toContain('line 49');
    expect(summary.length).toBeLessThan(120);
    expect(new TextTail().isEmpty).toBe(true);
  });
});

describe('codex mapping', () => {
  it('maps relay policies to wire values from the app-server schema', () => {
    expect(codexPolicy('supervised', '/w')).toEqual({ approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } });
    expect(codexPolicy('balanced', '/w')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/w'], networkAccess: false } });
  });

  it('derives per-run usage from thread totals', () => {
    const tracker = new CodexUsageTracker();
    expect(tracker.result()).toBeNull();
    tracker.update({ total: { inputTokens: 5000, outputTokens: 400 }, last: { inputTokens: 1000, outputTokens: 100 } });
    tracker.update({ total: { inputTokens: 7000, outputTokens: 650 }, last: { inputTokens: 2000, outputTokens: 250 } });
    expect(tracker.result()).toEqual({ inputTokens: 3000, outputTokens: 350 });
    tracker.update('garbage');
    expect(tracker.result()).toEqual({ inputTokens: 3000, outputTokens: 350 });
  });

  it('describes turn errors with their classification', () => {
    expect(describeTurnError({ message: 'Bad', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } })).toBe('Bad [httpConnectionFailed HTTP 502]');
    expect(describeTurnError(null, 'fallback')).toBe('fallback');
  });

  it('produces tool events for commands and file changes, and nothing for plain messages', () => {
    expect(itemToolEvent({ type: 'agentMessage', id: '1', text: 'x' }, 'completed')).toBeNull();
    expect(itemToolEvent({ type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'a.ts', kind: { type: 'add' }, diff: '+x' }] }, 'completed'))
      .toEqual({ type: 'tool', name: 'file_change', content: 'add a.ts\n[completed]\n+x' });
  });
});

describe('claude mapping', () => {
  it('maps policies', () => {
    expect(claudePermissionMode('supervised')).toBe('default');
    expect(claudePermissionMode('balanced')).toBe('acceptEdits');
  });

  it('ignores subagent text and unknown message types', () => {
    const events: unknown[] = [];
    const mapper = new ClaudeMessageMapper('claude-sonnet-5-5', (e) => events.push(e));
    mapper.handle({ type: 'stream_event', parent_tool_use_id: 'tool-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } } });
    mapper.handle({ type: 'rate_limit_event' });
    mapper.handle('nonsense');
    expect(events).toEqual([]);
  });
});

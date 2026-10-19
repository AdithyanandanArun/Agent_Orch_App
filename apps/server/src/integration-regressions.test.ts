import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { mergeTextDelta } from '@relay/contracts/stream';
import { EXAMPLE_ARTIFACT_PATH, EXAMPLE_CLIENT_SESSION_ID, EXAMPLE_CONTRACT_SESSION_ID, EXAMPLE_PROJECT_ID } from './example.ts';
import { deferred, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async (options: Parameters<typeof startTestApp>[0] = {}) => {
  const app = await startTestApp(options);
  apps.push(app);
  return app;
};
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

describe('snapshot and stream ordering', () => {
  it('does not repeat chunks already covered by a snapshot or a previous event', () => {
    expect(mergeTextDelta('Hello', 0, 'Hel')).toBe('Hello');
    expect(mergeTextDelta('Hello', 3, 'lo')).toBe('Hello');
    expect(mergeTextDelta('Hello', 5, ' world')).toBe('Hello world');
    expect(mergeTextDelta('Hello world', 5, ' world')).toBe('Hello world');
    expect(mergeTextDelta('Hello w', 5, ' world')).toBe('Hello world');
    expect(mergeTextDelta('He', 5, ' world')).toBeNull();
    expect(mergeTextDelta('Hello', -1, 'x')).toBeNull();
  });

  it('gives each durable message its own absolute stream offsets', async () => {
    const t = await boot();
    const chunks: { messageId: string; delta: string; offset: number }[] = [];
    const listener = t.app.hub.broadcast.bind(t.app.hub);
    t.app.hub.broadcast = event => {
      if (event.type === 'session.delta') chunks.push(event as typeof chunks[number]);
      listener(event);
    };
    t.fake.script = async (_run, emit) => {
      emit({ type: 'text', text: 'Hello' });
      emit({ type: 'text', text: ' world' });
      emit({ type: 'tool', name: 'Read', content: 'README.md' });
      emit({ type: 'text', text: 'Done' });
    };
    await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'go' });
    await waitFor(() => chunks.length === 3);
    expect(chunks.map(chunk => chunk.offset)).toEqual([0, 5, 0]);
    expect(chunks[0]!.messageId).toBe(chunks[1]!.messageId);
    expect(chunks[2]!.messageId).not.toBe(chunks[0]!.messageId);
  });
});

it('retains handed-off context after the provider creates a conversation but fails before finishing', async () => {
  const t = await boot();
  await t.api('POST', '/api/handoffs', { fromSessionId: EXAMPLE_CONTRACT_SESSION_ID, toSessionId: EXAMPLE_CLIENT_SESSION_ID, path: EXAMPLE_ARTIFACT_PATH, revision: 'HEAD' });
  t.fake.script = async (_run, emit) => {
    emit({ type: 'session', providerSessionId: 'conversation-created-before-error' });
    emit({ type: 'info', content: 'Starting provider' });
    throw new Error('Provider rejected turn before completion');
  };
  await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'first try' });
  await waitFor(() => t.app.store.getSession(EXAMPLE_CLIENT_SESSION_ID)?.status === 'error');
  t.fake.script = async () => undefined;
  await t.api('POST', `/api/sessions/${EXAMPLE_CLIENT_SESSION_ID}/messages`, { content: 'retry' });
  await waitFor(() => t.fake.runs.length === 2);
  expect(t.fake.runs[1]!.prompt).toContain('Example Users API');
  expect(t.fake.runs[1]!.session.providerSessionId).toBe('conversation-created-before-error');
});

it('reports native terminal startup failure with an actionable error frame', async () => {
  const t = await boot({ terminal: { spawner: async () => { throw new Error('Shell executable missing'); } } });
  const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws`, { origin: t.url });
  const frames: Record<string, unknown>[] = [];
  ws.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'terminal.start', projectId: EXAMPLE_PROJECT_ID, cols: 80, rows: 24 }));
  const frame = await waitFor(() => frames.find(event => event.type === 'terminal.error'));
  expect(frame.message).toContain('Shell executable missing');
  expect(t.app.terminals.count).toBe(0);
  ws.close();
});

it('reserves terminal capacity while concurrent starts await the native spawner', async () => {
  const gate = deferred();
  let attempts = 0;
  const t = await boot({ terminal: { spawner: async () => { attempts++; await gate.promise; throw new Error('Fixture spawner released'); } } });
  const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws`, { origin: t.url });
  const frames: Record<string, unknown>[] = [];
  ws.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ type: 'terminal.start', projectId: EXAMPLE_PROJECT_ID, cols: 80, rows: 24 }));
  await waitFor(() => frames.some(event => event.type === 'terminal.error' && String(event.message).includes('Too many')));
  expect(attempts).toBe(8);
  gate.resolve();
  ws.close();
});

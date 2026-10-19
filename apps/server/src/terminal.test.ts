import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { EXAMPLE_CONTRACT_SESSION_ID, EXAMPLE_PROJECT_ID } from './example.ts';
import { startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async () => { const t = await startTestApp({ terminal: { shell: '/bin/sh' } }); apps.push(t); return t; };
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

interface Client { ws: WebSocket; frames: any[]; send(event: object): void; next(predicate: (f: any) => boolean, ms?: number): Promise<any> }

async function connect(t: TestApp): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws`, { headers: { origin: 'http://localhost:5173' } });
  const frames: any[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  return {
    ws, frames, send: (event) => ws.send(JSON.stringify(event)),
    next: (predicate, ms = 5000) => waitFor(() => frames.find(predicate), ms, 'websocket frame'),
  };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('PTY terminals', () => {
  it('runs a real shell in the session worktree, echoes input, resizes and stops', async () => {
    const t = await boot();
    const session = (await t.api('GET', '/api/bootstrap')).json.sessions.find((s: any) => s.id === EXAMPLE_CONTRACT_SESSION_ID);
    const c = await connect(t);
    c.send({ type: 'terminal.start', projectId: EXAMPLE_PROJECT_ID, sessionId: session.id, cols: 100, rows: 30 });
    const ready = await c.next((f) => f.type === 'terminal.ready');
    c.send({ type: 'terminal.input', terminalId: ready.terminalId, data: 'pwd; stty size; echo marker-$((6*7))\n' });
    await waitFor(() => c.frames.filter((f) => f.type === 'terminal.output' && f.terminalId === ready.terminalId).map((f) => f.data).join('').includes('marker-42'));
    const output = c.frames.filter((f) => f.type === 'terminal.output').map((f) => f.data).join('');
    expect(output).toContain(session.worktreePath);
    expect(output).toContain('30 100');
    c.send({ type: 'terminal.resize', terminalId: ready.terminalId, cols: 120, rows: 40 });
    c.send({ type: 'terminal.input', terminalId: ready.terminalId, data: 'stty size\n' });
    await waitFor(() => c.frames.filter((f) => f.type === 'terminal.output').map((f) => f.data).join('').includes('40 120'));
    c.send({ type: 'terminal.stop', terminalId: ready.terminalId });
    expect((await c.next((f) => f.type === 'terminal.exit')).terminalId).toBe(ready.terminalId);
    c.ws.close();
  });

  it('kills the shell when its socket closes and keeps terminals private to their owner', async () => {
    const t = await boot();
    const owner = await connect(t);
    const intruder = await connect(t);
    owner.send({ type: 'terminal.start', projectId: EXAMPLE_PROJECT_ID, cols: 80, rows: 24 });
    const ready = await owner.next((f) => f.type === 'terminal.ready');
    const [pid] = t.app.terminals.pids();
    expect(alive(pid!)).toBe(true);
    // Another socket can neither type into, resize nor stop the terminal.
    intruder.send({ type: 'terminal.input', terminalId: ready.terminalId, data: 'echo hijack-$((1+1))\n' });
    intruder.send({ type: 'terminal.stop', terminalId: ready.terminalId });
    owner.send({ type: 'terminal.input', terminalId: ready.terminalId, data: 'echo owner-$((2+2))\n' });
    await waitFor(() => owner.frames.filter((f) => f.type === 'terminal.output').map((f) => f.data).join('').includes('owner-4'));
    const text = owner.frames.filter((f) => f.type === 'terminal.output').map((f) => f.data).join('');
    expect(text).not.toContain('hijack-2');
    expect(owner.frames.some((f) => f.type === 'terminal.exit')).toBe(false);
    expect(intruder.frames.some((f) => f.type === 'terminal.output')).toBe(false);
    owner.ws.close();
    await waitFor(() => !alive(pid!), 5000, 'shell to be killed');
    expect(t.app.terminals.count).toBe(0);
    intruder.ws.close();
  });

  it('validates start requests: unknown projects, bad sizes and mismatched sessions', async () => {
    const t = await boot();
    const c = await connect(t);
    c.send({ type: 'terminal.start', projectId: 'nope', cols: 80, rows: 24 });
    expect((await c.next((f) => f.type === 'terminal.error')).message).toMatch(/Unknown project/);
    c.frames.length = 0;
    c.send({ type: 'terminal.start', projectId: EXAMPLE_PROJECT_ID, cols: 100000, rows: 24 });
    c.send({ type: 'terminal.start', projectId: EXAMPLE_PROJECT_ID, cols: 1, rows: 0 });
    c.send({ type: 'terminal.start', projectId: EXAMPLE_PROJECT_ID, cols: 80.5, rows: 24 });
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ type: 'terminal.input', terminalId: 'x', data: 'y'.repeat(70_000) }));
    await new Promise((r) => setTimeout(r, 200));
    expect(c.frames.filter((f) => f.type === 'terminal.ready')).toHaveLength(0);
    expect(t.app.terminals.count).toBe(0);
    c.send({ type: 'terminal.start', projectId: EXAMPLE_PROJECT_ID, sessionId: 'ses_missing', cols: 80, rows: 24 });
    expect((await c.next((f) => f.type === 'terminal.error')).message).toMatch(/Unknown session/);
    c.ws.close();
  });

  it('kills every shell on application shutdown', async () => {
    const t = await boot();
    const c = await connect(t);
    c.send({ type: 'terminal.start', projectId: EXAMPLE_PROJECT_ID, cols: 80, rows: 24 });
    await c.next((f) => f.type === 'terminal.ready');
    const [pid] = t.app.terminals.pids();
    await t.app.close();
    await waitFor(() => !alive(pid!), 5000, 'shell to exit');
  });
});

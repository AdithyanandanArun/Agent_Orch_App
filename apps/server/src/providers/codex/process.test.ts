import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexAdapter } from './adapter.js';
import { Sandbox, posixOnly } from '../testing/executables.js';
import { makeRun, text, waitFor } from '../testing/helpers.js';

const FAST = { initializeMs: 3_000, threadMs: 3_000, turnStartMs: 3_000, interruptMs: 300, interruptGraceMs: 300, shutdownGraceMs: 200, termMs: 300, killMs: 1_000 };

/** The adapter against a real child process (the fixture), to cover spawn, stdio framing and signals. */
describe.skipIf(posixOnly)('codex adapter against a fixture process', () => {
  let box: Sandbox;
  let binary: string;
  beforeEach(async () => { box = await Sandbox.create(); binary = await box.fakeCodex(); });
  afterEach(async () => { await box.dispose(); });

  const adapterFor = (env: Record<string, string>) => createCodexAdapter({
    env: { PATH: '/usr/bin:/bin', ...env }, timeouts: FAST,
    resolveExecutable: async () => ({ ok: true, executable: { path: binary, version: '9.9.9', source: 'setting', skipped: [] } }),
  });

  it('completes a turn end to end', async () => {
    const run = makeRun({ session: { worktreePath: box.root } });
    await adapterFor({ FAKE_CODEX_MODE: 'happy' }).run(run.options);
    expect(text(run.events)).toBe('Hello world');
    expect(run.events[0]).toEqual({ type: 'session', providerSessionId: 'thr_fixture' });
  });

  it('forwards an approval and sends the decision back over stdio', async () => {
    const run = makeRun({ session: { worktreePath: box.root }, approve: () => true });
    await adapterFor({ FAKE_CODEX_MODE: 'approval' }).run(run.options);
    expect(run.approvals[0]).toMatchObject({ tool: 'shell', input: { command: 'rm -rf build' } });
    expect(text(run.events)).toBe('decision=accept');

    const denied = makeRun({ session: { worktreePath: box.root }, approve: () => false });
    await adapterFor({ FAKE_CODEX_MODE: 'approval' }).run(denied.options);
    expect(text(denied.events)).toBe('decision=decline');
  });

  it('rejects with redacted stderr when the process exits before finishing', async () => {
    const run = makeRun({ session: { worktreePath: box.root } });
    const error = await adapterFor({ FAKE_CODEX_MODE: 'exit-mid-turn' }).run(run.options).catch((e: Error) => e);
    expect(error).toMatchObject({ code: 'process_exited' });
    expect((error as Error).message).toContain('code 3');
    expect((error as Error).message).toContain('crashed the sandbox');
    expect((error as Error).message).not.toContain('abcdefghijklmnop');
    expect(text(run.events)).toBe('partial');
  });

  it('kills a process that ignores both the interrupt and SIGTERM', async () => {
    const pidFile = join(box.root, 'pid');
    const run = makeRun({ session: { worktreePath: box.root } });
    const promise = adapterFor({ FAKE_CODEX_MODE: 'ignore-sigterm', FAKE_CODEX_PIDFILE: pidFile }).run(run.options);
    await waitFor(() => run.events.some((e) => e.type === 'session'), 'thread start', 4_000);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let turn/start land
    const started = Date.now();
    run.controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(3_000);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow(); // really gone
  });
});

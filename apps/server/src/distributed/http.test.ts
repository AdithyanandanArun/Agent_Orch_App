import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../test-utils.ts';

const apps: TestApp[] = [];
async function boot() {
  const app = await startTestApp({ exampleWorkspace: false, env: {} });
  apps.push(app);
  return app;
}
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

describe('distributed HTTP boundaries', () => {
  it('keeps local work usable and returns an empty truthful snapshot while signed out', async () => {
    const t = await boot();
    const result = await t.api('GET', '/api/distributed/snapshot');
    expect(result.status).toBe(200);
    expect(result.json.teams.userId).toBeNull();
    expect(result.json.teams.teams).toEqual([]);
    expect(result.json.transport.devices).toEqual([]);
    expect(result.json.execution.requests).toEqual([]);
    expect(result.json.git.requests).toEqual([]);
    expect(result.json.commands.requests).toEqual([]);
    expect(JSON.stringify(result.json)).not.toMatch(/access_token|refresh_token|privateKey|secretKey/);
    expect((await t.api('GET', '/api/health')).status).toBe(200);
    expect(t.fake.runs).toEqual([]);
  });

  it('does not turn account absence into team authority or a remote run', async () => {
    const t = await boot();
    const result = await t.api('POST', '/api/distributed/teams', { name: 'My team' });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(result.json.error).toBeTypeOf('string');
    expect(t.fake.runs).toEqual([]);
  });

  it('rejects foreign browser origins before any team mutation', async () => {
    const t = await boot();
    const result = await t.api('POST', '/api/distributed/teams', { name: 'Attack' }, { origin: 'https://attacker.invalid' });
    expect(result.status).toBe(403);
    expect(t.fake.runs).toEqual([]);
  });

  it('requires the displayed immutable digest for an owner decision', async () => {
    const t = await boot();
    for (const route of ['git/request-1/decision', 'commands/request-1/decision', 'approvals/request-1']) {
      const result = await t.api('POST', `/api/distributed/${route}`, { decision: 'approved' });
      expect(result.status).toBe(400);
    }
    expect(t.fake.runs).toEqual([]);
  });

  it('rejects executable strings, caller-selected paths and extra identity claims at the command boundary', async () => {
    const t = await boot();
    const base = { teamId: 'team', sharedProjectId: 'project', toDeviceId: 'peer' };
    const requests = [
      { ...base, operation: { kind: 'shell', command: 'echo owned' } },
      { ...base, operation: { kind: 'git.status' }, executable: '/bin/sh' },
      { ...base, operation: { kind: 'git.status' }, ownerId: 'someone-else' },
      { ...base, operation: { kind: 'git.log', limit: 1_000_000 } },
    ];
    for (const body of requests) expect((await t.api('POST', '/api/distributed/commands/request', body)).status).toBe(400);
    expect(t.fake.runs).toEqual([]);
  });

  it('validates team scope and invitation input without exposing historical data', async () => {
    const t = await boot();
    expect((await t.api('GET', '/api/distributed/snapshot?teamId=../other')).status).toBe(400);
    expect((await t.api('GET', '/api/distributed/snapshot?ownerId=other')).status).toBe(400);
    expect((await t.api('POST', '/api/distributed/invitations/accept', { token: 'short' })).status).toBe(400);
    expect((await t.api('POST', '/api/distributed/invitations/accept', { token: 'a'.repeat(64), userId: 'other' })).status).toBe(400);
  });
});

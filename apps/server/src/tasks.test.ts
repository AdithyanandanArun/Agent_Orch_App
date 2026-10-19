import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_CLIENT_SESSION_ID, EXAMPLE_CONTRACT_SESSION_ID, EXAMPLE_PROJECT_ID } from './example.ts';
import { deferred, makeRepo, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async (options: Parameters<typeof startTestApp>[0] = {}) => { const t = await startTestApp(options); apps.push(t); return t; };
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

const tasks = async (t: TestApp) => (await t.api('GET', '/api/bootstrap')).json.tasks as any[];
const byId = async (t: TestApp, id: string) => (await tasks(t)).find((x) => x.id === id);

describe('task DAG API', () => {
  it('creates tasks as ready or blocked depending on dependencies', async () => {
    const t = await boot({ exampleWorkspace: false });
    const project = (await t.api('POST', '/api/projects', { name: 'p', path: makeRepo() })).json;
    const a = (await t.api('POST', '/api/tasks', { projectId: project.id, title: 'A' })).json;
    const b = (await t.api('POST', '/api/tasks', { projectId: project.id, title: 'B', dependsOn: [a.id] })).json;
    expect([a.status, b.status]).toEqual(['ready', 'blocked']);
    expect(b.dependsOn).toEqual([a.id]);
    expect((await t.api('POST', '/api/tasks', { projectId: project.id, title: 'C', dependsOn: ['nope'] })).status).toBe(422);
    expect((await t.api('POST', '/api/tasks', { projectId: 'missing', title: 'C' })).status).toBe(404);
  });

  it('rejects cycles, self-dependencies and cross-project references', async () => {
    const t = await boot();
    const other = (await t.api('POST', '/api/projects', { name: 'other', path: makeRepo() })).json;
    const foreignTask = (await t.api('POST', '/api/tasks', { projectId: other.id, title: 'foreign' })).json;
    // Example chain: contract <- client <- tests <- review
    const cycle = await t.api('PATCH', '/api/tasks/tsk_example_contract', { dependsOn: ['tsk_example_review'] });
    expect(cycle.status).toBe(422);
    expect(cycle.json.error).toMatch(/cycle/i);
    expect((await t.api('PATCH', '/api/tasks/tsk_example_client', { dependsOn: ['tsk_example_client'] })).status).toBe(422);
    expect((await t.api('PATCH', '/api/tasks/tsk_example_client', { dependsOn: [foreignTask.id] })).status).toBe(422);
    expect((await t.api('POST', '/api/tasks', { projectId: EXAMPLE_PROJECT_ID, title: 'x', dependsOn: [foreignTask.id] })).status).toBe(422);
    const foreignSession = (await t.api('POST', '/api/sessions', { projectId: other.id, name: 's', provider: 'claude', model: 'm' })).json;
    expect((await t.api('PATCH', '/api/tasks/tsk_example_client', { sessionId: foreignSession.id })).status).toBe(422);
    expect((await t.api('POST', '/api/tasks', { projectId: EXAMPLE_PROJECT_ID, title: 'x', sessionId: foreignSession.id })).status).toBe(422);
    expect((await byId(t, 'tsk_example_contract')).dependsOn).toEqual([]); // rejected edits changed nothing
  });

  it('refuses transitions past unfinished dependencies and unblocks downstream tasks when work is done', async () => {
    const t = await boot();
    expect((await t.api('PATCH', '/api/tasks/tsk_example_client', { status: 'ready' })).status).toBe(409);
    expect((await t.api('PATCH', '/api/tasks/tsk_example_client', { status: 'done' })).status).toBe(409);
    expect((await t.api('PATCH', '/api/tasks/tsk_example_contract', { status: 'running' })).status).toBe(409);
    expect((await t.api('PATCH', '/api/tasks/tsk_example_contract', { status: 'done' })).json.status).toBe('done');
    expect((await byId(t, 'tsk_example_client')).status).toBe('ready');
    expect((await byId(t, 'tsk_example_tests')).status).toBe('blocked'); // still waits for the client task
    expect((await byId(t, 'tsk_example_review')).status).toBe('blocked');
    // Reopening a finished prerequisite blocks ready dependents again.
    await t.api('PATCH', '/api/tasks/tsk_example_contract', { status: 'review' });
    expect((await byId(t, 'tsk_example_client')).status).toBe('blocked');
    const events = (await t.api('GET', '/api/events')).json.map((e: any) => e.type);
    expect(events).toEqual(expect.arrayContaining(['task.unblocked', 'task.blocked', 'task.updated']));
  });

  it('adjusts ready/blocked when dependencies are edited', async () => {
    const t = await boot({ exampleWorkspace: false });
    const project = (await t.api('POST', '/api/projects', { name: 'p', path: makeRepo() })).json;
    const a = (await t.api('POST', '/api/tasks', { projectId: project.id, title: 'A' })).json;
    const b = (await t.api('POST', '/api/tasks', { projectId: project.id, title: 'B' })).json;
    expect((await t.api('PATCH', `/api/tasks/${b.id}`, { dependsOn: [a.id] })).json.status).toBe('blocked');
    expect((await t.api('PATCH', `/api/tasks/${b.id}`, { dependsOn: [] })).json.status).toBe('ready');
    expect((await t.api('PATCH', `/api/tasks/${b.id}`, { title: 'B2' })).json).toMatchObject({ title: 'B2', status: 'ready' });
  });

  it('runs a task through its assigned session, moves it to review (never done) and restores ready on failure', async () => {
    const t = await boot();
    expect((await t.api('POST', '/api/tasks/tsk_example_client/run')).status).toBe(409); // blocked
    expect((await t.api('POST', '/api/tasks/tsk_example_review/run')).status).toBe(409);
    expect((await t.api('POST', '/api/tasks/missing/run')).status).toBe(404);

    const gate = deferred();
    t.fake.script = async (_o, emit) => { emit({ type: 'text', text: 'done it' }); await gate.promise; };
    expect((await t.api('POST', '/api/tasks/tsk_example_contract/run')).status).toBe(202);
    await waitFor(async () => (await byId(t, 'tsk_example_contract')).status === 'running');
    expect(t.fake.runs[0]!.prompt).toContain('Review and tighten the users API v1 contract');
    expect(t.fake.runs[0]!.prompt).toContain('Acceptance criteria');
    expect((await t.api('POST', '/api/tasks/tsk_example_contract/run')).status).toBe(409);
    gate.resolve();
    await waitFor(async () => (await byId(t, 'tsk_example_contract')).status === 'review');
    expect((await byId(t, 'tsk_example_client')).status).toBe('blocked'); // review is not done
    await waitFor(async () => (await t.api('GET', '/api/bootstrap')).json.sessions[0].status === 'idle');

    t.fake.script = async () => { throw new Error('model unavailable'); };
    expect((await t.api('POST', '/api/tasks/tsk_example_contract/run')).status).toBe(202);
    await waitFor(async () => (await t.api('GET', '/api/bootstrap')).json.sessions[0].status === 'error');
    expect((await byId(t, 'tsk_example_contract')).status).toBe('ready');
    const msgs = (await t.api('GET', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`)).json;
    expect(msgs.filter((m: any) => m.kind === 'task')).toHaveLength(2);
  });

  it('requires an assigned session to run a task', async () => {
    const t = await boot();
    const task = (await t.api('POST', '/api/tasks', { projectId: EXAMPLE_PROJECT_ID, title: 'unassigned' })).json;
    expect((await t.api('POST', `/api/tasks/${task.id}/run`)).status).toBe(409);
    expect((await t.api('PATCH', `/api/tasks/${task.id}`, { sessionId: EXAMPLE_CLIENT_SESSION_ID })).json.sessionId).toBe(EXAMPLE_CLIENT_SESSION_ID);
  });
});

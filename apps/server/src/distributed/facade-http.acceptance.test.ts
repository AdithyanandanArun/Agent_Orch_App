import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountService } from '../account/service.ts';
import { makeRepo, runGit, startTestApp, tmpDir, waitFor, type TestApp } from '../test-utils.ts';
import { AuthenticatedLocalRelay } from './acceptance-cloud.ts';

const TEAM = '737a46b3-42ac-4f5e-9f69-5bf451e4c1a2';
const SHARED = '74a6724d-aef4-4783-a4fc-160046c77f59';
const OWNER_A = '220f8441-9dbe-49b2-928d-5f2f9db2eab6';
const OWNER_B = '6d34d2e2-4fed-4ed6-bc1f-32f22dbe6bf2';
const apps: TestApp[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class WorkspaceRelay extends AuthenticatedLocalRelay {
  override client(ownerId: string): SupabaseClient {
    const client = super.client(ownerId);
    return { from: (table: string) => {
      const query = client.from(table) as unknown as { range(from: number, to: number): unknown };
      // Team snapshots use a bounded list; the base mailbox fixture exposes range instead.
      return Object.assign(query, { limit: (count: number) => query.range(0, count - 1) });
    } } as unknown as SupabaseClient;
  }
  override async execute(...args: Parameters<AuthenticatedLocalRelay['execute']>) {
    if (args[1] === 'mingle_teams' || args[1] === 'mingle_invitations') {
      const data = args[1] === 'mingle_teams' && this.activeMember(TEAM, args[0])
        ? [{ id: TEAM, name: 'Example two-app team', owner_id: OWNER_A, created_at: '2026-01-01T00:00:00Z' }] : [];
      return { data, error: null };
    }
    const result = await super.execute(...args);
    if (args[1] === 'mingle_members' && Array.isArray(result.data)) {
      result.data = result.data.map((row: Record<string, unknown>) => ({
        ...row, role: row.user_id === OWNER_A ? 'owner' : 'member', created_at: '2026-01-01T00:00:00Z',
      }));
    }
    return result;
  }
}

it('moves approved commands, Git and recovery through two complete HTTP applications and encrypted mailboxes', async () => {
  const relay = new WorkspaceRelay();
  relay.addTeam(TEAM, [OWNER_A, OWNER_B], SHARED);
  Object.assign(relay.projects[0]!, { name: 'Example shared repository', created_at: '2026-01-01T00:00:00Z' });
  const accounts = new Map<string, ReturnType<WorkspaceRelay['account']>>();
  const nativeSnapshot = AccountService.prototype.snapshot;
  vi.spyOn(AccountService.prototype, 'snapshot').mockImplementation(function (this: AccountService) {
    const snapshot = nativeSnapshot.call(this);
    const account = accounts.get(Reflect.get(this, 'dataDir'));
    return account ? { ...snapshot, configured: true, status: 'signed-in', user: { id: account.ownerId, name: 'Example test account', email: 'fixture@example.invalid' } } : snapshot;
  });
  vi.spyOn(AccountService.prototype, 'withAuthenticatedClient').mockImplementation((async function <T>(
    this: AccountService, callback: (client: SupabaseClient, user: User) => Promise<T>,
  ): Promise<T> {
    const account = accounts.get(Reflect.get(this, 'dataDir'));
    if (!account) throw new Error('No local relay account for this disposable app.');
    return account.withAuthenticatedClient(callback);
  }) as AccountService['withAuthenticatedClient']);

  async function boot(owner: string) {
    const dataDir = tmpDir('mingle-http-device-');
    accounts.set(dataDir, relay.account(owner));
    const t = await startTestApp({ dataDir, env: {}, exampleWorkspace: false });
    apps.push(t);
    return t;
  }
  const a = await boot(OWNER_A);
  const b = await boot(OWNER_B);
  async function api(t: TestApp, route: string, body: unknown) {
    const response = await t.api('POST', `/api/distributed/${route}`, body);
    expect(response.status, `${route}: ${JSON.stringify(response.json)}`).toBe(200);
    return response.json;
  }
  async function snapshot(t: TestApp) {
    const response = await t.api('GET', `/api/distributed/snapshot?teamId=${TEAM}`);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    return response.json;
  }
  const deviceA = await api(a, 'devices/register', { teamId: TEAM, name: 'Example device A' });
  const deviceB = await api(b, 'devices/register', { teamId: TEAM, name: 'Example device B' });
  await api(a, 'devices/link', { teamId: TEAM, deviceId: deviceB.id, fingerprint: deviceB.fingerprint });
  await api(b, 'devices/link', { teamId: TEAM, deviceId: deviceA.id, fingerprint: deviceA.fingerprint });
  await api(a, 'sync', {});
  await api(b, 'sync', {});

  const source = makeRepo();
  const parent = tmpDir('mingle-http-git-');
  roots.push(source, parent);
  const destination = path.join(parent, 'destination');
  runGit(parent, 'clone', '-q', source, destination);
  const base = runGit(source, 'rev-parse', 'HEAD').trim();
  const sourceProject = (await a.api('POST', '/api/projects', { name: 'Example source', path: source })).json;
  const targetProject = (await b.api('POST', '/api/projects', { name: 'Example target', path: destination })).json;
  for (const [app, project] of [[a, sourceProject], [b, targetProject]] as const) {
    await api(app, 'projects/bind', { teamId: TEAM, sharedProjectId: SHARED, localProjectId: project.id });
  }
  expect((await snapshot(a)).teams.teams[0]).toMatchObject({ id: TEAM, role: 'owner' });
  expect((await snapshot(b)).teams.teams[0]).toMatchObject({ id: TEAM, role: 'member' });

  const command = await api(a, 'commands/request', { teamId: TEAM, sharedProjectId: SHARED, toDeviceId: deviceB.id, operation: { kind: 'git.head' }, cwd: '' });
  await api(b, 'sync', {});
  const pending = (await snapshot(b)).commands.requests[0]!;
  expect(pending.status).toBe('awaiting-approval');
  await api(b, `commands/${pending.id}/decision`, { decision: 'approved', expectedDigest: pending.requestDigest });
  await api(a, 'sync', {});
  const result = (await snapshot(a)).commands.requests.find((row: { id: string }) => row.id === command.id)!;
  expect(result.status).toBe('completed');
  expect(result.output).toContain(base);

  // Incompressible bytes force multiple real encrypted envelopes rather than one tiny fixture chunk.
  writeFileSync(path.join(source, 'payload.bin'), randomBytes(600 * 1024));
  runGit(source, 'add', 'payload.bin');
  runGit(source, 'commit', '-q', '-m', 'Disposable cross-device transfer');
  const head = runGit(source, 'rev-parse', 'HEAD').trim();
  const offer = await api(a, 'git/request', { teamId: TEAM, sharedProjectId: SHARED, toDeviceId: deviceB.id, expectedHead: head, baseHead: base });
  await api(b, 'sync', {});
  const incoming = (await snapshot(b)).git.requests.find((row: { direction: string }) => row.direction === 'incoming')!;
  expect(incoming.status).toBe('awaiting-destination-approval');
  expect(relay.envelopes.some((row) => row.kind === 'git.bundle.chunk')).toBe(false);
  await api(a, `git/${offer.id}/decision`, { decision: 'approved', expectedDigest: offer.requestDigest });
  await api(b, `git/${incoming.id}/decision`, { decision: 'approved', expectedDigest: incoming.requestDigest });
  await api(a, 'sync', {});
  expect(relay.envelopes.filter((row) => row.kind === 'git.bundle.chunk').length).toBeGreaterThan(1);
  await api(b, 'sync', {});
  const imported = (await snapshot(b)).git.requests.find((row: { id: string }) => row.id === incoming.id)!;
  expect(imported.status).toBe('imported');
  expect(runGit(destination, 'rev-parse', 'HEAD').trim()).toBe(base);
  expect(existsSync(path.join(destination, 'payload.bin'))).toBe(false);
  expect(runGit(destination, 'rev-parse', `refs/mingle/incoming/${incoming.id}`).trim()).toBe(head);
  const state = await b.api('GET', `/api/distributed/repository?teamId=${TEAM}&sharedProjectId=${SHARED}&localProjectId=${targetProject.id}`);
  expect(state.status).toBe(200);
  const integration = await api(b, 'git/integrate', { teamId: TEAM, sharedProjectId: SHARED, incomingRequestId: incoming.id, action: 'merge', expectedHead: state.json.head, expectedFingerprint: state.json.fingerprint });
  expect(existsSync(path.join(destination, 'payload.bin'))).toBe(false);
  await api(b, `git/${integration.id}/decision`, { decision: 'approved', expectedDigest: integration.requestDigest });
  expect(readFileSync(path.join(destination, 'payload.bin'))).toEqual(readFileSync(path.join(source, 'payload.bin')));
  expect(runGit(destination, 'rev-parse', 'HEAD').trim()).toBe(head);
  expect([...a.fake.runs, ...b.fake.runs]).toEqual([]);

  // Exercise the actual checkpoint, destination Git validation and SessionRuntime adapters too.
  // FakeProviders is the sole provider boundary; it emits local fixture text and starts no executable.
  await a.app.providers.refresh();
  await b.app.providers.refresh();
  const sourceSession = (await a.api('POST', '/api/sessions', { projectId: sourceProject.id, name: 'Example source session', provider: 'claude', model: 'claude-sonnet-5-5', policy: 'supervised' })).json;
  const targetSession = (await b.api('POST', '/api/sessions', { projectId: targetProject.id, name: 'Example receiving session', provider: 'claude', model: 'claude-sonnet-5-5', policy: 'supervised' })).json;
  const task = (await a.api('POST', '/api/tasks', { projectId: sourceProject.id, sessionId: sourceSession.id, title: 'Example committed-work recovery', acceptanceCriteria: 'Only the exact receiving owner can start one local fixture run.' })).json;
  await api(b, 'agents/publish', { teamId: TEAM, sharedProjectId: SHARED, sessionIds: [targetSession.id] });
  await api(a, 'sync', {});
  const agent = (await snapshot(a)).execution.agents.find((row: { sessionId: string }) => row.sessionId === targetSession.id)!;
  expect(agent).toBeDefined();
  const intent = { teamId: TEAM, sharedProjectId: SHARED, sourceSessionId: sourceSession.id, taskId: task.id,
    agentId: agent.id, mode: 'unpublished-recovery', allowUnverifiedTarget: true,
    content: 'Explicit human recovery of this disposable committed fixture.', idempotencyKey: 'full-app-recovery' };
  const recovery = await api(a, 'delegations', intent);
  // A fresh real RecoveryService capture creates a new checkpoint ID on each retry.
  expect((await api(a, 'delegations', intent)).id).toBe(recovery.id);
  await api(b, 'sync', {});
  const received = (await snapshot(b)).execution.requests.find((row: { id: string }) => row.id === recovery.id)!;
  expect(received.state).toBe('awaiting-approval');
  expect(b.fake.runs).toEqual([]);
  const noSpend = await b.api('POST', `/api/distributed/approvals/${received.id}`, { decision: 'approved', expectedDigest: received.digest, allowProviderSpend: false, allowUnverifiedQuota: true, shareProgress: false });
  expect(noSpend.status).toBe(409);
  expect(b.fake.runs).toEqual([]);
  await api(b, `approvals/${received.id}`, { decision: 'approved', expectedDigest: received.digest, allowProviderSpend: true, allowUnverifiedQuota: true, shareProgress: false });
  await waitFor(async () => {
    await api(a, 'sync', {});
    return (await snapshot(a)).execution.requests.find((row: { id: string; state: string }) => row.id === recovery.id)?.state === 'completed';
  }, 8000, 'approved fixture recovery completion at source');
  expect(a.fake.runs).toEqual([]);
  expect(b.fake.runs).toHaveLength(1);
  const duplicate = await b.api('POST', `/api/distributed/approvals/${received.id}`, { decision: 'approved', expectedDigest: received.digest, allowProviderSpend: true, allowUnverifiedQuota: true, shareProgress: false });
  expect(duplicate.status).toBe(409);
  expect(b.fake.runs).toHaveLength(1);
}, 30_000);

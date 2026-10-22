import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db.ts';
import { Store } from '../store.ts';
import {
  AuthenticatedLocalRelay, type AcceptanceAccount, type AcceptanceEnvelope,
} from './acceptance-cloud.ts';
import {
  RemoteExecutionService, type AuthenticatedClient, type AuthenticatedEnvelope, type LocalAlternative, type QuotaObservation,
  type RemoteExecutionAccount, type RemoteExecutionProviders, type RemoteExecutionRuntime, type RemoteExecutionWorkspace,
} from './execution.ts';
import { TransportService } from './transport.ts';

const TEAM_ID = '737a46b3-42ac-4f5e-9f69-5bf451e4c1a2';
const SHARED_PROJECT_ID = '74a6724d-aef4-4783-a4fc-160046c77f59';
const SECOND_SHARED_PROJECT_ID = '8c13f2ad-94a1-43db-9ee2-e4dc7d480ccb';
const OWNER_A = '220f8441-9dbe-49b2-928d-5f2f9db2eab6';
const OWNER_B = '6d34d2e2-4fed-4ed6-bc1f-32f22dbe6bf2';
const OWNER_OUTSIDE = 'ab12f39d-1d36-4937-8d20-f87f3e7a59f4';

interface DeviceNode {
  ownerId: string;
  suffix: 'a' | 'b';
  root: string;
  dataDir: string;
  databasePath: string;
  account: AcceptanceAccount;
  store: Store;
  transport: TransportService;
  execution: RemoteExecutionService | null;
  sessionId: string;
  projectId: string;
  taskId: string;
  task2Id: string;
  starts: Array<{ sessionId: string; content: string; runId: string }>;
  emitProgress: (event: { runId: string; kind: 'status' | 'progress' | 'result'; status?: string; summary?: string; delta?: string; terminal?: boolean }) => void;
  quota: QuotaObservation;
  alternatives: LocalAlternative[];
  workspace: RemoteExecutionWorkspace;
  runtime: RemoteExecutionRuntime;
  listeners: Set<(event: Parameters<DeviceNode['emitProgress']>[0]) => void>;
}

interface Pair {
  root: string;
  relay: AuthenticatedLocalRelay;
  clock: { value: number };
  a: DeviceNode;
  b: DeviceNode;
  deviceAId: string;
  deviceBId: string;
}

const fixtures: Pair[] = [];

afterEach(async () => {
  for (const pair of fixtures.splice(0)) {
    await closeNode(pair.a);
    await closeNode(pair.b);
    rmSync(pair.root, { recursive: true, force: true });
  }
});

function makeNode(root: string, relay: AuthenticatedLocalRelay, clock: { value: number }, ownerId: string, suffix: 'a' | 'b'): DeviceNode {
  const deviceRoot = path.join(root, `device-${suffix}`);
  const dataDir = path.join(deviceRoot, 'data');
  const localProjectPath = path.join(deviceRoot, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(localProjectPath, { recursive: true });
  const databasePath = path.join(dataDir, 'mingle.sqlite');
  const store = new Store(openDatabase(databasePath));
  const projectId = `local-project-${suffix}`;
  const sessionId = `local-session-${suffix}`;
  store.insertProject({ id: projectId, name: `Disposable acceptance workspace ${suffix.toUpperCase()}`, path: localProjectPath });
  store.insertSession({
    id: sessionId, projectId, name: `Injected runtime ${suffix.toUpperCase()}`, provider: suffix === 'a' ? 'codex' : 'claude',
    model: suffix === 'a' ? 'codex-acceptance-fixture' : 'claude-acceptance-fixture', effort: 'high', policy: 'supervised',
    isolated: false, worktreePath: localProjectPath, branch: 'acceptance-fixture',
  });
  const baseTaskId = `task-base-${suffix}`;
  store.insertTask({ id: baseTaskId, projectId, title: 'Committed prerequisite', description: '', acceptanceCriteria: '', sessionId, dependsOn: [], status: 'done' });
  const taskId = `task-${suffix}`;
  const task2Id = `task-second-${suffix}`;
  store.insertTask({ id: taskId, projectId, title: 'Continue the acceptance fixture', description: 'Use only disposable local data.',
    acceptanceCriteria: 'The receiving owner reviews the exact request digest.', sessionId, dependsOn: [baseTaskId], status: 'ready' });
  store.insertTask({ id: task2Id, projectId, title: 'Check restart replay behavior', description: 'Do not repeat an uncertain dispatch.',
    acceptanceCriteria: 'At most one runtime dispatch occurs.', sessionId, dependsOn: [baseTaskId], status: 'ready' });

  const account = relay.account(ownerId);
  const transport = new TransportService({ account, store, dataDir, now: () => clock.value, retryBaseMs: 50, syncIntervalMs: 60_000 });
  const starts: DeviceNode['starts'] = [];
  let runSequence = 0;
  const listeners = new Set<(event: Parameters<DeviceNode['emitProgress']>[0]) => void>();
  const emitProgress: DeviceNode['emitProgress'] = (event) => { for (const listener of listeners) listener(event); };
  const workspace: RemoteExecutionWorkspace = {
    isUnpublishedWork: async () => true,
    validateDestinationCheckpoint: async () => undefined,
    subscribeSession: (_sessionId, listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const runtime: RemoteExecutionRuntime = {
    start: (startedSessionId, content) => {
      runSequence += 1;
      const runId = `injected-no-provider-run-${suffix}-${runSequence}`;
      starts.push({ sessionId: startedSessionId, content, runId });
      return runId;
    },
    isActive: () => false,
  };
  const alternatives = suffix === 'a' ? [{
    sessionId: 'local-candidate-fixture', provider: 'claude' as const, model: 'fixture-model', eligible: true, state: 'provider-unavailable' as const,
  }] : [];

  return {
    ownerId, suffix, root: deviceRoot, dataDir, databasePath, account, store, transport, execution: null,
    sessionId, projectId, taskId, task2Id, starts, emitProgress, quota: { state: 'unknown', observedAt: null, reason: 'Fixture does not probe a provider.' }, alternatives,
    workspace, runtime, listeners,
  };
}

function createExecution(node: DeviceNode): RemoteExecutionService {
  const providers: RemoteExecutionProviders = {
    localAlternatives: async () => node.alternatives,
    quotaForSession: async () => node.quota,
  };
  const account: RemoteExecutionAccount = {
    withAuthenticatedClient: (work) => node.account.withAuthenticatedClient((client, user) => work(client as unknown as AuthenticatedClient, user)),
  };
  return new RemoteExecutionService({
    store: node.store, account, transport: executionTransport(node.transport), runtime: node.runtime,
    workspace: node.workspace, providers, changed: () => undefined,
  });
}

function executionTransport(transport: TransportService) {
  return {
    snapshot: (teamId?: string) => {
      const snapshot = transport.snapshot(teamId);
      return { localDeviceId: snapshot.deviceId, devices: snapshot.devices.map((device) => ({
        id: device.id, teamId: device.teamId, ownerId: device.ownerId, revokedAt: device.revokedAt,
        online: device.status === 'online',
        linked: snapshot.links.some((link) => link.deviceId === snapshot.deviceId && link.peerDeviceId === device.id && link.mutual),
      })) };
    },
    send: (input: { teamId: string; toDeviceId: string; kind: string; payload: unknown; idempotencyKey: string }) => transport.send(input),
    onMessage: (handler: (envelope: AuthenticatedEnvelope) => Promise<void>) => transport.onMessage(handler),
  };
}

async function makePair(): Promise<Pair> {
  const root = mkdtempSync(path.join(tmpdir(), 'mingle-two-device-acceptance-'));
  const relay = new AuthenticatedLocalRelay();
  const clock = { value: Date.now() };
  relay.setClock(() => clock.value);
  relay.addTeam(TEAM_ID, [OWNER_A, OWNER_B], SHARED_PROJECT_ID);
  const a = makeNode(root, relay, clock, OWNER_A, 'a');
  const b = makeNode(root, relay, clock, OWNER_B, 'b');
  const pair: Pair = { root, relay, clock, a, b, deviceAId: '', deviceBId: '' };
  fixtures.push(pair);

  const deviceA = await a.transport.register({ teamId: TEAM_ID, name: 'Disposable device A' });
  const deviceB = await b.transport.register({ teamId: TEAM_ID, name: 'Disposable device B' });
  pair.deviceAId = deviceA.id;
  pair.deviceBId = deviceB.id;
  await a.transport.link({ teamId: TEAM_ID, deviceId: deviceB.id, fingerprint: deviceB.fingerprint });
  await expect(a.transport.send({ teamId: TEAM_ID, toDeviceId: deviceB.id, kind: 'collaboration.message', payload: { text: 'before mutual link' }, idempotencyKey: 'pre-mutual-link' }))
    .rejects.toMatchObject({ status: 403 });
  await b.transport.link({ teamId: TEAM_ID, deviceId: deviceA.id, fingerprint: deviceA.fingerprint });
  await Promise.all([a.transport.sync(), b.transport.sync()]);
  a.execution = createExecution(a);
  b.execution = createExecution(b);
  await Promise.all([a.transport.sync(), b.transport.sync()]);
  return pair;
}

async function closeNode(node: DeviceNode): Promise<void> {
  if (node.execution) {
    await node.execution.close();
    node.execution = null;
  }
  await node.transport.close();
  node.store.close();
}

function seedRecoveryEvidence(node: DeviceNode): void {
  const now = new Date().toISOString();
  const session = node.store.getSession(node.sessionId)!;
  const task = node.store.getTask(node.taskId)!;
  const otherTask = node.store.getTask(node.task2Id)!;
  const userMessage = node.store.insertMessage({ sessionId: node.sessionId, role: 'user', content: 'Continue the disposable acceptance task.' });
  const runId = `failed-fixture-run-${node.suffix}`;
  node.store.insertRun({ id: runId, sessionId: session.id, userMessageId: userMessage.id, provider: session.provider, model: session.model, startedAt: now });
  node.store.finishRun(runId, 'failed', 1, now);
  node.store.insertProviderFailure(node.sessionId, runId, {
    id: `failure-${node.suffix}`, sessionId: node.sessionId, runId, actor: 'session', kind: 'provider_unavailable',
    provider: session.provider, retryable: true, safeToRetry: false, outcomeUnknown: false, dispatchState: 'not-dispatched',
    continuationSafety: 'safe', message: 'Injected unavailable runtime boundary; no provider was contacted.', occurredAt: now,
  }, now);
  node.store.insertRecoveryCheckpoint({
    id: `checkpoint-${node.suffix}`, version: 1, sessionId: node.sessionId, runId, reason: 'two-device acceptance fixture',
    capturedAt: now, objective: 'Verify encrypted remote owner consent and at-most-once dispatch.',
    tasks: [task, otherTask].map((entry) => ({ id: entry.id, title: entry.title, description: entry.description,
      acceptanceCriteria: entry.acceptanceCriteria, status: entry.status })),
    worktree: { path: session.worktreePath, branch: session.branch, head: 'a'.repeat(40), dirtyPaths: [], dirtyPathsTruncated: false,
      isRepository: true, statusKnown: true },
    artifacts: [], pendingApprovals: [], errors: [], uncertainTools: [], notices: ['Example acceptance fixture; no source files are transferred.'],
  });
}

async function waitFor(check: () => boolean, explanation: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${explanation}.`);
}

function rawEnvelope(relay: AuthenticatedLocalRelay, kind: string, recipientId: string): AcceptanceEnvelope | undefined {
  return relay.envelopes.find((envelope) => envelope.kind === kind && envelope.to_device_id === recipientId);
}

describe('two-device distributed workspace acceptance (local relay fixture)', () => {
  it('composes encrypted transport, collaboration, exact receiving-owner consent, one-time dispatch and shared results', async () => {
    const pair = await makePair();
    const { a, b, relay } = pair;
    seedRecoveryEvidence(a);

    expect(a.transport.snapshot(TEAM_ID).links).toContainEqual(expect.objectContaining({ mutual: true, peerDeviceId: pair.deviceBId }));
    expect(b.transport.snapshot(TEAM_ID).links).toContainEqual(expect.objectContaining({ mutual: true, peerDeviceId: pair.deviceAId }));
    expect((await b.execution!.bindProject({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, localProjectId: b.projectId })).ownerId).toBe(OWNER_B);
    await a.execution!.bindProject({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, localProjectId: a.projectId });

    // The execution listener is registered before the Git/command façade handlers on this transport.
    relay.projects.push({ id: SECOND_SHARED_PROJECT_ID, team_id: TEAM_ID });
    await a.execution!.bindProject({ teamId: TEAM_ID, sharedProjectId: SECOND_SHARED_PROJECT_ID, localProjectId: a.projectId });
    const routedKinds: string[] = [];
    const unsubscribeRoutedKinds = b.transport.onMessage((message) => {
      if (message.kind.startsWith('git.') || message.kind.startsWith('command.')) routedKinds.push(message.kind);
    });
    await b.transport.sync();
    await a.transport.send({ teamId: TEAM_ID, toDeviceId: pair.deviceBId, kind: 'git.offer', payload: { fixture: true }, idempotencyKey: 'acceptance-git-dispatch' });
    await b.transport.sync();
    await a.transport.send({ teamId: TEAM_ID, toDeviceId: pair.deviceBId, kind: 'command.request', payload: { fixture: true }, idempotencyKey: 'acceptance-command-dispatch' });
    await b.transport.sync();
    unsubscribeRoutedKinds();
    expect(routedKinds).toHaveLength(2);
    expect(routedKinds).toEqual(expect.arrayContaining(['git.offer', 'command.request']));

    const [agent] = await b.execution!.publishAgents({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, sessionIds: [b.sessionId] });
    expect(agent).toMatchObject({ ownerId: OWNER_B, deviceId: pair.deviceBId, presence: 'idle', quotaState: 'unknown', quotaKnown: false });
    const publishedCiphertext = structuredClone(relay.envelopes.find((envelope) => envelope.kind === 'execution.agents')!);
    await a.transport.sync();
    expect((await a.execution!.snapshot(TEAM_ID)).agents).toContainEqual(expect.objectContaining({ id: agent!.id, ownerId: OWNER_B }));
    expect(publishedCiphertext.ciphertext).not.toContain(agent!.name);

    const envelopesBeforeOversize = relay.envelopes.length;
    expect(() => a.transport.send({ teamId: TEAM_ID, toDeviceId: pair.deviceBId, kind: 'collaboration.message',
      payload: { blob: 'x'.repeat(256 * 1024) }, idempotencyKey: 'acceptance-oversized-payload' })).toThrow(expect.objectContaining({ status: 413 }));
    expect(relay.envelopes).toHaveLength(envelopesBeforeOversize);

    const sentMessage = await a.execution!.sendMessage({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID,
      content: 'An encrypted cross-device collaboration message.', taskId: a.taskId, dependsOn: ['task-base-a'], idempotencyKey: 'acceptance-message-a' });
    expect((await a.execution!.sendMessage({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID,
      content: sentMessage.content, taskId: a.taskId, dependsOn: ['task-base-a'], idempotencyKey: 'acceptance-message-a' })).id).toBe(sentMessage.id);
    await expect(a.execution!.sendMessage({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID,
      content: 'Changed content with the same idempotency key.', taskId: a.taskId, dependsOn: ['task-base-a'], idempotencyKey: 'acceptance-message-a' }))
      .rejects.toThrow(/different message/i);
    await expect(a.execution!.sendMessage({ teamId: TEAM_ID, sharedProjectId: SECOND_SHARED_PROJECT_ID,
      content: sentMessage.content, taskId: a.taskId, dependsOn: ['task-base-a'], idempotencyKey: 'acceptance-message-a' }))
      .rejects.toThrow(/different message/i);
    const sharedTask = await a.execution!.publishTask({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, taskId: a.taskId });
    await b.transport.sync();
    const bSnapshot = await b.execution!.snapshot(TEAM_ID);
    expect(bSnapshot.messages).toContainEqual(expect.objectContaining({ id: sentMessage.id, ownerId: OWNER_A, deviceId: pair.deviceAId, content: sentMessage.content }));
    expect(bSnapshot.tasks).toContainEqual(expect.objectContaining({ id: sharedTask.id, ownerId: OWNER_A, dependsOn: ['task-base-a'] }));
    const reply = await b.execution!.sendMessage({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID,
      content: 'Reply from the receiving owner.', idempotencyKey: 'acceptance-message-b' });
    await a.transport.sync();
    expect((await a.execution!.snapshot(TEAM_ID)).messages).toContainEqual(expect.objectContaining({ id: reply.id, ownerId: OWNER_B }));

    const fallback = await a.execution!.suggestFallback({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID, sourceSessionId: a.sessionId, taskId: a.taskId });
    expect(fallback.eligible).toBe(false);
    expect(fallback.candidates).toEqual([]); // Unknown destination quota never becomes a suggestion.

    const rejectedRequest = await a.execution!.requestDelegation({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID,
      sourceSessionId: a.sessionId, taskId: a.taskId, agentId: agent!.id, mode: 'provider-failure',
      content: 'First request will be explicitly rejected.', allowUnverifiedTarget: true, idempotencyKey: 'acceptance-reject-request' });
    const requestCiphertext = rawEnvelope(relay, 'execution.request', pair.deviceBId)!;
    expect(requestCiphertext.ciphertext).not.toContain(rejectedRequest.content);
    expect(requestCiphertext.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    await expect(a.execution!.decide({ requestId: rejectedRequest.id, expectedDigest: rejectedRequest.digest,
      decision: 'approved', allowProviderSpend: true, allowUnverifiedQuota: true })).rejects.toMatchObject({ status: 403 });
    await b.transport.sync();
    const denied = await b.execution!.decide({ requestId: rejectedRequest.id, expectedDigest: rejectedRequest.digest,
      decision: 'denied', allowProviderSpend: false, allowUnverifiedQuota: false, shareProgress: true });
    expect(denied.state).toBe('denied');
    expect(b.starts).toHaveLength(0);
    await a.transport.sync();
    expect((await a.execution!.snapshot(TEAM_ID)).requests.find((request) => request.id === rejectedRequest.id)?.state).toBe('denied');

    const request = await a.execution!.requestDelegation({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID,
      sourceSessionId: a.sessionId, taskId: a.task2Id, agentId: agent!.id, mode: 'provider-failure',
      content: 'Continue this second disposable recovery task.', maxSpendUsd: 1.25, allowUnverifiedTarget: true,
      idempotencyKey: 'acceptance-approved-request' });
    const requestEnvelope = rawEnvelope(relay, 'execution.request', pair.deviceBId)!;
    const duplicateRequestEnvelope = structuredClone(requestEnvelope);
    expect(requestEnvelope).toBeDefined();
    await b.transport.sync();
    const beforeDecision = (await b.execution!.snapshot(TEAM_ID)).requests.find((entry) => entry.id === request.id)!;
    expect(beforeDecision).toMatchObject({ state: 'awaiting-approval', digest: request.digest, maxSpendUsd: 1.25, allowUnverifiedTarget: true });

    await expect(b.execution!.decide({ requestId: request.id, expectedDigest: '0'.repeat(64), decision: 'approved',
      allowProviderSpend: true, allowUnverifiedQuota: true, shareProgress: true })).rejects.toThrow(/displayed request changed/i);
    await expect(b.execution!.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved',
      allowProviderSpend: false, allowUnverifiedQuota: true, shareProgress: true })).rejects.toThrow(/provider-spend consent/i);
    await expect(b.execution!.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved',
      allowProviderSpend: true, allowUnverifiedQuota: false, shareProgress: true })).rejects.toThrow(/unknown/i);
    expect((await b.execution!.snapshot(TEAM_ID)).approvals.filter((approval) => approval.requestId === request.id)).toEqual([]);
    expect(b.starts).toHaveLength(0);

    const dispatched = await b.execution!.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved',
      allowProviderSpend: true, allowUnverifiedQuota: true, shareProgress: true });
    expect(dispatched).toMatchObject({ state: 'dispatched', runId: 'injected-no-provider-run-b-1' });
    expect(b.starts).toHaveLength(1);
    expect(b.starts[0]).toMatchObject({ sessionId: b.sessionId });
    expect(b.starts[0]!.content).toContain('Informational cost estimate: USD 1.25');
    expect((await b.execution!.snapshot(TEAM_ID)).approvals).toContainEqual(expect.objectContaining({
      requestId: request.id, ownerId: OWNER_B, deviceId: pair.deviceBId, digest: request.digest,
      allowProviderSpend: true, allowUnverifiedQuota: true, shareProgress: true, decision: 'approved',
    }));
    await expect(b.execution!.decide({ requestId: request.id, expectedDigest: request.digest, decision: 'approved',
      allowProviderSpend: true, allowUnverifiedQuota: true, shareProgress: true })).rejects.toThrow(/no longer awaiting/i);
    await a.transport.sync();
    expect((await a.execution!.snapshot(TEAM_ID)).requests.find((entry) => entry.id === request.id)?.state).toBe('dispatched');

    const progressSecret = 'sk-ant-api03-acceptance-secret-value';
    b.emitProgress({ runId: dispatched.runId!, kind: 'progress', status: 'running', summary: `Progress fixture ${progressSecret}` });
    await waitFor(() => relay.envelopes.some((envelope) => envelope.kind === 'collaboration.message' && envelope.to_device_id === pair.deviceAId), 'encrypted shared progress');
    b.emitProgress({ runId: dispatched.runId!, kind: 'result', status: 'completed', terminal: true, summary: 'Disposable run completed.' });
    await waitFor(() => (b.store.db.prepare("SELECT COUNT(*) AS n FROM mingle_remote_requests WHERE id = ? AND state = 'completed'").get(request.id) as { n: number }).n === 1,
      'durable completed execution result');
    await waitFor(() => (b.store.db.prepare("SELECT COUNT(*) AS n FROM mingle_remote_messages WHERE task_id = ? AND direction = 'outbound' AND kind IN ('progress','result')").get(a.task2Id) as { n: number }).n === 2,
      'shared progress and result records');
    await waitFor(() => b.transport.snapshot(TEAM_ID).outbox.filter((item) => item.kind === 'collaboration.message' && item.status === 'delivered').length >= 3,
      'delivered progress and result envelopes');
    await waitFor(() => b.transport.snapshot(TEAM_ID).outbox.filter((item) => item.kind === 'execution.status' && item.status === 'delivered').length >= 3,
      'delivered denied, dispatched, and completed statuses');
    await a.transport.sync();
    const sourceSnapshot = await a.execution!.snapshot(TEAM_ID);
    expect(sourceSnapshot.requests.find((entry) => entry.id === request.id)?.state).toBe('completed');
    const idempotentCompletionRetry = await a.execution!.requestDelegation({ teamId: TEAM_ID, sharedProjectId: SHARED_PROJECT_ID,
      sourceSessionId: a.sessionId, taskId: a.task2Id, agentId: agent!.id, mode: 'provider-failure',
      content: 'Continue this second disposable recovery task.', maxSpendUsd: 1.25, allowUnverifiedTarget: true,
      idempotencyKey: 'acceptance-approved-request' });
    expect(idempotentCompletionRetry).toMatchObject({ id: request.id, state: 'completed', runId: dispatched.runId });
    relay.envelopes.push(duplicateRequestEnvelope);
    await b.transport.sync();
    expect(b.starts).toHaveLength(1);
    expect((await b.execution!.snapshot(TEAM_ID)).requests.find((entry) => entry.id === request.id)?.state).toBe('completed');
    const sharedProgress = sourceSnapshot.messages.filter((message) => message.taskId === a.task2Id && ['progress', 'result'].includes(message.kind));
    expect(sharedProgress).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'progress', content: `Progress fixture [redacted]`, ownerId: OWNER_B }),
      expect.objectContaining({ kind: 'result', content: 'Disposable run completed.', ownerId: OWNER_B }),
    ]));
    expect(JSON.stringify(relay.envelopes)).not.toContain(progressSecret);

    // The runtime is intentionally a recording boundary. No provider executable or paid inference runs here.
    expect(b.starts).toHaveLength(1);
  });

  it('retries and persists across receiver restart, honors relay receive ordering, and rejects tamper/revoked trust', async () => {
    const pair = await makePair();
    const { a, b, relay, clock } = pair;
    await a.execution!.close();
    a.execution = null;
    await b.execution!.close();
    b.execution = null;
    const received: Array<{ id: string; value: number }> = [];
    let unsubscribe = b.transport.onMessage((message) => {
      const payload = message.payload as { value?: number };
      if (typeof payload.value === 'number') received.push({ id: message.id, value: payload.value });
    });

    relay.failEnvelopeWrites = 1;
    const delayedId = await a.transport.send({ teamId: TEAM_ID, toDeviceId: pair.deviceBId, kind: 'collaboration.message',
      payload: { value: 0 }, idempotencyKey: 'acceptance-cloud-retry' });
    expect(a.transport.snapshot(TEAM_ID).outbox[0]).toMatchObject({ id: delayedId, status: 'queued', attempts: 1 });
    expect(a.transport.snapshot(TEAM_ID).status).toBe('offline');
    a.account.setOwner(OWNER_B);
    await a.transport.sync();
    expect(a.transport.snapshot(TEAM_ID)).toMatchObject({ deviceId: null, status: 'unregistered' });
    expect(relay.envelopes.some((envelope) => envelope.id === delayedId)).toBe(false);
    a.account.setOwner(OWNER_A);
    clock.value += 100;
    await a.transport.sync();
    expect(a.transport.snapshot(TEAM_ID).outbox[0]).toMatchObject({ id: delayedId, status: 'delivered', attempts: 2 });

    const firstId = await a.transport.send({ teamId: TEAM_ID, toDeviceId: pair.deviceBId, kind: 'collaboration.message', payload: { value: 1 }, idempotencyKey: 'acceptance-order-1' });
    clock.value += 1_000;
    const secondId = await a.transport.send({ teamId: TEAM_ID, toDeviceId: pair.deviceBId, kind: 'collaboration.message', payload: { value: 2 }, idempotencyKey: 'acceptance-order-2' });
    const secondCloud = relay.envelopes.find((envelope) => envelope.id === secondId)!;
    const firstCloud = relay.envelopes.find((envelope) => envelope.id === firstId)!;
    secondCloud.received_at = new Date(clock.value + 500).toISOString();
    firstCloud.received_at = new Date(clock.value + 100).toISOString();
    const replayFirst = structuredClone(firstCloud);
    await b.transport.sync();
    expect(received.map((item) => item.id)).toEqual([delayedId, firstId, secondId]);
    relay.envelopes.push(replayFirst); // Model an acknowledgement lost after durable receipt.
    await b.transport.sync();
    expect(received.filter((item) => item.id === firstId)).toHaveLength(1);

    const tamperedId = await a.transport.send({ teamId: TEAM_ID, toDeviceId: pair.deviceBId, kind: 'collaboration.message',
      payload: { value: 99, secret: 'must-not-arrive' }, idempotencyKey: 'acceptance-tamper' });
    const tampered = relay.envelopes.find((envelope) => envelope.id === tamperedId)!;
    tampered.ciphertext = Buffer.from('tampered plaintext').toString('base64');
    await b.transport.sync();
    expect(received.some((item) => item.id === tamperedId)).toBe(false);
    expect(relay.envelopes.some((envelope) => envelope.id === tamperedId)).toBe(false);

    // Pull to durable local inbox with no execution handler, then restart the receiver before dispatch.
    unsubscribe();
    const restartId = await a.transport.send({ teamId: TEAM_ID, toDeviceId: pair.deviceBId, kind: 'collaboration.message',
      payload: { value: 3 }, idempotencyKey: 'acceptance-restart-pending' });
    const restartEnvelope = structuredClone(relay.envelopes.find((envelope) => envelope.id === restartId)!);
    await b.transport.sync();
    expect(b.store.db.prepare('SELECT status FROM mingle_transport_inbox WHERE id = ?').get(restartId)).toMatchObject({ status: 'pending' });
    relay.envelopes.push(restartEnvelope);
    await closeNode(b);
    const restarted = reopenNode(pair, 'b');
    pair.b = restarted;
    const afterRestart: unknown[] = [];
    unsubscribe = restarted.transport.onMessage((message) => { afterRestart.push(message.id); });
    await restarted.transport.sync();
    expect(afterRestart).toEqual([restartId]);
    expect(restarted.store.db.prepare('SELECT status FROM mingle_transport_inbox WHERE id = ?').get(restartId)).toMatchObject({ status: 'handled' });
    expect(relay.envelopes.some((envelope) => envelope.id === restartId)).toBe(false);

    // A message durably received while linked cannot be dispatched after the recipient removes its pin.
    unsubscribe();
    const staleLinkId = await a.transport.send({ teamId: TEAM_ID, toDeviceId: pair.deviceBId, kind: 'collaboration.message',
      payload: { value: 4 }, idempotencyKey: 'acceptance-stale-link' });
    await restarted.transport.sync();
    expect(restarted.store.db.prepare('SELECT status FROM mingle_transport_inbox WHERE id = ?').get(staleLinkId)).toMatchObject({ status: 'pending' });
    await restarted.transport.revoke({ teamId: TEAM_ID, deviceId: pair.deviceAId });
    let staleDelivered = 0;
    unsubscribe = restarted.transport.onMessage(() => { staleDelivered += 1; });
    await restarted.transport.sync();
    expect(staleDelivered).toBe(0);
    expect(restarted.store.db.prepare('SELECT status FROM mingle_transport_inbox WHERE id = ?').get(staleLinkId)).toMatchObject({ status: 'rejected' });

    // Restore reciprocal trust, persist another envelope locally, then revoke the sender's membership.
    await a.transport.link({ teamId: TEAM_ID, deviceId: pair.deviceBId, fingerprint: relay.devices.find((device) => device.id === pair.deviceBId)!.fingerprint });
    await restarted.transport.link({ teamId: TEAM_ID, deviceId: pair.deviceAId, fingerprint: relay.devices.find((device) => device.id === pair.deviceAId)!.fingerprint });
    await Promise.all([a.transport.sync(), restarted.transport.sync()]);
    unsubscribe();
    const revokedMemberId = await a.transport.send({ teamId: TEAM_ID, toDeviceId: pair.deviceBId, kind: 'collaboration.message',
      payload: { value: 5 }, idempotencyKey: 'acceptance-revoked-member' });
    await restarted.transport.sync();
    expect(restarted.store.db.prepare('SELECT status FROM mingle_transport_inbox WHERE id = ?').get(revokedMemberId)).toMatchObject({ status: 'pending' });
    relay.revokeMember(TEAM_ID, OWNER_A);
    let revokedDelivered = 0;
    unsubscribe = restarted.transport.onMessage(() => { revokedDelivered += 1; });
    await restarted.transport.sync();
    expect(revokedDelivered).toBe(0);
    expect(restarted.store.db.prepare('SELECT status FROM mingle_transport_inbox WHERE id = ?').get(revokedMemberId)).toMatchObject({ status: 'rejected' });
  });
});

function reopenNode(pair: Pair, suffix: 'a' | 'b'): DeviceNode {
  const old = pair[suffix];
  const db = openDatabase(old.databasePath);
  const store = new Store(db);
  const transport = new TransportService({ account: old.account, store, dataDir: old.dataDir,
    now: () => pair.clock.value, retryBaseMs: 50, syncIntervalMs: 60_000 });
  return { ...old, store, transport, execution: null, starts: old.starts, emitProgress: old.emitProgress };
}

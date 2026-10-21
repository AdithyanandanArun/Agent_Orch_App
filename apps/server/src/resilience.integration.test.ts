import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentConfiguration, ContextCompactionResult, GroupSnapshot, ProviderInfo } from '@mingle/contracts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, SCHEMA_VERSION } from './db.ts';
import { EXAMPLE_ARTIFACT_PATH, EXAMPLE_CLIENT_SESSION_ID, EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { ProviderError, type DispatchAwareOptions, type DispatchState } from './providers/common.js';
import { deferred, FakeProviders, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
const boot = async (options: Parameters<typeof startTestApp>[0] = {}) => {
  const app = await startTestApp(options);
  apps.push(app);
  return app;
};
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.cleanup();
});

const session = async (t: TestApp) => (await t.api('GET', '/api/bootstrap')).json.sessions.find((row: any) => row.id === EXAMPLE_CONTRACT_SESSION_ID);
const messages = async (t: TestApp) => (await t.api('GET', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`)).json as any[];
const claudeConfig = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', serviceTier: 'standard' } as const;
const codexConfig = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', policy: 'supervised', serviceTier: 'standard' } as const;
const codexFullAccessConfig = { ...codexConfig, policy: 'full-access' } as const;

async function configureQuotaFallback(t: TestApp, groupId: string, sourceId: string, targetId: string): Promise<void> {
  const response = await t.api('PATCH', `/api/groups/${groupId}`, {
    recoveryPolicy: {
      automaticFallback: true, allowUnverifiedQuotaFallback: true,
      leadFallbackMemberId: targetId, workerFallbacks: { [sourceId]: targetId },
    },
  });
  expect(response.status, JSON.stringify(response.json)).toBe(200);
}

async function createGroup(
  t: TestApp, mode: 'cowork' | 'current-leads' | 'orchestrated', agentConfiguration: AgentConfiguration = claudeConfig,
  orchestratorConfiguration: AgentConfiguration = claudeConfig,
): Promise<GroupSnapshot> {
  await t.api('POST', '/api/providers/refresh', {});
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CLIENT_SESSION_ID, mode,
    agent: { handle: 'backup', isolated: true, configuration: agentConfiguration },
    ...(mode === 'orchestrated' ? { orchestrator: orchestratorConfiguration } : {}),
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return created.json;
}

async function bootWithCodexAndClaude(): Promise<TestApp> {
  const fake = new FakeProviders();
  fake.detectProviders = async () => [
    { id: 'codex', name: 'Codex', available: true, version: 'fake', executable: '/fake/codex', reason: null, policies: ['supervised', 'full-access'], models: [{ id: 'gpt-6.1-sol', name: 'Codex fake', policies: ['supervised', 'full-access'] }] },
    { id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null, models: [{ id: 'claude-sonnet-5-5', name: 'Claude fake' }] },
  ] satisfies ProviderInfo[];
  return boot({ fake });
}

async function failCurrentLead(t: TestApp, mode: 'cowork' | 'current-leads' | 'orchestrated' = 'current-leads') {
  const initial = await createGroup(t, mode);
  t.fake.script = async () => {
    throw new ProviderError('Account quota exhausted.', { providerCode: 'usageLimitExceeded', outcomeKnown: true });
  };
  expect((await t.api('POST', `/api/groups/${initial.group.id}/messages`, { content: 'Implement a bounded recovery fixture.' })).status).toBe(202);
  const delivery = await waitFor(() => t.app.groups.get(initial.group.id).deliveries.find((row) => row.status === 'failed'));
  await waitFor(() => t.app.runtime.activeCount() === 0);
  return { initial, delivery, snapshot: t.app.groups.get(initial.group.id) };
}

async function captureAndAck(t: TestApp, groupId: string, deliveryId: string): Promise<string> {
  const paused = await t.api('POST', `/api/groups/${groupId}/recovery`, {
    action: 'pause-for-human', deliveryId, reason: 'Review the failed delivery before recovery.',
    idempotencyKey: `pause-for-human-${deliveryId}`,
  });
  expect(paused.status, JSON.stringify(paused.json)).toBe(200);

  const groupCheckpointId = await waitFor(() => t.app.groups.get(groupId).group.recoveryState?.pendingCheckpointId);
  expect(groupCheckpointId).toMatch(/^gcp_/);
  const acknowledged = await t.api('POST', `/api/groups/${groupId}/recovery`, {
    action: 'acknowledge-checkpoint', checkpointId: groupCheckpointId,
    idempotencyKey: `acknowledge-${deliveryId}`,
  });
  expect(acknowledged.status, JSON.stringify(acknowledged.json)).toBe(200);
  return groupCheckpointId;
}

function result(sessionId: string, provider: ContextCompactionResult['provider'], status: ContextCompactionResult['status'] = 'completed'): ContextCompactionResult {
  return {
    sessionId, provider, status, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    checkpointId: null, message: status === 'completed' ? 'Native compaction completed.' : 'Native compaction was not performed.',
    error: status === 'failed' ? 'interrupted' : null,
  };
}

function installCompactor(t: TestApp, compact: NonNullable<ReturnType<typeof t.fake.createAdapter>['compact']>): void {
  const create = t.fake.createAdapter.bind(t.fake);
  t.fake.createAdapter = (provider) => ({ ...create(provider), compact });
}

async function createNativeHistory(t: TestApp): Promise<any[]> {
  t.fake.script = async (_options, emit) => {
    emit({ type: 'session', providerSessionId: 'native-session-stable' });
    emit({ type: 'text', text: 'Existing native conversation history.' });
  };
  expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Create history' })).status).toBe(202);
  await waitFor(async () => (await session(t)).status === 'idle' && t.app.runtime.activeCount() === 0);
  expect((await session(t)).providerSessionId).toBe('native-session-stable');
  return messages(t);
}

describe('durable resilience API', () => {
  it('upgrades an original schema v11 database with resolved_at and recovery successor uniqueness', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'mingle-schema11-'));
    const file = path.join(directory, 'state.sqlite');
    try {
      const current = openDatabase(file);
      expect(SCHEMA_VERSION).toBe(12);
      current.exec('DROP TABLE group_recovery_deliveries; ALTER TABLE session_failures DROP COLUMN resolved_at; PRAGMA user_version = 11;');
      current.close();

      const upgraded = openDatabase(file);
      const failureColumns = upgraded.prepare('PRAGMA table_info(session_failures)').all() as { name: string }[];
      const deliveryTable = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'group_recovery_deliveries'").get();
      const version = upgraded.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(12);
      expect(failureColumns.some((column) => column.name === 'resolved_at')).toBe(true);
      expect(deliveryTable).toBeDefined();
      upgraded.exec('PRAGMA foreign_keys = OFF');
      const insert = upgraded.prepare('INSERT INTO group_recovery_deliveries(source_delivery_id, successor_delivery_id, created_at) VALUES (?, ?, ?)');
      insert.run('source-1', 'successor-1', '2026-01-01T00:00:00.000Z');
      expect(() => insert.run('source-2', 'successor-1', '2026-01-01T00:00:01.000Z')).toThrow(/UNIQUE/i);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists real classified output-truncation failure and never reports the run as completed', async () => {
    const t = await boot();
    t.fake.script = async () => {
      throw new ProviderError('The provider stopped at its output token limit.', {
        providerCode: 'outputLengthExceeded', outcomeKnown: true,
      });
    };
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Generate a long answer' })).status).toBe(202);
    await waitFor(async () => (await session(t)).status === 'error' && t.app.runtime.activeCount() === 0);

    const history = await t.api('GET', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/recovery`);
    const run = (await t.api('GET', '/api/bootstrap')).json.runs.find((row: any) => row.sessionId === EXAMPLE_CONTRACT_SESSION_ID);
    expect(history.json.failure).toMatchObject({ kind: 'output_truncated', outcomeUnknown: false, continuationSafety: 'unknown' });
    expect(run.status).toBe('failed');
    expect((await session(t)).status).toBe('error');
  });

  it('persists a metadata-only session checkpoint with redacted objective and dirty-path references', async () => {
    const t = await boot();
    const secret = 'sk-ant-api03-checkpoint-secret-value-123456';
    t.fake.script = async () => undefined;
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: `Continue with ${secret}` })).status).toBe(202);
    await waitFor(async () => (await session(t)).status === 'idle' && t.app.runtime.activeCount() === 0);
    const nativeSession = await session(t);
    const privateSource = 'this full file body must never enter checkpoint JSON';
    writeFileSync(path.join(nativeSession.worktreePath, 'checkpoint-private.txt'), privateSource);

    const captured = await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/checkpoints`, { reason: 'Before the next explicit action' });
    expect(captured.status).toBe(201);
    expect(captured.json).toMatchObject({ sessionId: EXAMPLE_CONTRACT_SESSION_ID, reason: 'Before the next explicit action' });
    expect(captured.json.objective).toContain('[redacted]');
    expect(captured.json.worktree.dirtyPaths).toContain('checkpoint-private.txt');
    expect(JSON.stringify(captured.json)).not.toContain(secret);
    expect(JSON.stringify(captured.json)).not.toContain(privateSource);
    expect((await t.api('GET', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/recovery`)).json.checkpoint.id).toBe(captured.json.id);
  });

  it('reserves the active lock before checkpoint capture awaits and preserves native session history', async () => {
    const t = await boot();
    const before = await createNativeHistory(t);
    const nativeSession = await session(t);
    const captureEntered = deferred<void>();
    const captureGate = deferred<void>();
    const capture = t.app.recovery.capture.bind(t.app.recovery);
    vi.spyOn(t.app.recovery, 'capture').mockImplementation(async (sessionId, reason, runId) => {
      captureEntered.resolve();
      await captureGate.promise;
      return capture(sessionId, reason, runId);
    });
    const compactEntered = deferred<void>();
    const compactGate = deferred<ContextCompactionResult>();
    installCompactor(t, async ({ session: nativeSession }) => {
      compactEntered.resolve();
      return compactGate.promise.then((value) => ({ ...value, sessionId: nativeSession.id, provider: nativeSession.provider }));
    });

    const operation = t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/compact`, { operationId: 'compact-history-1' });
    await captureEntered.promise;
    expect(t.app.runtime.isActive(EXAMPLE_CONTRACT_SESSION_ID)).toBe(true);
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Must not race compaction' })).status).toBe(409);

    captureGate.resolve();
    await compactEntered.promise;
    compactGate.resolve(result(EXAMPLE_CONTRACT_SESSION_ID, nativeSession.provider));
    expect((await operation).json).toMatchObject({ status: 'completed', sessionId: EXAMPLE_CONTRACT_SESSION_ID, checkpointId: expect.any(String) });
    expect((await session(t)).providerSessionId).toBe('native-session-stable');
    expect(await messages(t)).toEqual(before);
  });

  it('does not call native compact when the durable pre-compaction checkpoint fails', async () => {
    const t = await boot();
    await createNativeHistory(t);
    const nativeCompact = vi.fn(async (options: Parameters<NonNullable<AgentAdapter['compact']>>[0]) => result(options.session.id, options.session.provider));
    installCompactor(t, nativeCompact);
    vi.spyOn(t.app.recovery, 'capture').mockRejectedValue(new Error('checkpoint unavailable'));

    const response = await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/compact`, { operationId: 'compact-no-checkpoint' });
    expect(response.json).toMatchObject({ status: 'failed', error: expect.stringContaining('checkpoint') });
    expect(nativeCompact).not.toHaveBeenCalled();
    expect((await session(t)).providerSessionId).toBe('native-session-stable');
  });

  it('keeps an interrupted, unresponsive native compaction locked until cleanup', async () => {
    const t = await boot();
    await createNativeHistory(t);
    let compactSignal: AbortSignal | undefined;
    const compactEntered = deferred<void>();
    const compactGate = deferred<ContextCompactionResult>();
    installCompactor(t, async ({ session: nativeSession, signal }) => {
      compactSignal = signal;
      compactEntered.resolve();
      const value = await compactGate.promise;
      return { ...value, sessionId: nativeSession.id, provider: nativeSession.provider };
    });

    const compactOperation = t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/compact`, { operationId: 'compact-cleanup-1' });
    await compactEntered.promise;
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/compact/interrupt`, { operationId: 'compact-cleanup-1' })).json).toMatchObject({ interrupted: true });
    await waitFor(() => compactSignal?.aborted === true);
    expect(t.app.runtime.activeCount()).toBe(1);
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'Wait for native cleanup' })).status).toBe(409);

    compactGate.resolve(result(EXAMPLE_CONTRACT_SESSION_ID, (await session(t)).provider));
    expect((await compactOperation).json).toMatchObject({ status: 'failed' });
    await waitFor(() => t.app.runtime.activeCount() === 0);
  });

  it('fences a stale compaction Stop after a new normal run starts', async () => {
    const t = await boot();
    await createNativeHistory(t);
    installCompactor(t, async ({ session: nativeSession }) => result(nativeSession.id, nativeSession.provider));
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/compact`, { operationId: 'compact-finished-1' })).json).toMatchObject({ status: 'completed' });

    const runGate = deferred<void>();
    t.fake.script = async (_options, emit) => {
      emit({ type: 'text', text: 'Next run is still active.' });
      await runGate.promise;
    };
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/messages`, { content: 'New normal run' })).status).toBe(202);
    await waitFor(() => t.fake.runs.length === 2 && t.app.runtime.isActive(EXAMPLE_CONTRACT_SESSION_ID));
    expect((await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/compact/interrupt`, { operationId: 'compact-finished-1' })).json).toMatchObject({ interrupted: false });
    expect(t.app.runtime.isActive(EXAMPLE_CONTRACT_SESSION_ID)).toBe(true);
    runGate.resolve();
    await waitFor(() => t.app.runtime.activeCount() === 0);
  });

  it('returns unsupported without changing provider history or adding fabricated summary text', async () => {
    const t = await boot();
    const before = await createNativeHistory(t);
    installCompactor(t, async ({ session: nativeSession }) => result(nativeSession.id, nativeSession.provider, 'unsupported'));

    const response = await t.api('POST', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}/compact`, { operationId: 'compact-unsupported-1' });
    expect(response.json).toMatchObject({ status: 'unsupported', sessionId: EXAMPLE_CONTRACT_SESSION_ID });
    expect((await session(t)).providerSessionId).toBe('native-session-stable');
    expect(await messages(t)).toEqual(before);
  });

  it('keeps terminal quota failures visible without automatically replaying or substituting a provider', async () => {
    const t = await boot();
    const { initial, delivery } = await failCurrentLead(t);
    const failedMember = initial.members.find((member) => member.id === delivery.memberId)!;
    const failure = (await t.api('GET', `/api/sessions/${failedMember.sessionId}/recovery`)).json.failure;
    expect(failure).toMatchObject({ kind: 'quota_exhausted', outcomeUnknown: false, continuationSafety: 'unknown' });
    expect(failure.quotaPool).toBeUndefined();
    expect(t.fake.runs).toHaveLength(1);
    expect(t.app.groups.get(initial.group.id).deliveries.filter((row) => row.status === 'queued' || row.status === 'running')).toHaveLength(0);
  });

  it('retries a pre-dispatch temporary rate limit once and links one historical successor', async () => {
    const t = await boot();
    const initial = await createGroup(t, 'current-leads');
    let attempts = 0;
    t.fake.script = async (options, emit) => {
      if (++attempts === 1) {
        (options as typeof options & DispatchAwareOptions).onDispatchState?.('not-dispatched');
        throw new ProviderError('Rate limit reached.', {
          code: 'rate_limit', providerCode: 'rate_limit_exceeded', statusCode: 429, retryAfterMs: 100, outcomeKnown: true,
        });
      }
      emit({ type: 'text', text: 'The single safe retry completed.' });
    };

    expect((await t.api('POST', `/api/groups/${initial.group.id}/messages`, { content: 'Retry only if dispatch never began.' })).status).toBe(202);
    await waitFor(() => t.fake.runs.length === 2 && t.app.runtime.activeCount() === 0);

    const snapshot = t.app.groups.get(initial.group.id);
    const original = snapshot.deliveries.find((row) => row.status === 'failed')!;
    const successor = snapshot.deliveries.find((row) => row.id === original.recoveredByDeliveryId);
    expect(attempts).toBe(2);
    expect(t.fake.runs).toHaveLength(2);
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.deliveries).toHaveLength(2);
    expect(original.recoveredByDeliveryId).toBeTruthy();
    expect(successor).toMatchObject({ status: 'completed', memberId: original.memberId, requestId: original.requestId });
    expect(snapshot.deliveries.filter((row) => row.status === 'queued' || row.status === 'running')).toHaveLength(0);
    expect(snapshot.deliveries.filter((row) => row.status === 'completed')).toHaveLength(1);
  });

  it('keeps an uncertain dispatched rate limit held and visible without automatic replay', async () => {
    const t = await boot();
    const initial = await createGroup(t, 'current-leads');
    const lead = initial.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    t.fake.script = async (options) => {
      (options as typeof options & DispatchAwareOptions).onDispatchState?.('unknown');
      throw new ProviderError('Rate limit reached after dispatch became uncertain.', {
        code: 'rate_limit', providerCode: 'rate_limit_exceeded', statusCode: 429, retryAfterMs: 100,
      });
    };

    expect((await t.api('POST', `/api/groups/${initial.group.id}/messages`, { content: 'Do not replay an uncertain provider side effect.' })).status).toBe(202);
    const failed = await waitFor(() => t.app.groups.get(initial.group.id).deliveries.find((row) => row.status === 'failed')
      && t.app.runtime.activeCount() === 0
      ? t.app.groups.get(initial.group.id).deliveries.find((row) => row.status === 'failed')
      : undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(t.fake.runs).toHaveLength(1);
    const failure = (await t.api('GET', `/api/sessions/${lead.sessionId}/recovery`)).json.failure;
    expect(failure).toMatchObject({
      kind: 'temporary_rate_limit', retryable: true, safeToRetry: false, outcomeUnknown: true, dispatchState: 'unknown',
    });
    const beforeCheckpoint = t.app.groups.get(initial.group.id);
    expect(beforeCheckpoint.deliveries.find((row) => row.id === failed.id)?.status).toBe('failed');
    expect(beforeCheckpoint.members.find((member) => member.id === lead.id)?.held).toBe(true);
    expect(beforeCheckpoint.deliveries.some((row) => row.recoveredByDeliveryId)).toBe(false);

    const paused = await t.api('POST', `/api/groups/${initial.group.id}/recovery`, {
      action: 'pause-for-human', deliveryId: failed.id, reason: 'Review the uncertain provider outcome before recovery.',
      idempotencyKey: `pause-uncertain-${failed.id}`,
    });
    expect(paused.status, JSON.stringify(paused.json)).toBe(200);
    const checkpointId = await waitFor(() => t.app.groups.get(initial.group.id).group.recoveryState?.pendingCheckpointId);
    expect(checkpointId).toMatch(/^gcp_/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(t.fake.runs).toHaveLength(1);
    expect(t.app.groups.get(initial.group.id).deliveries.find((row) => row.id === failed.id)?.recoveredByDeliveryId).toBeUndefined();
  });

  it('deduplicates retry by action key and refuses a second successor for a new key', async () => {
    const t = await boot();
    const { initial, delivery } = await failCurrentLead(t);
    const retryGate = deferred<void>();
    t.fake.script = async () => { await retryGate.promise; };
    const groupId = initial.group.id;
    const unacknowledged = await t.api('POST', `/api/groups/${groupId}/recovery`, {
      action: 'retry-delivery', deliveryId: delivery.id, idempotencyKey: 'retry-before-ack',
    });
    expect(unacknowledged.status).toBe(409);
    const checkpointId = await captureAndAck(t, groupId, delivery.id);
    const body = { action: 'retry-delivery', deliveryId: delivery.id, checkpointId, idempotencyKey: 'retry-once' };
    try {
      const first = await t.api('POST', `/api/groups/${groupId}/recovery`, body);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ action: 'retry-delivery', status: 'applied' });

      const duplicate = await t.api('POST', `/api/groups/${groupId}/recovery`, body);
      expect(duplicate.status).toBe(200);
      expect(duplicate.json).toMatchObject({ actionId: first.json.actionId, status: 'already-applied' });

      const differentKey = await t.api('POST', `/api/groups/${groupId}/recovery`, { ...body, idempotencyKey: 'retry-again' });
      expect([400, 409]).toContain(differentKey.status);
      const current = t.app.groups.get(initial.group.id);
      const superseded = current.deliveries.find((row) => row.id === delivery.id)!;
      expect(superseded.recoveredByDeliveryId).toBeTruthy();
      expect(current.deliveries.some((row) => row.id === superseded.recoveredByDeliveryId)).toBe(true);
      expect(t.fake.runs.length).toBeLessThanOrEqual(2);
    } finally {
      retryGate.resolve();
    }
  });

  it('rejects a session checkpoint as a group batch acknowledgement and advances only the named group checkpoint', async () => {
    const t = await boot();
    const { initial, delivery } = await failCurrentLead(t);
    const failedMember = initial.members.find((member) => member.id === delivery.memberId)!;
    const sessionCheckpoint = await t.api('POST', `/api/sessions/${failedMember.sessionId}/checkpoints`, { reason: 'Session context before recovery' });
    expect(sessionCheckpoint.status).toBe(201);
    expect(t.app.groups.get(initial.group.id).group.recoveryState?.pendingCheckpointId).toBeUndefined();
    const paused = await t.api('POST', `/api/groups/${initial.group.id}/recovery`, {
      action: 'pause-for-human', deliveryId: delivery.id, reason: 'Capture an explicit group recovery checkpoint.',
      idempotencyKey: 'pause-for-group-checkpoint',
    });
    expect(paused.status, JSON.stringify(paused.json)).toBe(200);
    const groupCheckpointId = await waitFor(() => t.app.groups.get(initial.group.id).group.recoveryState?.pendingCheckpointId);
    expect(groupCheckpointId).not.toBe(sessionCheckpoint.json.id);
    expect(groupCheckpointId).toMatch(/^gcp_/);

    const wrongNamespace = await t.api('POST', `/api/groups/${initial.group.id}/recovery`, {
      action: 'acknowledge-checkpoint', checkpointId: sessionCheckpoint.json.id, idempotencyKey: 'wrong-checkpoint-kind',
    });
    expect([400, 404, 409, 422]).toContain(wrongNamespace.status);
    expect(t.app.groups.get(initial.group.id).group.recoveryState?.acknowledgedCheckpointId).toBeUndefined();

    const acknowledged = await t.api('POST', `/api/groups/${initial.group.id}/recovery`, {
      action: 'acknowledge-checkpoint', checkpointId: groupCheckpointId, idempotencyKey: 'acknowledge-group-batch',
    });
    expect(acknowledged.status).toBe(200);
    expect(t.app.groups.get(initial.group.id).group.recoveryState?.acknowledgedCheckpointId).toBe(groupCheckpointId);
  });

  it('gates a supervised follow-up batch once, then resumes its single planner continuation after acknowledgment', async () => {
    const t = await boot();
    const initial = await createGroup(t, 'current-leads');
    const groupId = initial.group.id;
    const lead = initial.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    const worker = initial.members.find((member) => member.id !== lead.id)!;
    expect((await t.api('PATCH', `/api/groups/${groupId}`, { autonomy: { mode: 'supervised' } })).status).toBe(200);
    let leadTurns = 0;
    let workerRuns = 0;
    const reviewCheckpoint = deferred<string | undefined>();
    let firstAssignmentResponse: unknown;
    let blockedAssignmentResponse: unknown;
    let queuedSecondAssignmentResponse: unknown;
    let secondWorkerWasStarted = false;
    const secondWorkerGate = deferred<void>();
    t.fake.script = async (options, emit) => {
      if (options.session.id === lead.sessionId) {
        const turn = leadTurns++;
        if (turn >= 3) {
          emit({ type: 'text', text: 'Reviewed the acknowledged worker report.' });
          return;
        }
        const current = t.app.groups.get(groupId);
        const active = current.deliveries.find((row) => row.status === 'running' && row.memberId === lead.id);
        if (!active?.runId) throw new Error('Lead delivery was not bound to its run');
        const context = t.app.groups.contextForRun(options.session.id, active.runId);
        if (!context) throw new Error('Lead group context is unavailable');
        if (turn === 1) reviewCheckpoint.resolve(current.group.recoveryState?.pendingCheckpointId);
        const assignment = t.app.groups.assign(context, turn === 0 ? {
          recipient: 'backup', title: 'Supervised first batch', objective: 'Implement the first component.',
          acceptanceCriteria: 'The first component renders the requested content.', scope: ['src/supervised-component.tsx'], dependsOn: [], inputArtifacts: [],
        } : {
          recipient: 'backup', title: 'Supervised follow-up batch', objective: 'Implement the follow-up component.',
          acceptanceCriteria: 'The follow-up component renders the requested content.', scope: ['src/supervised-followup.tsx'], dependsOn: [], inputArtifacts: [],
        });
        if (turn === 0) {
          firstAssignmentResponse = assignment;
        } else if (turn === 1) {
          blockedAssignmentResponse = assignment;
          expect(assignment).toMatchObject({ status: 'awaiting-human-ack', queued: false });
        } else {
          queuedSecondAssignmentResponse = assignment;
        }
        emit({ type: 'text', text: turn === 0 ? 'Delegated the first supervised batch.' : 'Reviewed and planned the supervised follow-up.' });
        return;
      }
      if (options.session.id === worker.sessionId) {
        if (++workerRuns === 2) {
          secondWorkerWasStarted = true;
          await secondWorkerGate.promise;
        }
        emit({ type: 'text', text: workerRuns === 1 ? 'Completed the first supervised component.' : 'Completed the follow-up supervised component.' });
        return;
      }
    };

    try {
      expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Implement two supervised components in separate batches.' })).status).toBe(202);
      const first = await waitFor(() => firstAssignmentResponse, 1500, 'first supervised assignment to queue');
      expect(first).toMatchObject({ status: 'queued' });
      const blocked = await waitFor(() => blockedAssignmentResponse, 2000, 'first worker result to wake the lead review');
      expect(await reviewCheckpoint.promise).toBeUndefined();
      expect(blocked).toMatchObject({ status: 'awaiting-human-ack', queued: false });
      await waitFor(() => t.fake.runs.length === 3 && t.app.runtime.activeCount() === 0, 1500, 'lead review to settle at the supervised checkpoint');
      const checkpointId = await waitFor(() => t.app.groups.get(groupId).group.recoveryState?.pendingCheckpointId);
      expect(checkpointId).toMatch(/^gcp_/);
      const beforeAck = t.app.groups.get(groupId);
      expect(beforeAck.deliveries.filter((row) => row.kind === 'assignment')).toHaveLength(1);
      expect(t.fake.runs).toHaveLength(3);

      const acknowledged = await t.api('POST', `/api/groups/${groupId}/recovery`, {
        action: 'acknowledge-checkpoint', checkpointId, idempotencyKey: 'supervised-followup-batch-ack',
      });
      expect(acknowledged.status).toBe(200);
      expect(t.app.groups.get(groupId).group.recoveryState?.acknowledgedCheckpointId).toBe(checkpointId);
      const secondAssignment = await waitFor(() => queuedSecondAssignmentResponse, 2000, 'acknowledged continuation to queue the second batch');
      expect(secondAssignment).toMatchObject({ status: 'queued' });
      await waitFor(() => secondWorkerWasStarted, 1500, 'second supervised worker to start');
      expect(t.fake.runs).toHaveLength(5);
      expect(leadTurns).toBe(3);
      const resumed = t.app.groups.get(groupId);
      expect(resumed.group.recoveryState?.pendingCheckpointId).toBeUndefined();
      expect(resumed.deliveries.filter((row) => row.kind === 'assignment')).toHaveLength(2);
      expect(resumed.deliveries.filter((row) => row.kind === 'assignment' && (row.status === 'queued' || row.status === 'running'))).toHaveLength(1);
      expect(resumed.deliveries.some((row) => row.kind === 'result' && row.status === 'completed')).toBe(true);
    } finally {
      secondWorkerGate.resolve();
    }
    await waitFor(() => t.fake.runs.length >= 5 && t.app.runtime.activeCount() === 0);
  });

  it.each(['current-leads', 'cowork', 'orchestrated'] as const)('replaces only the failed lead/planner in %s mode', async (mode) => {
    const t = await boot();
    const { initial, delivery, snapshot } = await failCurrentLead(t, mode);
    const failedRequest = snapshot.requests.find((request) => request.id === delivery.requestId)!;
    const failedMemberId = mode === 'cowork' ? failedRequest.plannerMemberId : initial.group.orchestratorMemberId!;
    const replacement = snapshot.members.find((member) => member.id !== failedMemberId)!;
    const groupId = initial.group.id;
    const replace = {
      action: 'replace-coordinator', replacementMemberId: replacement.id,
      ...(mode === 'cowork' ? { requestId: failedRequest.id } : {}),
    };
    const unacknowledged = await t.api('POST', `/api/groups/${groupId}/recovery`, {
      ...replace, idempotencyKey: `replace-before-ack-${mode}`,
    });
    expect(unacknowledged.status).toBe(409);
    const checkpointId = await captureAndAck(t, groupId, delivery.id);
    const response = await t.api('POST', `/api/groups/${initial.group.id}/recovery`, {
      ...replace, checkpointId, idempotencyKey: `replace-${mode}`,
    });
    expect(response.status).toBe(200);
    const after = t.app.groups.get(initial.group.id);
    expect(after.group.coordinatorEpoch).toBeGreaterThan(initial.group.coordinatorEpoch ?? 0);
    if (mode === 'cowork') {
      expect(after.group.mode).toBe('cowork');
      expect(after.requests.find((request) => request.id === failedRequest.id)?.plannerMemberId).toBe(replacement.id);
      expect(after.members.filter((member) => !member.removedAt).every((member) => member.role === 'peer')).toBe(true);
    } else if (mode === 'current-leads') {
      expect(after.group.mode).toBe('orchestrated');
      expect(after.group.orchestratorMemberId).toBe(replacement.id);
      expect(after.group.anchorSessionId).toBe(initial.group.anchorSessionId);
    } else {
      expect(after.group.mode).toBe('orchestrated');
      expect(after.group.orchestratorMemberId).toBe(replacement.id);
    }
  });

  it.each(['current-leads', 'cowork', 'orchestrated'] as const)('makes one permission-safe configured quota handoff in %s mode', async (mode) => {
    const t = await bootWithCodexAndClaude();
    const initial = await createGroup(t, mode, codexConfig);
    const groupId = initial.group.id;
    const target = initial.members.find((member) => member.handle === 'backup')!;
    const sourceId = mode === 'cowork'
      ? initial.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!.id
      : initial.group.orchestratorMemberId!;
    const source = initial.members.find((member) => member.id === sourceId)!;
    await configureQuotaFallback(t, groupId, source.id, target.id);

    const dirtyPath = 'quota-source-dirty.txt';
    t.fake.script = async (options, emit) => {
      if (options.session.id === source.sessionId) {
        writeFileSync(path.join(options.session.worktreePath, dirtyPath), 'uncommitted work stays with source');
        const dispatched: DispatchState = 'dispatched';
        (options as typeof options & DispatchAwareOptions).onDispatchState?.(dispatched);
        throw new ProviderError('Account quota exhausted.', { providerCode: 'usageLimitExceeded', outcomeKnown: true });
      }
      if (options.session.id === target.sessionId) {
        emit({ type: 'text', text: 'One bounded replacement attempt completed.' });
      }
    };
    expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Recover without replaying uncertain work.' })).status).toBe(202);
    await waitFor(() => t.fake.runs.some((run) => run.session.id === target.sessionId) && t.app.runtime.activeCount() === 0);

    const targetRuns = t.fake.runs.filter((run) => run.session.id === target.sessionId);
    expect(targetRuns).toHaveLength(1);
    expect(targetRuns[0]!.prompt).toContain(dirtyPath);
    expect((await import('node:fs')).existsSync(path.join(targetRuns[0]!.session.worktreePath, dirtyPath))).toBe(false);
    expect((await t.api('GET', '/api/bootstrap')).json.sessions.find((row: any) => row.id === source.sessionId).policy).toBe('supervised');
    expect((await t.api('GET', '/api/bootstrap')).json.sessions.find((row: any) => row.id === target.sessionId)).toMatchObject({ provider: 'codex', policy: 'supervised' });

    const snapshot = t.app.groups.get(groupId);
    const original = snapshot.deliveries.find((row) => row.memberId === source.id && row.status === 'failed')!;
    expect(original.recoveredByDeliveryId).toBeTruthy();
    expect(snapshot.deliveries.filter((row) => row.memberId === target.id && row.status === 'completed')).toHaveLength(1);
  });

  it('blocks unverified automatic fallback to the same provider even with explicit unknown-pool opt-in', async () => {
    const t = await boot();
    const initial = await createGroup(t, 'current-leads');
    const source = initial.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    const target = initial.members.find((member) => member.id !== source.id)!;
    await configureQuotaFallback(t, initial.group.id, source.id, target.id);
    t.fake.script = async () => { throw new ProviderError('Account quota exhausted.', { providerCode: 'usageLimitExceeded', outcomeKnown: true }); };
    expect((await t.api('POST', `/api/groups/${initial.group.id}/messages`, { content: 'Do not retry against an unknown same-provider pool.' })).status).toBe(202);
    await waitFor(() => t.app.groups.get(initial.group.id).deliveries.some((row) => row.status === 'failed') && t.app.runtime.activeCount() === 0);
    expect(t.fake.runs).toHaveLength(1);
  });

  it('blocks the configured fallback when its permission policy is more permissive', async () => {
    const t = await bootWithCodexAndClaude();
    const initial = await createGroup(t, 'current-leads', codexFullAccessConfig);
    const source = initial.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    const target = initial.members.find((member) => member.id !== source.id)!;
    const configuration = await t.api('PATCH', `/api/groups/${initial.group.id}`, {
      recoveryPolicy: {
        automaticFallback: true, allowUnverifiedQuotaFallback: true,
        leadFallbackMemberId: target.id, workerFallbacks: { [source.id]: target.id },
      },
    });
    expect(configuration.status, JSON.stringify(configuration.json)).toBe(422);
    t.fake.script = async (options) => {
      if (options.session.id === source.sessionId) throw new ProviderError('Account quota exhausted.', { providerCode: 'usageLimitExceeded', outcomeKnown: true });
    };
    expect((await t.api('POST', `/api/groups/${initial.group.id}/messages`, { content: 'Preserve supervised permissions.' })).status).toBe(202);
    await waitFor(() => t.app.groups.get(initial.group.id).deliveries.some((row) => row.status === 'failed') && t.app.runtime.activeCount() === 0);
    expect(t.fake.runs.filter((run) => run.session.id === target.sessionId)).toHaveLength(0);
  });

  it('does not schedule an automatic quota fallback to a held member', async () => {
    const t = await bootWithCodexAndClaude();
    const initial = await createGroup(t, 'current-leads', codexConfig);
    const source = initial.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    const target = initial.members.find((member) => member.id !== source.id)!;
    expect((await t.api('POST', `/api/groups/${initial.group.id}/members/${target.id}/interrupt`, {})).status).toBe(200);
    await configureQuotaFallback(t, initial.group.id, source.id, target.id);
    t.fake.script = async (options) => {
      if (options.session.id === source.sessionId) throw new ProviderError('Account quota exhausted.', { providerCode: 'usageLimitExceeded', outcomeKnown: true });
    };
    expect((await t.api('POST', `/api/groups/${initial.group.id}/messages`, { content: 'Do not dispatch to a held member.' })).status).toBe(202);
    await waitFor(() => t.app.groups.get(initial.group.id).deliveries.some((row) => row.status === 'failed') && t.app.runtime.activeCount() === 0);
    expect(t.fake.runs.filter((run) => run.session.id === target.sessionId)).toHaveLength(0);
  });

  it('makes at most one fallback attempt when the selected replacement is also quota exhausted', async () => {
    const t = await bootWithCodexAndClaude();
    const initial = await createGroup(t, 'current-leads', codexConfig);
    const source = initial.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    const target = initial.members.find((member) => member.id !== source.id)!;
    await configureQuotaFallback(t, initial.group.id, source.id, target.id);
    t.fake.script = async () => { throw new ProviderError('Account quota exhausted.', { providerCode: 'usageLimitExceeded', outcomeKnown: true }); };
    expect((await t.api('POST', `/api/groups/${initial.group.id}/messages`, { content: 'Bound the fallback attempt.' })).status).toBe(202);
    await waitFor(() => t.app.groups.get(initial.group.id).deliveries.filter((row) => row.status === 'failed').length >= 2 && t.app.runtime.activeCount() === 0);
    expect(t.fake.runs.filter((run) => run.session.id === target.sessionId)).toHaveLength(1);
    expect(t.app.groups.get(initial.group.id).deliveries.filter((row) => row.memberId === target.id && row.status === 'failed')).toHaveLength(1);
  });

  it('rechecks coordinator authority after an asynchronous artifact verification await', async () => {
    const t = await boot();
    const initial = await createGroup(t, 'current-leads');
    const groupId = initial.group.id;
    const lead = initial.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    const replacement = initial.members.find((member) => member.id !== lead.id)!;
    const verificationStarted = deferred<void>();
    const verificationGate = deferred<void>();
    const handoffs = (t.app.groups as unknown as { handoffs: { create: (...args: any[]) => Promise<unknown> } }).handoffs;
    const originalCreate = handoffs.create.bind(handoffs);
    vi.spyOn(handoffs, 'create').mockImplementation(async (...args: any[]) => {
      verificationStarted.resolve();
      await verificationGate.promise;
      return originalCreate(...args);
    });
    let artifactOperation: Promise<unknown> | undefined;
    t.fake.script = async (options) => {
      const running = t.app.groups.get(groupId).deliveries.find((row) => row.status === 'running' && row.memberId === lead.id);
      if (!running?.runId) throw new Error('Lead delivery was not bound to its run');
      const context = t.app.groups.contextForRun(options.session.id, running.runId);
      if (!context) throw new Error('Lead group context is unavailable');
      artifactOperation = t.app.groups.artifact(context, {
        recipient: 'backup', path: EXAMPLE_ARTIFACT_PATH, revision: 'HEAD', note: 'Must be fenced after takeover',
      });
      await verificationStarted.promise;
      throw new ProviderError('Account quota exhausted.', { providerCode: 'usageLimitExceeded', outcomeKnown: true });
    };
    try {
      expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Attempt an asynchronous artifact handoff.' })).status).toBe(202);
      await verificationStarted.promise;
      await waitFor(() => t.app.groups.get(groupId).deliveries.some((row) => row.status === 'failed') && t.app.runtime.activeCount() === 0);
      const unacknowledged = await t.api('POST', `/api/groups/${groupId}/recovery`, {
        action: 'replace-coordinator', replacementMemberId: replacement.id, idempotencyKey: 'takeover-before-ack',
      });
      expect(unacknowledged.status).toBe(409);
      const failedDelivery = t.app.groups.get(groupId).deliveries.find((row) => row.memberId === lead.id && row.status === 'failed')!;
      const checkpointId = await captureAndAck(t, groupId, failedDelivery.id);
      const response = await t.api('POST', `/api/groups/${groupId}/recovery`, {
        action: 'replace-coordinator', replacementMemberId: replacement.id, checkpointId,
        idempotencyKey: 'takeover-during-artifact',
      });
      expect(response.status).toBe(200);
      verificationGate.resolve();
      await expect(artifactOperation).rejects.toThrow(/active delivery|live|authority|coordinator/i);
      expect((await t.api('GET', `/api/sessions/${replacement.sessionId}/messages`)).json.some((message: any) => message.kind === 'handoff')).toBe(false);
      expect((await t.api('GET', '/api/events')).json.some((event: any) => event.type === 'handoff.created')).toBe(false);
    } finally {
      verificationGate.resolve();
      await artifactOperation?.catch(() => undefined);
    }
  });

  it('lets an already-running healthy worker finish and retains its result while the lead is unavailable', async () => {
    const t = await boot();
    const initial = await createGroup(t, 'current-leads');
    const groupId = initial.group.id;
    const lead = initial.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
    const assigned = deferred<void>();
    t.fake.script = async (options, emit) => {
      if (options.session.id !== lead.sessionId) {
        emit({ type: 'text', text: 'Worker result retained during lead outage.' });
        return;
      }
      const current = t.app.groups.get(groupId);
      const delivery = current.deliveries.find((row) => row.status === 'running' && row.memberId === lead.id);
      if (!delivery?.runId) throw new Error('Lead delivery was not bound to its active provider run');
      const context = t.app.groups.contextForRun(options.session.id, delivery.runId);
      if (!context) throw new Error('Lead lost its live group context before assignment');
      expect(t.app.groups.assign(context, {
        recipient: 'backup', title: 'Build one fixture component', objective: 'Create the component in its own file.',
        acceptanceCriteria: 'Component renders the requested content.', scope: ['src/fixture-component.tsx'], dependsOn: [], inputArtifacts: [],
      })).toMatchObject({ recipient: 'backup', status: 'queued' });
      assigned.resolve();
      throw new ProviderError('Account quota exhausted.', { providerCode: 'usageLimitExceeded', outcomeKnown: true });
    };

    expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Build a component with one worker.' })).status).toBe(202);
    await assigned.promise;
    const workerDelivery = await waitFor(() => t.app.groups.get(groupId).deliveries.find((row) => row.kind === 'assignment' && row.status === 'completed'));
    await waitFor(() => t.app.runtime.activeCount() === 0);
    const snapshot = t.app.groups.get(groupId);
    expect(snapshot.group.paused).toBe(false);
    expect(snapshot.group.recoveryState?.status).toBe('degraded');
    expect(snapshot.members.find((member) => member.id === lead.id)?.held).toBe(true);
    expect(snapshot.deliveries.some((row) => row.memberId === lead.id && row.status === 'failed')).toBe(true);
    expect(workerDelivery.status).toBe('completed');
    expect(snapshot.messages.some((message) => message.kind === 'status' && message.content.includes('Worker result retained during lead outage.'))).toBe(true);
    expect(snapshot.deliveries.some((row) => row.kind === 'result' && row.status === 'queued')).toBe(true);
  });

  it('pauses persisted queued group work on restart without automatically starting a paid provider run', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'mingle-recovery-restart-'));
    let t: TestApp | undefined;
    let restarted: TestApp | undefined;
    try {
      const testApp = t = await boot({ dataDir, keepData: true });
      const initial = await createGroup(testApp, 'current-leads');
      const groupId = initial.group.id;
      const lead = initial.members.find((member) => member.sessionId === EXAMPLE_CLIENT_SESSION_ID)!;
      const worker = initial.members.find((member) => member.id !== lead.id)!;
      expect((await testApp.api('POST', `/api/groups/${groupId}/members/${worker.id}/interrupt`, {})).status).toBe(200);
      testApp.fake.script = async (options, emit) => {
        const current = testApp.app.groups.get(groupId);
        const active = current.deliveries.find((row) => row.status === 'running' && row.memberId === lead.id);
        if (!active?.runId) throw new Error('Lead delivery is not bound to a run');
        const context = testApp.app.groups.contextForRun(options.session.id, active.runId);
        if (!context) throw new Error('Lead group context is unavailable');
        testApp.app.groups.assign(context, {
          recipient: 'backup', title: 'Queued work for restart', objective: 'Create the file after an explicit resume.',
          acceptanceCriteria: 'The file exists after the human resumes group work.', scope: ['src/restart-queued.ts'], dependsOn: [], inputArtifacts: [],
        });
        emit({ type: 'text', text: 'The worker task is queued while that worker is held.' });
      };
      expect((await testApp.api('POST', `/api/groups/${groupId}/messages`, { content: 'Queue work for a held worker.' })).status).toBe(202);
      await waitFor(() => testApp.app.runtime.activeCount() === 0 && testApp.app.groups.get(groupId).deliveries.some((row) => row.kind === 'assignment' && row.status === 'queued'));
      expect(testApp.fake.runs).toHaveLength(1);
      await testApp.app.close();

      restarted = await boot({ dataDir, keepData: true, fake: new FakeProviders() });
      const recovered = restarted.app.groups.get(groupId);
      expect(recovered.group.paused).toBe(true);
      expect(recovered.group.pauseReason).toMatch(/restart|resume/i);
      expect(recovered.deliveries.some((row) => row.kind === 'assignment' && row.status === 'queued')).toBe(true);
      expect(restarted.fake.runs).toHaveLength(0);
    } finally {
      await restarted?.app.close();
      await t?.app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

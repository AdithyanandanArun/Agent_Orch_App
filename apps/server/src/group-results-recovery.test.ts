import { expect, it } from 'vitest';
import type { GroupDelivery, GroupSnapshot, Session, SessionRun } from '@mingle/contracts';
import { buildGroupResultModel, type GroupResultInput } from '../../web/src/lib/groupResults';

const GROUP_ID = 'group-1';
const REQUEST_ID = 'request-1';
const MESSAGE_ID = 'message-1';
const MEMBER_ID = 'lead-1';
const SESSION_ID = 'session-1';
const NOW = '2026-10-21T12:00:00.000Z';

interface DeliverySpec {
  id: string;
  status: GroupDelivery['status'];
  requestId?: string;
  runId?: string | null;
  recoveredByDeliveryId?: string;
  error?: string | null;
}

function delivery(spec: DeliverySpec): GroupDelivery {
  return {
    id: spec.id,
    groupId: GROUP_ID,
    requestId: spec.requestId ?? REQUEST_ID,
    messageId: MESSAGE_ID,
    memberId: MEMBER_ID,
    kind: 'request',
    status: spec.status,
    runId: spec.runId ?? null,
    error: spec.error ?? null,
    hop: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...(spec.recoveredByDeliveryId ? { recoveredByDeliveryId: spec.recoveredByDeliveryId } : {}),
  } as GroupDelivery;
}

function run(id: string, status: SessionRun['status'], changes?: SessionRun['changes']): SessionRun {
  return {
    id,
    sessionId: SESSION_ID,
    userMessageId: MESSAGE_ID,
    provider: 'claude',
    model: 'test-model',
    status,
    startedAt: NOW,
    finishedAt: status === 'running' ? null : NOW,
    durationMs: 1,
    toolCount: 0,
    toolCounts: {},
    ...(changes !== undefined ? { changes } : {}),
  };
}

function result(snapshotDeliveries: GroupDelivery[], runs: SessionRun[]) {
  const snapshot = {
    group: { id: GROUP_ID, projectId: 'project-1', paused: false, pauseReason: null },
    members: [{ id: MEMBER_ID, groupId: GROUP_ID, sessionId: SESSION_ID, handle: 'lead', role: 'orchestrator', joinedAt: NOW, removedAt: null }],
    messages: [{
      id: MESSAGE_ID, seq: 1, groupId: GROUP_ID, senderMemberId: null, recipientMemberIds: [MEMBER_ID],
      kind: 'user', content: 'Implement the requested change', requestId: null, replyToId: null,
      sourceMessageId: null, sourceRunId: null, createdAt: NOW,
    }],
    requests: [{ id: REQUEST_ID, groupId: GROUP_ID, messageId: MESSAGE_ID, plannerMemberId: MEMBER_ID, status: 'completed', turnsUsed: 2, createdAt: NOW }],
    deliveries: snapshotDeliveries,
    assignments: [],
  } as unknown as GroupSnapshot;
  const sessions = [{
    id: SESSION_ID, projectId: 'project-1', name: 'Lead', provider: 'claude', model: 'test-model', effort: 'high', status: 'idle',
    policy: 'supervised', isolated: true, worktreePath: '/tmp/group-results-test', branch: null, providerSessionId: null,
    createdAt: NOW, updatedAt: NOW, error: null, inputTokens: 0, outputTokens: 0, costUsd: null, pinned: false, unread: false,
  }] as unknown as Session[];
  return buildGroupResultModel({ snapshot, sessions, messages: [], runs, tasks: [] } satisfies GroupResultInput)!;
}

const sourceFailure = (status: 'failed' | 'interrupted' = 'failed') => delivery({
  id: 'source', status, runId: 'source-run', error: status === 'failed' ? 'Original quota failure' : null,
});

it('keeps an unrecovered failed delivery failed', () => {
  const model = result([sourceFailure()], [run('source-run', 'failed')]);
  expect(model.status).toBe('failed');
  expect(model.agents[0]?.problems).toContain('Turn failed: Original quota failure');
});

it.each(['failed', 'interrupted'] as const)('treats a completed replacement as a normal response after a %s source while preserving its audit history', (sourceStatus) => {
  const source = delivery({ ...sourceFailure(sourceStatus), recoveredByDeliveryId: 'replacement' });
  const replacement = delivery({ id: 'replacement', status: 'completed', runId: 'replacement-run' });
  const sourceChanges: NonNullable<SessionRun['changes']> = {
    status: 'available', capturedAt: NOW, fileCount: 1,
    files: [{ path: 'src/partial-edits.ts', status: 'M', additions: 3, deletions: 1, binary: false }],
    additions: 3, deletions: 1, truncated: false, notices: [],
  };
  const sourceRunStatus = sourceStatus === 'failed' ? 'failed' : 'interrupted';
  const model = result([source, replacement], [run('source-run', sourceRunStatus, sourceChanges), run('replacement-run', 'completed')]);

  expect(model.status).toBe('responded');
  expect(model.title).toBe('Team finished responding');
  expect(model.agents[0]?.problems).toContain(sourceStatus === 'failed' ? 'Turn failed: Original quota failure' : 'Turn interrupted before finishing.');
  expect(model.agents[0]?.workspace.paths).toContainEqual(expect.objectContaining({ path: 'src/partial-edits.ts', status: 'M' }));
  expect(model.changedPathCount).toBe(1);
  expect(model.facts).toContain('1 recovery attempt');
});

it.each(['queued', 'running'] as const)('shows a %s replacement as active instead of failed', (status) => {
  const source = delivery({ ...sourceFailure(), recoveredByDeliveryId: 'replacement' });
  const replacement = delivery({ id: 'replacement', status, ...(status === 'running' ? { runId: 'replacement-run' } : {}) });
  const runs = [run('source-run', 'failed'), ...(status === 'running' ? [run('replacement-run', 'running')] : [])];
  const model = result([source, replacement], runs);

  expect(model.status).toBe('in-progress');
  expect(model.active).toBe(true);
});

it('keeps a failed replacement as the current request failure', () => {
  const source = delivery({ ...sourceFailure(), recoveredByDeliveryId: 'replacement' });
  const replacement = delivery({ id: 'replacement', status: 'failed', runId: 'replacement-run', error: 'Replacement failed' });
  const model = result([source, replacement], [run('source-run', 'failed'), run('replacement-run', 'failed')]);

  expect(model.status).toBe('failed');
  expect(model.agents[0]?.problems).toContain('Turn failed: Replacement failed');

  const cancelled = delivery({ id: 'replacement', status: 'cancelled' });
  expect(result([source, cancelled], [run('source-run', 'failed')]).status).toBe('stopped');
});

it('does not let missing, cross-request, or cyclic recovery links hide a failure', () => {
  const missing = [delivery({ ...sourceFailure(), recoveredByDeliveryId: 'absent' })];
  const crossRequest = [
    delivery({ ...sourceFailure(), recoveredByDeliveryId: 'other-request' }),
    delivery({ id: 'other-request', status: 'completed', requestId: 'request-2', runId: 'other-run' }),
  ];
  const cyclic = [
    delivery({ ...sourceFailure(), recoveredByDeliveryId: 'replacement' }),
    delivery({ id: 'replacement', status: 'failed', runId: 'replacement-run', recoveredByDeliveryId: 'source' }),
  ];
  const failedRuns = [run('source-run', 'failed'), run('replacement-run', 'failed'), run('other-run', 'completed')];

  for (const deliveries of [missing, crossRequest, cyclic]) expect(result(deliveries, failedRuns).status).toBe('failed');
});

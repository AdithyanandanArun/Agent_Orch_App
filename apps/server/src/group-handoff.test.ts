import { afterEach, expect, it } from 'vitest';
import type { Bootstrap, GroupSnapshot } from '@mingle/contracts';
import { EXAMPLE_CONTRACT_SESSION_ID } from './example.ts';
import { deferred, startTestApp, waitFor, type TestApp } from './test-utils.ts';

let testApp: TestApp | undefined;
afterEach(async () => { await testApp?.cleanup(); testApp = undefined; });

it('returns early worker results to a busy Cowork planner and retains its native final answers', async () => {
  const t = testApp = await startTestApp();
  await t.api('POST', '/api/providers/refresh', {});
  const existing = await t.api('PATCH', `/api/sessions/${EXAMPLE_CONTRACT_SESSION_ID}`, {
    provider: 'claude', model: 'claude-sonnet-5-5',
  });
  expect(existing.status).toBe(200);
  const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
    sessionId: EXAMPLE_CONTRACT_SESSION_ID, mode: 'cowork',
    agent: { handle: 'claude2', isolated: true, configuration: {
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised',
    } },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const groupId = created.json.group.id;
  const plannerId = EXAMPLE_CONTRACT_SESSION_ID;
  const workerId = created.json.members.find(member => member.handle === 'claude2')!.sessionId;
  const releasePlanner = deferred();
  let plannerTurns = 0;
  t.fake.script = async (options, emit) => {
    if (options.session.id === workerId) {
      emit({ type: 'text', text: 'The stylesheet is ready for integration.' });
      return;
    }
    plannerTurns++;
    if (plannerTurns === 1) {
      const delivery = t.app.groups.get(groupId).deliveries.find(row => row.status === 'running' && row.memberId === created.json.members[0]!.id)!;
      const context = t.app.groups.contextForRun(plannerId, delivery.runId!)!;
      t.app.groups.assign(context, {
        recipient: 'claude2', title: 'Style the website', objective: 'Create style.css',
        acceptanceCriteria: 'Stay inside style.css', scope: ['style.css'], dependsOn: [], inputArtifacts: [],
      });
      emit({ type: 'text', text: 'I am creating the page while the other peer styles it.' });
      await releasePlanner.promise;
      emit({ type: 'text', text: 'The page and stylesheet are integrated.' });
    } else {
      expect(options.prompt).toContain('Your latest delegation batch has returned.');
      expect(options.prompt).toContain('they do not certify implementation, integration or human acceptance');
      expect(options.prompt).toContain('The stylesheet is ready for integration.');
      emit({ type: 'text', text: 'Reviewed the handoff. The website is complete.' });
    }
  };

  expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: 'Build a small website together.' })).status).toBe(202);
  try {
    const handoff = await waitFor(() => {
      const snapshot = t.app.groups.get(groupId);
      const result = snapshot.messages.find(message => message.kind === 'status');
      return result && snapshot.deliveries.find(delivery => delivery.messageId === result.id && delivery.status === 'queued');
    });
    expect(handoff.runId).toBeNull();
    expect(plannerTurns).toBe(1); // The result cannot start a second turn in the busy planner.
    expect(t.fake.runs.map(run => run.session.id)).toEqual([plannerId, workerId]);
  } finally {
    releasePlanner.resolve();
  }

  await waitFor(() => {
    const snapshot = t.app.groups.get(groupId);
    return snapshot.deliveries.length === 3 && snapshot.deliveries.every(delivery => delivery.status === 'completed');
  });
  expect(plannerTurns).toBe(2);
  const boot = (await t.api<Bootstrap>('GET', '/api/bootstrap')).json;
  const snapshot = boot.groups!.find(group => group.group.id === groupId)!;
  expect(snapshot.requests[0]!.status).toBe('completed');
  const answers = boot.messages.filter(message => message.sessionId === plannerId && message.role === 'assistant');
  expect(answers.some(message => message.content.includes('The page and stylesheet are integrated.'))).toBe(true);
  const final = answers.find(message => message.content === 'Reviewed the handoff. The website is complete.')!;
  expect(final).toBeDefined();
  const handoff = snapshot.messages.find(message => message.kind === 'status')!;
  const delivery = snapshot.deliveries.find(row => row.messageId === handoff.id)!;
  expect(final.runId).toBe(delivery.runId);
  expect(boot.messages.find(message => message.id === boot.runs!.find(run => run.id === final.runId)!.userMessageId)?.kind).toBe('group-delivery');
});

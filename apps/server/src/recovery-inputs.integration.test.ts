import { afterEach, describe, expect, it } from 'vitest';
import type { AttachmentRef, GroupSnapshot, ProviderInfo, RunAttachment, RunOptions } from '@mingle/contracts';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EXAMPLE_CLIENT_SESSION_ID } from './example.ts';
import { ProviderError, type DispatchAwareOptions } from './providers/common.js';
import { FakeProviders, startTestApp, waitFor, type TestApp } from './test-utils.ts';

const apps: TestApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

describe('recovery input preservation', () => {
  it('passes the original uploaded image to an isolated Codex coordinator replacement', async () => {
    const fake = new FakeProviders();
    fake.detectProviders = async () => [
      { id: 'claude', name: 'Claude', available: true, version: 'fake', executable: '/fake/claude', reason: null,
        promptCapabilities: { image: true, embeddedContext: true },
        models: [{ id: 'claude-sonnet-5-5', name: 'Claude fake', inputModalities: ['text', 'image'] }] },
      { id: 'codex', name: 'Codex', available: true, version: 'fake', executable: '/fake/codex', reason: null,
        policies: ['supervised'], promptCapabilities: { image: true, embeddedContext: true },
        models: [{ id: 'gpt-6.1-sol', name: 'Codex fake', policies: ['supervised'], inputModalities: ['text', 'image'] }] },
    ] satisfies ProviderInfo[];
    const t = await startTestApp({ fake });
    apps.push(t);
    await t.api('POST', '/api/providers/refresh', {});

    const created = await t.api<GroupSnapshot>('POST', '/api/groups', {
      sessionId: EXAMPLE_CLIENT_SESSION_ID, mode: 'current-leads',
      agent: { handle: 'codex-recovery', isolated: true, configuration: {
        provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', policy: 'supervised', serviceTier: 'standard',
      } },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const initial = created.json;
    const groupId = initial.group.id;
    const source = initial.members.find((member) => member.sessionId === initial.group.anchorSessionId)!;
    const target = initial.members.find((member) => member.handle === 'codex-recovery')!;
    expect((await t.api('PATCH', `/api/groups/${groupId}`, { recoveryPolicy: {
      automaticFallback: true, allowUnverifiedQuotaFallback: true, leadFallbackMemberId: target.id, workerFallbacks: {},
    } })).status).toBe(200);

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const upload = await fetch(`${t.url}/api/groups/${groupId}/attachments`, {
      method: 'POST', headers: { 'content-type': 'image/png', 'x-mingle-filename': 'reference.png' },
      body: new Blob([png], { type: 'image/png' }),
    });
    expect(upload.status).toBe(201);
    const attachment = await upload.json() as AttachmentRef;
    const objective = 'Inspect the uploaded reference image and summarize its visible shape.';
    let sourceRun: RunOptions | undefined;
    let sourceImage: RunAttachment | undefined;
    let targetRun: RunOptions | undefined;
    let targetImage: RunAttachment | undefined;
    let targetImageExistedDuringRun = false;
    let targetImageBytesDuringRun: Buffer | undefined;
    fake.script = async (options, emit) => {
      if (options.session.id === source.sessionId) {
        sourceRun = options;
        sourceImage = options.attachments?.find((item) => item.id === attachment.id);
        (options as RunOptions & DispatchAwareOptions).onDispatchState?.('dispatched');
        throw new ProviderError('Account quota exhausted.', {
          providerCode: 'usageLimitExceeded', outcomeKnown: true, continuationSafety: 'safe',
        });
      }
      if (options.session.id === target.sessionId) {
        targetRun = options;
        targetImage = options.attachments?.find((item) => item.id === attachment.id);
        if (targetImage) {
          targetImageExistedDuringRun = existsSync(targetImage.path);
          if (targetImageExistedDuringRun) targetImageBytesDuringRun = readFileSync(targetImage.path);
        }
        emit({ type: 'text', text: 'The replacement inspected the original reference image.' });
      }
    };

    expect((await t.api('POST', `/api/groups/${groupId}/messages`, { content: objective, attachmentIds: [attachment.id] })).status).toBe(202);
    const recovered = await waitFor(() => {
      const snapshot = t.app.groups.get(groupId);
      const original = snapshot.deliveries.find((delivery) => delivery.memberId === source.id && delivery.status === 'failed');
      const successor = original?.recoveredByDeliveryId
        ? snapshot.deliveries.find((delivery) => delivery.id === original.recoveredByDeliveryId)
        : undefined;
      return original && successor?.status === 'completed' && t.app.runtime.activeCount() === 0
        ? { snapshot, original, successor } : undefined;
    }, 5000, 'isolated coordinator continuation to complete');

    expect(sourceRun?.prompt).toContain(objective);
    expect(sourceImage).toMatchObject({ id: attachment.id, kind: 'image', mimeType: 'image/png' });
    expect(targetRun).toBeDefined();
    expect(fake.runs.filter((run) => run.session.id === target.sessionId)).toHaveLength(1);
    expect(targetRun!.prompt).toContain(objective);
    expect(targetImage).toMatchObject({ id: attachment.id, kind: 'image', mimeType: 'image/png', name: 'reference.png' });
    expect(targetImageExistedDuringRun).toBe(true);
    expect(targetImageBytesDuringRun).toEqual(png);
    expect(path.relative(targetRun!.session.worktreePath, targetImage!.path)).toMatch(/^\.\.(?:[\\/]|$)/);

    expect(recovered.successor).toMatchObject({ status: 'completed', kind: 'result', memberId: target.id });
    expect(recovered.original.recoveredByDeliveryId).toBe(recovered.successor.id);
    expect(recovered.snapshot.deliveries.filter((delivery) => delivery.id === recovered.original.recoveredByDeliveryId)).toHaveLength(1);
    const request = recovered.snapshot.requests.find((item) => item.id === recovered.original.requestId)!;
    const originalMessage = recovered.snapshot.messages.find((message) => message.id === request.messageId)!;
    expect(originalMessage.content).toContain(objective);
    expect(originalMessage.attachments).toContainEqual(expect.objectContaining({ id: attachment.id, name: 'reference.png', mimeType: 'image/png' }));
    const bootstrap = (await t.api('GET', '/api/bootstrap')).json;
    const sourceSession = bootstrap.sessions.find((session: any) => session.id === source.sessionId);
    const targetSession = bootstrap.sessions.find((session: any) => session.id === target.sessionId);
    expect(sourceSession).toMatchObject({ provider: 'claude', policy: 'supervised' });
    expect(targetSession).toMatchObject({ provider: 'codex', policy: sourceSession.policy });
  });
});

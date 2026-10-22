import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitSyncService } from './git-sync.ts';
import { envelope, importRunGit, makeOwner, setGitIdentity, type OwnerFixture } from './git-test-utils.ts';
import { fingerprintRepository } from './git-common.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function prepareClones() {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'mingle-git-case-'));
  const base = execFileSync('git', ['init', '-q', '--initial-branch=main', path.join(parent, 'base')], { encoding: 'utf8' });
  void base;
  const basePath = path.join(parent, 'base');
  writeFileSync(path.join(basePath, 'README.md'), 'base\n');
  importRunGit(basePath, ['add', 'README.md']);
  importRunGit(basePath, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'base']);
  const sourceRoot = path.join(parent, 'source');
  const destinationRoot = path.join(parent, 'destination');
  importRunGit(parent, ['clone', '-q', basePath, sourceRoot]);
  importRunGit(parent, ['clone', '-q', basePath, destinationRoot]);
  setGitIdentity(sourceRoot);
  setGitIdentity(destinationRoot);
  const source = makeOwner(sourceRoot, 'account-source', 'source-device');
  const destination = makeOwner(destinationRoot, 'account-destination', 'destination-device');
  cleanups.push(() => { source.close(); destination.close(); rmSync(parent, { recursive: true, force: true }); rmSync(basePath, { recursive: true, force: true }); });
  return { parent, basePath, source, destination };
}

async function bindPair(source: OwnerFixture, destination: OwnerFixture, teamId = 'team-alpha', sharedProjectId = 'shared-project') {
  const sourceService = new GitSyncService(source.options);
  const destinationService = new GitSyncService(destination.options);
  await sourceService.bindProject({ teamId, sharedProjectId, localProjectId: source.projectId });
  await destinationService.bindProject({ teamId, sharedProjectId, localProjectId: destination.projectId });
  return { sourceService, destinationService, teamId, sharedProjectId };
}

async function transferAndApprove(source: OwnerFixture, destination: OwnerFixture, pair: Awaited<ReturnType<typeof bindPair>>) {
  const sourceHead = importRunGit(source.root, ['rev-parse', 'HEAD']).trim();
  const baseHead = importRunGit(source.root, ['rev-parse', 'HEAD^']).trim();
  const offer = await pair.sourceService.request({ teamId: pair.teamId, sharedProjectId: pair.sharedProjectId,
    toDeviceId: destination.deviceFor(pair.teamId), expectedHead: sourceHead, baseHead });
  expect(offer.status).toBe('awaiting-source-approval');
  expect(source.messages.filter((message) => message.kind === 'git.bundle.chunk')).toHaveLength(0);
  const sentOffer = source.messages.find((message) => message.kind === 'git.offer')!;
  await pair.destinationService.onEnvelope(envelope({ teamId: pair.teamId, fromDeviceId: source.deviceFor(pair.teamId),
    toDeviceId: destination.deviceFor(pair.teamId), kind: sentOffer.kind, payload: sentOffer.payload }));
  const pending = (await pair.destinationService.snapshot(pair.teamId)).requests[0]!;
  expect(pending.status).toBe('awaiting-destination-approval');
  await expect(pair.destinationService.decide({ requestId: pending.id, decision: 'approved', expectedDigest: '0'.repeat(64) })).rejects.toThrow(/changed after review/);
  await pair.destinationService.decide({ requestId: pending.id, decision: 'approved', expectedDigest: pending.requestDigest });
  const approval = destination.messages.find((message) => message.kind === 'git.import-approved')!;
  await pair.sourceService.onEnvelope(envelope({ teamId: pair.teamId, fromDeviceId: destination.deviceFor(pair.teamId),
    toDeviceId: source.deviceFor(pair.teamId), kind: approval.kind, payload: approval.payload }));
  expect(source.messages.filter((message) => message.kind === 'git.bundle.chunk')).toHaveLength(0);
  await pair.sourceService.decide({ requestId: offer.id, decision: 'approved', expectedDigest: offer.requestDigest });
  const chunks = source.messages.filter((message) => message.kind === 'git.bundle.chunk');
  expect(chunks.length).toBeGreaterThan(0);
  await pair.sourceService.decide({ requestId: offer.id, decision: 'approved', expectedDigest: offer.requestDigest });
  expect(source.messages.filter((message) => message.kind === 'git.bundle.chunk')).toHaveLength(chunks.length);
  for (const chunk of [...chunks].reverse()) {
    await pair.destinationService.onEnvelope(envelope({ teamId: pair.teamId, fromDeviceId: source.deviceFor(pair.teamId),
      toDeviceId: destination.deviceFor(pair.teamId), kind: chunk.kind, payload: chunk.payload }));
  }
  const imported = (await pair.destinationService.snapshot(pair.teamId)).requests[0]!;
  return { offer, imported, chunks, pair };
}

describe('GitSyncService', () => {
  it('requires both owners, transfers a bounded bundle to an isolated ref, and separately approves fast-forward merge', async () => {
    const { source, destination } = prepareClones();
    writeFileSync(path.join(source.root, 'feature.txt'), 'committed only\n');
    const binary = randomBytes(600 * 1024);
    writeFileSync(path.join(source.root, 'payload.bin'), binary);
    importRunGit(source.root, ['add', 'feature.txt', 'payload.bin']);
    importRunGit(source.root, ['commit', '-q', '-m', 'feature']);
    const pair = await bindPair(source, destination);
    const beforeHead = importRunGit(destination.root, ['rev-parse', 'HEAD']).trim();
    const { imported, offer, chunks } = await transferAndApprove(source, destination, pair);
    expect(imported.status).toBe('imported');
    expect(imported.bundleSizeBytes).toBeGreaterThan(0);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk.payload.data, 'base64') <= 256 * 1024)).toBe(true);
    expect(importRunGit(destination.root, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
    expect(() => readFileSync(path.join(destination.root, 'feature.txt'))).toThrow();
    const isolatedRef = `refs/mingle/incoming/${imported.id}`;
    expect(importRunGit(destination.root, ['rev-parse', isolatedRef]).trim()).toBe(offer.sourceHead);

    const state = await fingerprintRepository(destination.root);
    const integration = await pair.destinationService.requestIntegration({ teamId: pair.teamId, sharedProjectId: pair.sharedProjectId,
      incomingRequestId: imported.id, action: 'merge', expectedHead: state.head, expectedFingerprint: state.fingerprint });
    expect(integration.direction).toBe('local');
    expect(importRunGit(destination.root, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
    await pair.destinationService.decide({ requestId: integration.id, decision: 'approved', expectedDigest: integration.requestDigest });
    expect(readFileSync(path.join(destination.root, 'feature.txt'), 'utf8')).toBe('committed only\n');
    expect(readFileSync(path.join(destination.root, 'payload.bin')).equals(binary)).toBe(true);
    expect(importRunGit(destination.root, ['rev-parse', 'HEAD']).trim()).toBe(offer.sourceHead);
    expect((await pair.destinationService.snapshot(pair.teamId)).audit.some((entry) => entry.action === 'merge-completed')).toBe(true);
    expect(() => destination.db.prepare('UPDATE mingle_git_audit SET action=?').run('tamper')).toThrow(/append-only/);
  });

  it('detects overlapping paths in a temporary index/worktree without overwriting local edits', async () => {
    const { source, destination } = prepareClones();
    writeFileSync(path.join(source.root, 'README.md'), 'source branch\n');
    importRunGit(source.root, ['add', 'README.md']);
    importRunGit(source.root, ['commit', '-q', '-m', 'source readme']);
    writeFileSync(path.join(destination.root, 'README.md'), 'destination branch\n');
    importRunGit(destination.root, ['add', 'README.md']);
    importRunGit(destination.root, ['commit', '-q', '-m', 'destination readme']);
    const beforeHead = importRunGit(destination.root, ['rev-parse', 'HEAD']).trim();
    const pair = await bindPair(source, destination);
    const { imported } = await transferAndApprove(source, destination, pair);
    expect(imported.status).toBe('conflict');
    expect(imported.conflictPaths).toContain('README.md');
    expect(importRunGit(destination.root, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
    expect(readFileSync(path.join(destination.root, 'README.md'), 'utf8')).toBe('destination branch\n');
  });

  it('uses the team-scoped local device identity and rechecks active peer authorization for decisions', async () => {
    const { source, destination } = prepareClones();
    writeFileSync(path.join(source.root, 'other.txt'), 'data\n');
    importRunGit(source.root, ['add', 'other.txt']);
    importRunGit(source.root, ['commit', '-q', '-m', 'other']);
    const teamId = 'team-blue';
    const pair = await bindPair(source, destination, teamId);
    const sourceHead = importRunGit(source.root, ['rev-parse', 'HEAD']).trim();
    const baseHead = importRunGit(source.root, ['rev-parse', 'HEAD^']).trim();
    const request = await pair.sourceService.request({ teamId, sharedProjectId: pair.sharedProjectId,
      toDeviceId: destination.deviceFor(teamId), expectedHead: sourceHead, baseHead, idempotencyKey: 'key-1' });
    expect(source.messages[0]?.toDeviceId).toBe(destination.deviceFor(teamId));
    const offer = source.messages[0]!;
    await pair.destinationService.onEnvelope(envelope({ teamId, fromDeviceId: source.deviceFor(teamId), toDeviceId: destination.deviceFor(teamId), kind: offer.kind, payload: offer.payload }));
    const pending = (await pair.destinationService.snapshot(teamId)).requests[0]!;
    destination.revokedPeers.add(`${teamId}:${source.deviceFor(teamId)}`);
    await expect(pair.destinationService.decide({ requestId: pending.id, decision: 'approved', expectedDigest: pending.requestDigest })).rejects.toThrow(/revoked/);
    expect((await pair.destinationService.snapshot(teamId)).requests).toHaveLength(0);
    expect(request.status).toBe('awaiting-source-approval');
    expect(source.messages.every((message) => message.kind !== 'git.bundle.chunk')).toBe(true);
  });

  it('does not publish a prepared bundle after source HEAD or configuration changes following approval', async () => {
    const { source, destination } = prepareClones();
    writeFileSync(path.join(source.root, 'prepared.txt'), 'approved snapshot\n');
    importRunGit(source.root, ['add', 'prepared.txt']);
    importRunGit(source.root, ['commit', '-q', '-m', 'prepared snapshot']);
    const pair = await bindPair(source, destination);
    const sourceHead = importRunGit(source.root, ['rev-parse', 'HEAD']).trim();
    const baseHead = importRunGit(source.root, ['rev-parse', 'HEAD^']).trim();
    const request = await pair.sourceService.request({ teamId: pair.teamId, sharedProjectId: pair.sharedProjectId,
      toDeviceId: destination.deviceFor(pair.teamId), expectedHead: sourceHead, baseHead });
    const offer = source.messages.find((message) => message.kind === 'git.offer')!;
    await pair.destinationService.onEnvelope(envelope({ teamId: pair.teamId, fromDeviceId: source.deviceFor(pair.teamId),
      toDeviceId: destination.deviceFor(pair.teamId), kind: offer.kind, payload: offer.payload }));
    const pending = (await pair.destinationService.snapshot(pair.teamId)).requests[0]!;
    await pair.sourceService.decide({ requestId: request.id, decision: 'approved', expectedDigest: request.requestDigest });
    expect(source.messages.filter((message) => message.kind === 'git.bundle.chunk')).toHaveLength(0);

    writeFileSync(path.join(source.root, 'later-edit.txt'), 'changed after approval\n');
    const changed = destination.messages.find((message) => message.kind === 'git.import-approved');
    expect(changed).toBeUndefined();
    await pair.destinationService.decide({ requestId: pending.id, decision: 'approved', expectedDigest: pending.requestDigest });
    const importApproval = destination.messages.find((message) => message.kind === 'git.import-approved')!;
    await pair.sourceService.onEnvelope(envelope({ teamId: pair.teamId, fromDeviceId: destination.deviceFor(pair.teamId),
      toDeviceId: source.deviceFor(pair.teamId), kind: importApproval.kind, payload: importApproval.payload }));
    expect(source.messages.filter((message) => message.kind === 'git.bundle.chunk')).toHaveLength(0);
    expect((await pair.sourceService.snapshot(pair.teamId)).requests[0]?.status).toBe('stale');
  });
});

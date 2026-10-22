import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteCommandService } from './commands.ts';
import { envelope, importRunGit, makeOwner, setGitIdentity, type OwnerFixture } from './git-test-utils.ts';
import { makeRepo } from '../test-utils.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function preparePair() {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'mingle-commands-case-'));
  const base = makeRepo({ 'README.md': 'command workspace\n' });
  const sourceRoot = path.join(parent, 'source');
  const destinationRoot = path.join(parent, 'destination');
  execFileSync('git', ['clone', '-q', base, sourceRoot], { cwd: parent });
  execFileSync('git', ['clone', '-q', base, destinationRoot], { cwd: parent });
  setGitIdentity(sourceRoot);
  setGitIdentity(destinationRoot);
  const source = makeOwner(sourceRoot, 'command-source-owner', 'command-source');
  const destination = makeOwner(destinationRoot, 'command-destination-owner', 'command-destination');
  cleanups.push(() => { source.close(); destination.close(); rmSync(parent, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });
  const teamId = 'team-commands';
  const sharedProjectId = 'shared-command-project';
  return { parent, base, source, destination, teamId, sharedProjectId };
}

async function bindPair(source: OwnerFixture, destination: OwnerFixture, teamId: string, sharedProjectId: string) {
  const sourceService = new RemoteCommandService(source.options);
  const destinationService = new RemoteCommandService(destination.options);
  await sourceService.bindProject({ teamId, sharedProjectId, localProjectId: source.projectId });
  await destinationService.bindProject({ teamId, sharedProjectId, localProjectId: destination.projectId });
  return { sourceService, destinationService };
}

function deliver(input: { teamId: string; fromDeviceId: string; toDeviceId: string; kind: string; payload: unknown }) {
  return envelope(input);
}

describe('RemoteCommandService', () => {
  it('keeps commands typed and read-only, requires the receiving owner, and deduplicates delivery and approval', async () => {
    const { source, destination, teamId, sharedProjectId } = preparePair();
    const pair = await bindPair(source, destination, teamId, sharedProjectId);
    let executions = 0;
    const receiver = new RemoteCommandService({ ...destination.options, execute: async (_cwd, operation) => {
      executions++;
      return { output: `read-only ${operation.kind}\n`, exitCode: 0, truncated: false };
    } });
    const outbound = await pair.sourceService.request({ teamId, sharedProjectId, toDeviceId: destination.deviceFor(teamId),
      operation: { kind: 'git.head' }, cwd: '.' });
    const requestMessage = source.messages.find((message) => message.kind === 'command.request')!;
    await receiver.onEnvelope(deliver({ teamId, fromDeviceId: source.deviceFor(teamId), toDeviceId: destination.deviceFor(teamId),
      kind: requestMessage.kind, payload: requestMessage.payload }));
    const pending = (await receiver.snapshot(teamId)).requests[0]!;
    expect(pending.status).toBe('awaiting-approval');
    expect(executions).toBe(0);
    await expect(receiver.decide({ requestId: pending.id, decision: 'approved', expectedDigest: 'f'.repeat(64) })).rejects.toThrow(/changed after review/);
    await Promise.all([
      receiver.decide({ requestId: pending.id, decision: 'approved', expectedDigest: pending.requestDigest }),
      receiver.decide({ requestId: pending.id, decision: 'approved', expectedDigest: pending.requestDigest }),
    ]);
    expect(executions).toBe(1);
    expect(destination.messages[0]?.kind).toBe('command.result');
    await receiver.onEnvelope(deliver({ teamId, fromDeviceId: source.deviceFor(teamId), toDeviceId: destination.deviceFor(teamId),
      kind: requestMessage.kind, payload: requestMessage.payload }));
    await receiver.decide({ requestId: pending.id, decision: 'approved', expectedDigest: pending.requestDigest });
    expect(executions).toBe(1);
    const result = destination.messages.find((message) => message.kind === 'command.result')!;
    await pair.sourceService.onEnvelope(deliver({ teamId, fromDeviceId: destination.deviceFor(teamId), toDeviceId: source.deviceFor(teamId),
      kind: result.kind, payload: result.payload }));
    expect((await pair.sourceService.snapshot(teamId)).requests.find((request) => request.id === outbound.id)?.status).toBe('completed');
    expect((await receiver.snapshot(teamId)).audit.filter((entry) => entry.action === 'command-dispatched')).toHaveLength(1);
    expect(() => destination.db.prepare('DELETE FROM mingle_command_audit').run()).toThrow(/append-only/);
  });

  it('runs the fixed Git allowlist and rejects interpreters, raw argv, traversal and symlink cwd', async () => {
    const { source, destination, teamId, sharedProjectId } = preparePair();
    const pair = await bindPair(source, destination, teamId, sharedProjectId);
    const sourceHead = importRunGit(source.root, ['rev-parse', 'HEAD']).trim();
    const request = await pair.sourceService.request({ teamId, sharedProjectId, toDeviceId: destination.deviceFor(teamId),
      operation: { kind: 'git.head' }, cwd: '.' });
    const requestMessage = source.messages.at(-1)!;
    const receiver = new RemoteCommandService(destination.options);
    await receiver.onEnvelope(deliver({ teamId, fromDeviceId: source.deviceFor(teamId), toDeviceId: destination.deviceFor(teamId), kind: requestMessage.kind, payload: requestMessage.payload }));
    const pending = (await receiver.snapshot(teamId)).requests[0]!;
    const completed = await receiver.decide({ requestId: pending.id, decision: 'approved', expectedDigest: pending.requestDigest });
    expect(completed.output?.trim()).toBe(sourceHead);
    expect(completed.exitCode).toBe(0);

    const beforeCount = (await receiver.snapshot(teamId)).requests.length;
    const malicious = async (requestId: string, payload: unknown) => receiver.onEnvelope(deliver({ teamId,
      fromDeviceId: source.deviceFor(teamId), toDeviceId: destination.deviceFor(teamId), kind: 'command.request',
      payload: { requestId, sharedProjectId, operation: { kind: 'git.status' }, cwd: '.', ...payload as object } }));
    await expect(malicious('bad-raw-argv', { operation: { kind: 'git.status', args: [';touch /tmp/owned'] } })).rejects.toThrow(/Malformed typed command request/);
    await expect(malicious('bad-program', { operation: { kind: 'node', args: ['-e', 'process.exit(0)'] } })).rejects.toThrow(/Malformed typed command request/);
    await expect(malicious('bad-parent', { cwd: '../outside' })).rejects.toThrow(/traversal/);
    const outside = mkdtempSync(path.join(os.tmpdir(), 'mingle-command-outside-'));
    symlinkSync(outside, path.join(destination.root, 'escape'), 'dir');
    await expect(malicious('bad-symlink', { cwd: 'escape' })).rejects.toThrow(/Symlink traversal/);
    expect((await receiver.snapshot(teamId)).requests).toHaveLength(beforeCount);
    rmSync(outside, { recursive: true, force: true });
  });

  it('rechecks peer authorization at approval time and records dispatched restart outcomes as unknown without replay', async () => {
    const { source, destination, teamId, sharedProjectId } = preparePair();
    const pair = await bindPair(source, destination, teamId, sharedProjectId);
    let executions = 0;
    const receiver = new RemoteCommandService({ ...destination.options, execute: async () => {
      executions++;
      return { output: 'executed', exitCode: 0, truncated: false };
    } });
    await pair.sourceService.request({ teamId, sharedProjectId, toDeviceId: destination.deviceFor(teamId), operation: { kind: 'git.status' } });
    const command = source.messages.find((message) => message.kind === 'command.request')!;
    const incoming = deliver({ teamId, fromDeviceId: source.deviceFor(teamId), toDeviceId: destination.deviceFor(teamId), kind: command.kind, payload: command.payload });
    await receiver.onEnvelope(incoming);
    const pending = (await receiver.snapshot(teamId)).requests[0]!;
    destination.revokedPeers.add(`${teamId}:${source.deviceFor(teamId)}`);
    await expect(receiver.decide({ requestId: pending.id, decision: 'approved', expectedDigest: pending.requestDigest })).rejects.toThrow(/revoked/);
    expect(executions).toBe(0);
    expect((await receiver.snapshot(teamId)).requests).toHaveLength(0);

    destination.revokedPeers.clear();
    const second = new RemoteCommandService({ ...destination.options, execute: async () => {
      executions++;
      return { output: 'unknown test', exitCode: 0, truncated: false };
    } });
    await second.onEnvelope({ ...incoming, id: 'replayed-envelope', payload: { ...(command.payload as object), requestId: 'restart-command' } });
    const restartPending = (await second.snapshot(teamId)).requests[0]!;
    destination.db.prepare("UPDATE mingle_remote_command_requests SET status='dispatched' WHERE id=?").run(restartPending.id);
    const recovered = new RemoteCommandService({ ...destination.options, execute: async () => {
      executions++;
      return { output: 'must not replay', exitCode: 0, truncated: false };
    } });
    const unknown = (await recovered.snapshot(teamId)).requests.find((row) => row.id === restartPending.id)!;
    expect(unknown.status).toBe('unknown');
    await recovered.decide({ requestId: unknown.id, decision: 'approved', expectedDigest: unknown.requestDigest });
    expect(executions).toBe(0);
  });
});

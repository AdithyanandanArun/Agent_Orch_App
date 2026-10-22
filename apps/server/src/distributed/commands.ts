import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DistributedRequestDecisionSchema, RemoteCommandRequestSchema, RemoteCommandResultSchema } from '../../../../packages/contracts/src/remote-git.ts';
import type { DistributedDeviceEnvelope, RemoteCommandOperation, RemoteCommandRequestInput, RemoteCommandServiceSnapshot as RemoteCommandServiceSnapshotType, RemoteCommandSnapshot } from '../../../../packages/contracts/src/remote-git.ts';
import { conflict, errorMessage, nowIso, redactSecrets, truncate } from '../util.ts';
import {
  bindProject, currentUser, dbOf, ensureCommonTables, fingerprintRepository,
  insertAudit, MAX_COMMAND_OUTPUT_BYTES, parseJson, repositoryGit, resolveProjectBinding, scopedDirectory, validateEnvelope,
} from './git-common.ts';
import type { DistributedServiceOptions } from './git-common.ts';

const TABLE = 'mingle_remote_command_requests';
const AUDIT = 'mingle_command_audit';

interface CommandRow {
  id: string; team_id: string; shared_project_id: string; owner_id: string; peer_device_id: string;
  direction: 'incoming' | 'outgoing'; status: string; operation_key: string | null; external_id: string | null;
  payload_json: string; request_digest: string; cwd: string; expected_head: string | null; expected_fingerprint: string | null;
  exit_code: number | null; output: string | null; output_truncated: number; error: string | null;
  created_at: string; updated_at: string;
}

type CommandWirePayload = { requestId: string; sharedProjectId: string; operation: RemoteCommandOperation; cwd: string };

export interface CommandExecutionResult { output: string; exitCode: number; truncated: boolean }
export interface RemoteCommandServiceOptions extends DistributedServiceOptions {
  /** Optional process adapter for focused tests; the production default is the fixed read-only Git allowlist below. */
  execute?: (cwd: string, operation: RemoteCommandOperation) => Promise<CommandExecutionResult>;
}

/** Executes a narrow set of read-only Git inspections after exact approval on the receiving device. */
export class RemoteCommandService {
  private readonly db: DatabaseSync;
  constructor(private readonly options: RemoteCommandServiceOptions) {
    this.db = dbOf(options.store);
    ensureCommonTables(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL, shared_project_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        peer_device_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')), status TEXT NOT NULL,
        operation_key TEXT, external_id TEXT, payload_json TEXT NOT NULL, request_digest TEXT NOT NULL, cwd TEXT NOT NULL,
        expected_head TEXT, expected_fingerprint TEXT, exit_code INTEGER, output TEXT, output_truncated INTEGER NOT NULL DEFAULT 0,
        error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(direction,peer_device_id,external_id), UNIQUE(owner_id,team_id,shared_project_id,operation_key)
      );
      CREATE INDEX IF NOT EXISTS mingle_commands_recent ON ${TABLE}(team_id,shared_project_id,created_at);
      CREATE TABLE IF NOT EXISTS ${AUDIT} (
        id TEXT PRIMARY KEY, request_id TEXT, action TEXT NOT NULL, actor_device_id TEXT, digest TEXT,
        details_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS mingle_command_audit_no_update BEFORE UPDATE ON ${AUDIT} BEGIN SELECT RAISE(ABORT, 'Command audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS mingle_command_audit_no_delete BEFORE DELETE ON ${AUDIT} BEGIN SELECT RAISE(ABORT, 'Command audit is append-only'); END;
    `);
    this.recoverInterrupted();
  }

  private recoverInterrupted(): void {
    const rows = this.db.prepare(`SELECT id FROM ${TABLE} WHERE direction='incoming' AND status='dispatched'`).all() as Array<{ id: string }>;
    for (const { id } of rows) {
      this.db.prepare(`UPDATE ${TABLE} SET status='unknown',error=?,updated_at=? WHERE id=?`)
        .run('Command dispatch was interrupted by server restart. It was not replayed.', nowIso(), id);
      insertAudit(this.db, AUDIT, { requestId: id, action: 'recovered-unknown', details: { reason: 'A dispatched command is never automatically repeated after restart.' } });
    }
  }

  async bindProject(input: unknown) { return bindProject(this.options, this.db, input); }

  async snapshot(teamId?: string): Promise<RemoteCommandServiceSnapshotType> {
    const owner = await currentUser(this.options.account);
    if (teamId) await this.options.authorizeTeam({ teamId });
    const scopeRows = this.db.prepare(`SELECT team_id,peer_device_id FROM ${TABLE} WHERE owner_id=?${teamId ? ' AND team_id=?' : ''}`)
      .all(...(teamId ? [owner.id, teamId] : [owner.id])) as Array<{ team_id: string; peer_device_id: string }>;
    const bindingScopes = this.db.prepare(`SELECT DISTINCT team_id FROM mingle_distributed_project_bindings WHERE owner_id=?${teamId ? ' AND team_id=?' : ''}`)
      .all(...(teamId ? [owner.id, teamId] : [owner.id])) as Array<{ team_id: string }>;
    const allowedTeams = new Set<string>();
    for (const id of new Set([...scopeRows.map((row) => row.team_id), ...bindingScopes.map((row) => row.team_id)])) {
      try { await this.options.authorizeTeam({ teamId: id }); allowedTeams.add(id); } catch { /* revoked teams are omitted */ }
    }
    const allowedPeers = new Set(scopeRows.filter((row) => allowedTeams.has(row.team_id)).map((row) => `${row.team_id}\0${row.peer_device_id}`));
    for (const row of scopeRows) {
      if (!allowedTeams.has(row.team_id)) continue;
      try { await this.options.authorizeTeam({ teamId: row.team_id, peerDeviceId: row.peer_device_id }); }
      catch { allowedPeers.delete(`${row.team_id}\0${row.peer_device_id}`); }
    }
    const teamIds = [...allowedTeams];
    if (!teamIds.length) return { bindings: [], requests: [], audit: [] };
    const placeholders = teamIds.map(() => '?').join(',');
    const bindingRows = this.db.prepare(`SELECT team_id,shared_project_id,local_project_id,canonical_path,owner_id,updated_at
      FROM mingle_distributed_project_bindings WHERE owner_id=? AND team_id IN (${placeholders}) ORDER BY updated_at DESC LIMIT 500`)
      .all(owner.id, ...teamIds) as Array<Record<string, unknown>>;
    const rows = (this.db.prepare(`SELECT * FROM ${TABLE} WHERE owner_id=? AND team_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 500`)
      .all(owner.id, ...teamIds) as unknown as CommandRow[]).filter((row) => allowedPeers.has(`${row.team_id}\0${row.peer_device_id}`));
    const requestIds = new Set(rows.map((row) => row.id));
    const auditRows = this.db.prepare(`SELECT a.id,a.request_id,a.action,a.actor_device_id,a.digest,a.details_json,a.created_at
      FROM ${AUDIT} a JOIN ${TABLE} r ON r.id=a.request_id WHERE r.owner_id=? AND r.team_id IN (${placeholders}) ORDER BY a.rowid DESC LIMIT 2000`)
      .all(owner.id, ...teamIds) as Array<Record<string, unknown>>;
    const audits = auditRows.filter((row) => requestIds.has(row.request_id as string)).slice(0, 2000).map((row) => ({
      id: row.id as string, requestId: row.request_id as string | null, action: row.action as string,
      actorDeviceId: row.actor_device_id as string | null, digest: row.digest as string | null,
      details: parseJson<Record<string, unknown>>(row.details_json, 'audit details'), createdAt: row.created_at as string,
    }));
    return {
      bindings: bindingRows.map((row) => ({ teamId: row.team_id as string, sharedProjectId: row.shared_project_id as string,
        localProjectId: row.local_project_id as string, canonicalPath: row.canonical_path as string,
        ownerId: row.owner_id as string, updatedAt: row.updated_at as string })),
      requests: rows.map((row) => this.mapRow(row)), audit: audits,
    };
  }

  async request(input: RemoteCommandRequestInput | unknown): Promise<RemoteCommandSnapshot> {
    const parsed = RemoteCommandRequestSchema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid remote command request: ${parsed.error.issues[0]?.message ?? 'schema validation failed'}`);
    const request = parsed.data;
    const owner = await currentUser(this.options.account);
    const ownDeviceId = this.localDeviceId(request.teamId);
    if (request.toDeviceId === ownDeviceId) throw new Error('A remote command must target another linked device.');
    await this.options.authorizeTeam({ teamId: request.teamId, peerDeviceId: request.toDeviceId });
    const targetCwd = normalizeCwd(request.cwd);
    const existing = request.idempotencyKey ? this.findOperation(owner.id, request.teamId, request.sharedProjectId, request.idempotencyKey) : undefined;
    if (existing) {
      const prior = parseJson<CommandWirePayload>(existing.payload_json, 'command payload');
      if (existing.peer_device_id !== request.toDeviceId || prior.cwd !== targetCwd
        || JSON.stringify(prior.operation) !== JSON.stringify(request.operation)) {
        throw conflict('This idempotency key was already used for a different remote command request.');
      }
      return this.mapRow(existing);
    }
    const binding = await resolveProjectBinding(this.options, this.db, request, owner.id);
    const id = randomUUID().replaceAll('-', '');
    const payload: CommandWirePayload = { requestId: id, sharedProjectId: request.sharedProjectId, operation: request.operation, cwd: targetCwd };
    const digest = digestOf(payload);
    const at = nowIso();
    this.db.prepare(`INSERT INTO ${TABLE}(id,team_id,shared_project_id,owner_id,peer_device_id,direction,status,operation_key,
      external_id,payload_json,request_digest,cwd,expected_head,expected_fingerprint,created_at,updated_at)
      VALUES (?,?,?,?,?,'outgoing','dispatched',?,?,?,?,?,?,?, ?,?)`)
      .run(id, request.teamId, request.sharedProjectId, owner.id, request.toDeviceId, request.idempotencyKey ?? null, id,
        JSON.stringify(payload), digest, targetCwd, null, null, at, at);
    insertAudit(this.db, AUDIT, { requestId: id, action: 'command-request-sent', actorDeviceId: this.localDeviceId(request.teamId), digest,
      details: { operation: request.operation.kind, cwd: targetCwd, peerDeviceId: request.toDeviceId } });
    try {
      await this.options.transport.send({ teamId: request.teamId, toDeviceId: request.toDeviceId, kind: 'command.request', payload, idempotencyKey: `command:${id}:request` });
    } catch (error) {
      this.setResult(id, { status: 'failed', error: `Request was not delivered: ${errorMessage(error).slice(0, 500)}`, output: null, outputTruncated: false, exitCode: null });
      insertAudit(this.db, AUDIT, { requestId: id, action: 'command-request-send-failed', actorDeviceId: ownDeviceId, digest });
      throw error;
    }
    this.options.changed?.();
    return this.mapRow(this.requireRow(id));
  }

  async decide(input: unknown): Promise<RemoteCommandSnapshot> {
    const parsed = DistributedRequestDecisionSchema.safeParse(input);
    if (!parsed.success) throw new Error(`Invalid command decision: ${parsed.error.issues[0]?.message ?? 'schema validation failed'}`);
    const decision = parsed.data;
    const owner = await currentUser(this.options.account);
    const row = this.requireRow(decision.requestId);
    await this.options.authorizeTeam({ teamId: row.team_id, peerDeviceId: row.peer_device_id });
    if (row.direction !== 'incoming' || row.owner_id !== owner.id) throw conflict('This command request is not owned by this receiving device.');
    if (row.request_digest !== decision.expectedDigest) throw conflict('The exact command request changed after review. Reload before deciding.');
    if (row.status !== 'awaiting-approval') return this.mapRow(row);
    const binding = await resolveProjectBinding(this.options, this.db, row, owner.id);
    if (decision.decision === 'denied') {
      if (!this.transitionResult(row, 'denied', { error: 'Receiving device owner denied this exact command request.', output: null, outputTruncated: false, exitCode: null }, 'command-denied')) return this.mapRow(this.requireRow(row.id));
      await this.sendResult(this.requireRow(row.id));
      this.options.changed?.();
      return this.mapRow(this.requireRow(row.id));
    }
    const state = await fingerprintRepository(binding.canonicalPath, this.options.repository);
    if (state.head !== row.expected_head || state.fingerprint !== row.expected_fingerprint) {
      this.transitionResult(row, 'failed', { error: 'Project HEAD, files, or Git configuration changed after the request was received.', output: null, outputTruncated: false, exitCode: null }, 'command-rejected-stale');
      await this.sendResult(this.requireRow(row.id));
      throw conflict('Project state changed after the owner reviewed the request. A new command request is required.');
    }
    const cwd = await scopedDirectory(binding.canonicalPath, row.cwd);
    const operation = parseJson<CommandWirePayload>(row.payload_json, 'command payload').operation;
    await this.options.authorizeTeam({ teamId: row.team_id, peerDeviceId: row.peer_device_id });
    if (!this.transitionResult(row, 'dispatched', {}, 'command-dispatched', { operation: operation.kind, cwd: row.cwd, expectedHead: state.head, expectedFingerprint: state.fingerprint })) return this.mapRow(this.requireRow(row.id));
    this.options.changed?.();
    try {
      const result = this.options.execute
        ? await this.options.execute(cwd, operation)
        : await executeReadonlyGit(cwd, operation, this.options.repository);
      const output = truncate(redactSecrets(result.output), MAX_COMMAND_OUTPUT_BYTES);
      const bytes = Buffer.byteLength(output);
      const safeOutput = bytes > MAX_COMMAND_OUTPUT_BYTES ? truncateBytes(output, MAX_COMMAND_OUTPUT_BYTES) : output;
      this.transitionResult(this.requireRow(row.id), 'completed', { output: safeOutput, outputTruncated: result.truncated || bytes > MAX_COMMAND_OUTPUT_BYTES, exitCode: result.exitCode, error: null }, 'command-completed',
        { exitCode: result.exitCode, outputBytes: Buffer.byteLength(safeOutput), outputTruncated: result.truncated || bytes > MAX_COMMAND_OUTPUT_BYTES });
    } catch (error) {
      const message = errorMessage(error).slice(0, 800);
      // After dispatch the command's effects cannot be inferred from a process error; never retry it automatically.
      this.transitionResult(this.requireRow(row.id), 'unknown', { error: message, output: null, outputTruncated: false, exitCode: null }, 'command-outcome-unknown', { message });
    }
    await this.sendResult(this.requireRow(row.id)).catch(() => undefined);
    this.options.changed?.();
    return this.mapRow(this.requireRow(row.id));
  }

  async onEnvelope(envelopeInput: DistributedDeviceEnvelope | unknown): Promise<void> {
    const envelope = validateEnvelope(envelopeInput, (teamId) => this.localDeviceId(teamId));
    const ownDeviceId = this.localDeviceId(envelope.teamId);
    if (envelope.fromDeviceId === ownDeviceId) throw new Error('A device cannot process its own distributed envelope.');
    await this.options.authorizeTeam({ teamId: envelope.teamId, peerDeviceId: envelope.fromDeviceId });
    const owner = await currentUser(this.options.account);
    switch (envelope.kind) {
      case 'command.request': return this.receiveRequest(envelope, owner.id);
      case 'command.result': return this.receiveResult(envelope, owner.id);
      default: throw new Error(`Unsupported command transport kind: ${envelope.kind}`);
    }
  }

  private async receiveRequest(envelope: DistributedDeviceEnvelope, ownerId: string): Promise<void> {
    const raw = envelope.payload as Partial<CommandWirePayload>;
    const parsed = RemoteCommandRequestSchema.safeParse({
      teamId: envelope.teamId, sharedProjectId: raw?.sharedProjectId, toDeviceId: this.localDeviceId(envelope.teamId),
      operation: raw?.operation, cwd: raw?.cwd,
    });
    if (!parsed.success || !raw || typeof raw.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(raw.requestId)) throw new Error('Malformed typed command request.');
    const request = parsed.data;
    const cwd = normalizeCwd(request.cwd);
    const payload: CommandWirePayload = { requestId: raw.requestId, sharedProjectId: request.sharedProjectId, operation: request.operation, cwd };
    const ownDeviceId = this.localDeviceId(envelope.teamId);
    const wireDigest = digestOf({ fromDeviceId: envelope.fromDeviceId, toDeviceId: ownDeviceId, teamId: envelope.teamId, ...payload });
    const existing = this.db.prepare(`SELECT * FROM ${TABLE} WHERE direction='incoming' AND peer_device_id=? AND external_id=?`).get(envelope.fromDeviceId, raw.requestId) as CommandRow | undefined;
    if (existing) {
      const previousPayload = parseJson<CommandWirePayload>(existing.payload_json, 'command payload');
      const previousWireDigest = digestOf({ fromDeviceId: existing.peer_device_id, toDeviceId: ownDeviceId, teamId: existing.team_id, ...previousPayload });
      if (previousWireDigest !== wireDigest) throw conflict('A duplicate command request changed its immutable operation or target.');
      return;
    }
    const binding = await resolveProjectBinding(this.options, this.db, { teamId: request.teamId, sharedProjectId: request.sharedProjectId, peerDeviceId: envelope.fromDeviceId }, ownerId);
    // Resolve now and again immediately before dispatch. This detects symlink traversal without trusting peer paths.
    await scopedDirectory(binding.canonicalPath, cwd);
    const state = await fingerprintRepository(binding.canonicalPath, this.options.repository);
    const digest = digestOf({ wireDigest, expectedHead: state.head, expectedFingerprint: state.fingerprint });
    const id = randomUUID().replaceAll('-', '');
    const at = nowIso();
    this.db.prepare(`INSERT INTO ${TABLE}(id,team_id,shared_project_id,owner_id,peer_device_id,direction,status,operation_key,
      external_id,payload_json,request_digest,cwd,expected_head,expected_fingerprint,created_at,updated_at)
      VALUES (?,?,?,?,?,'incoming', 'awaiting-approval',NULL,?,?,?,?,?,?,?,?)`)
      .run(id, envelope.teamId, request.sharedProjectId, ownerId, envelope.fromDeviceId, raw.requestId, JSON.stringify(payload),
        digest, cwd, state.head, state.fingerprint, at, at);
    insertAudit(this.db, AUDIT, { requestId: id, action: 'command-request-received', actorDeviceId: envelope.fromDeviceId, digest,
      details: { operation: request.operation.kind, cwd, expectedHead: state.head, expectedFingerprint: state.fingerprint } });
    this.options.changed?.();
  }

  private async receiveResult(envelope: DistributedDeviceEnvelope, ownerId: string): Promise<void> {
    const parsed = RemoteCommandResultSchema.safeParse(envelope.payload);
    if (!parsed.success) throw new Error('Malformed remote command result.');
    const result = parsed.data;
    const row = this.db.prepare(`SELECT * FROM ${TABLE} WHERE direction='outgoing' AND peer_device_id=? AND id=?`).get(envelope.fromDeviceId, result.requestId) as CommandRow | undefined;
    if (!row) throw new Error('Command result does not match a request sent to this device.');
    await resolveProjectBinding(this.options, this.db, row, ownerId);
    if (row.status !== 'dispatched') return;
    this.setResult(row.id, { status: result.status, exitCode: result.exitCode, output: result.output, outputTruncated: result.outputTruncated, error: result.error });
    insertAudit(this.db, AUDIT, { requestId: row.id, action: 'command-result-received', actorDeviceId: envelope.fromDeviceId, digest: row.request_digest,
      details: { status: result.status, exitCode: result.exitCode, outputTruncated: result.outputTruncated } });
    this.options.changed?.();
  }

  private async sendResult(row: CommandRow): Promise<void> {
    await this.options.authorizeTeam({ teamId: row.team_id, peerDeviceId: row.peer_device_id });
    const payload = {
      requestId: row.external_id!, status: row.status as 'completed' | 'failed' | 'denied' | 'unknown', exitCode: row.exit_code,
      output: row.output ?? '', outputTruncated: Boolean(row.output_truncated), error: row.error,
    };
    await this.options.transport.send({ teamId: row.team_id, toDeviceId: row.peer_device_id, kind: 'command.result', payload,
      idempotencyKey: `command:${row.external_id}:result:${payload.status}` });
  }

  private localDeviceId(teamId: string): string {
    const id = this.options.transport.snapshot(teamId).deviceId;
    if (!id || typeof id !== 'string') throw conflict('This device has not registered distributed transport yet.');
    return id;
  }

  private findOperation(ownerId: string, teamId: string, projectId: string, key: string): CommandRow | undefined {
    return this.db.prepare(`SELECT * FROM ${TABLE} WHERE owner_id=? AND team_id=? AND shared_project_id=? AND operation_key=?`).get(ownerId, teamId, projectId, key) as CommandRow | undefined;
  }
  private getRow(id: string): CommandRow | undefined { return this.db.prepare(`SELECT * FROM ${TABLE} WHERE id=?`).get(id) as CommandRow | undefined; }
  private requireRow(id: string): CommandRow {
    const row = this.getRow(id);
    if (!row) throw conflict('Remote command request was not found on this device.');
    return row;
  }
  private setResult(id: string, result: { status: string; exitCode: number | null; output: string | null; outputTruncated: boolean; error: string | null }): void {
    this.db.prepare(`UPDATE ${TABLE} SET status=?,exit_code=?,output=?,output_truncated=?,error=?,updated_at=? WHERE id=?`)
      .run(result.status, result.exitCode, result.output, Number(result.outputTruncated), result.error, nowIso(), id);
    this.options.changed?.();
  }
  private transitionResult(row: CommandRow, status: string, result: Partial<{ exitCode: number | null; output: string | null; outputTruncated: boolean; error: string | null }>, action: string,
    details: Record<string, unknown> = {}): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare(`UPDATE ${TABLE} SET status=?,exit_code=?,output=?,output_truncated=?,error=?,updated_at=? WHERE id=? AND status=?`)
        .run(status, result.exitCode ?? null, result.output ?? null, Number(result.outputTruncated ?? false), result.error ?? null, nowIso(), row.id,
          action === 'command-dispatched' || action === 'command-denied' || action === 'command-rejected-stale' ? 'awaiting-approval' : 'dispatched');
      const changed = Number(update.changes) === 1;
      if (changed) insertAudit(this.db, AUDIT, { requestId: row.id, action, actorDeviceId: this.localDeviceId(row.team_id), digest: row.request_digest, details });
      this.db.exec('COMMIT');
      if (changed) this.options.changed?.();
      return changed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private mapRow(row: CommandRow): RemoteCommandSnapshot {
    const payload = parseJson<CommandWirePayload>(row.payload_json, 'command payload');
    return {
      id: row.id, teamId: row.team_id, sharedProjectId: row.shared_project_id,
      direction: row.direction, peerDeviceId: row.peer_device_id, status: row.status as RemoteCommandSnapshot['status'],
      operation: payload.operation, cwd: row.cwd, expectedHead: row.expected_head, expectedFingerprint: row.expected_fingerprint,
      requestDigest: row.request_digest, exitCode: row.exit_code, output: row.output, outputTruncated: Boolean(row.output_truncated),
      error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}

function normalizeCwd(input: string): string {
  if (input.length > 1024 || input.includes('\0') || input.startsWith('/') || path.win32.isAbsolute(input) || input.includes('\\')) {
    throw new Error('Remote command cwd must be a project-relative POSIX path.');
  }
  const components = input.split('/').filter((part) => part && part !== '.');
  if (components.some((part) => part === '..')) throw new Error('Remote command cwd traversal is not allowed.');
  return components.join('/') || '.';
}

async function executeReadonlyGit(cwd: string, operation: RemoteCommandOperation, repository?: DistributedServiceOptions['repository']): Promise<{ output: string; exitCode: number; truncated: boolean }> {
  let args: string[];
  switch (operation.kind) {
    case 'git.version': args = ['--version']; break;
    case 'git.status': args = ['status', '--short', '--branch', '--untracked-files=all']; break;
    case 'git.head': args = ['rev-parse', '--verify', 'HEAD']; break;
    case 'git.branch': {
      const branch = await repositoryGit(repository, cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true, maxOutputBytes: 4096 });
      return { output: branch.code === 0 ? branch.stdout.toString('utf8') : '(detached HEAD)\n', exitCode: 0, truncated: branch.outputTruncated };
    }
    case 'git.log': args = ['log', '--oneline', '--no-decorate', '-n', String(operation.limit)]; break;
    case 'git.showStat': args = ['show', '--stat', '--oneline', '--no-ext-diff', '--no-textconv', '--no-renames', operation.commit]; break;
    case 'git.diffStat': args = ['diff', '--stat', '--no-ext-diff', '--no-textconv', '--no-renames', operation.base, operation.head, '--']; break;
    default: return assertNever(operation);
  }
  const result = await repositoryGit(repository, cwd, args, { allowFailure: true, timeoutMs: 10_000, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES });
  return { output: `${result.stdout.toString('utf8')}${result.stderr.toString('utf8')}`, exitCode: result.code, truncated: result.outputTruncated };
}

function assertNever(value: never): never { throw new Error(`Unsupported remote command operation: ${String(value)}`); }

function digestOf(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function truncateBytes(text: string, maxBytes: number): string {
  const marker = '\n… [output truncated]';
  const prefixLimit = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let end = Math.min(text.length, prefixLimit);
  while (Buffer.byteLength(text.slice(0, end)) > prefixLimit) end--;
  return `${text.slice(0, end)}${marker}`;
}

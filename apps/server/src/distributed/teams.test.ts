import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import type { TeamRole } from '../../../../packages/contracts/src/teams.ts';
import { AccountService } from '../account/service.ts';
import { TeamService } from './teams.ts';

const TEAM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const NONMEMBER_ID = '44444444-4444-4444-8444-444444444444';
const FIXED_NOW = new Date('2026-10-22T12:00:00.000Z');

type CloudRow = Record<string, unknown>;
type Filter = { column: string; value: unknown };

class FakeQuery {
  private operation: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private body: CloudRow | CloudRow[] | null = null;
  private filters: Filter[] = [];
  private columns = '*';

  constructor(private readonly cloud: FakeCloud, private readonly table: string) {}
  select(columns = '*') { this.columns = columns; return this; }
  insert(body: CloudRow | CloudRow[]) { this.operation = 'insert'; this.body = body; return this; }
  update(body: CloudRow) { this.operation = 'update'; this.body = body; return this; }
  delete() { this.operation = 'delete'; return this; }
  eq(column: string, value: unknown) { this.filters.push({ column, value }); return this; }
  is(column: string, value: unknown) { this.filters.push({ column, value }); return this; }
  order() { return this; }
  limit() { return this; }
  single() { return this.execute(true); }
  maybeSingle() { return this.execute(false, true); }
  then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
    return this.execute(false).then(resolve, reject);
  }

  private async execute(required: boolean, optional = false): Promise<{ data: unknown; error: { code: string } | null }> {
    const rows = this.cloud.execute(this.table, this.operation, this.body, this.filters, this.columns);
    if (this.operation === 'delete') return { data: rows, error: null };
    if (required || optional) {
      if (rows.length === 1) return { data: rows[0], error: null };
      if (optional && rows.length === 0) return { data: null, error: null };
      return { data: null, error: { code: 'PGRST116' } };
    }
    return { data: rows, error: null };
  }
}

class FakeCloud {
  user: User = this.userFor(OWNER_ID, 'owner@example.com', true);
  readonly rows: Record<string, CloudRow[]> = {
    mingle_teams: [],
    mingle_members: [
      { team_id: TEAM_ID, user_id: OWNER_ID, role: 'owner', created_at: FIXED_NOW.toISOString(), revoked_at: null },
    ],
    mingle_invitations: [],
    mingle_projects: [],
  };
  readonly writes: Array<{ table: string; operation: string; body: CloudRow | CloudRow[] | null }> = [];
  acceptedTokenHash: string | null = null;
  verifyCount = 0;
  offline = false;
  private nextId = 0;

  readonly client = {
    from: (table: string) => new FakeQuery(this, table),
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (this.offline) return { data: null, error: { code: '08006' } };
      if (name !== 'accept_mingle_invitation') return { data: null, error: { code: '42883' } };
      const hash = params.p_token_hash;
      const invitation = this.rows.mingle_invitations!.find((row) => row.token_hash === hash);
      if (!invitation || invitation.accepted_at || invitation.email !== this.user.email || !this.user.email_confirmed_at) {
        return { data: null, error: { code: 'P0001' } };
      }
      invitation.accepted_at = FIXED_NOW.toISOString();
      this.acceptedTokenHash = String(hash);
      this.rows.mingle_members!.push({
        team_id: invitation.team_id, user_id: this.user.id, role: invitation.role,
        created_at: FIXED_NOW.toISOString(), revoked_at: null,
      });
      return { data: String(invitation.team_id), error: null };
    },
  } as unknown as SupabaseClient;

  private userFor(id: string, email: string, confirmed: boolean): User {
    return {
      id, aud: 'authenticated', role: 'authenticated', email,
      email_confirmed_at: confirmed ? FIXED_NOW.toISOString() : undefined,
      created_at: FIXED_NOW.toISOString(), app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: {}, identities: [{ provider: 'google' }],
    } as unknown as User;
  }
  useAccount(id: string, email: string, confirmed = true) { this.user = this.userFor(id, email, confirmed); }

  execute(table: string, operation: string, body: CloudRow | CloudRow[] | null, filters: Filter[], columns: string): CloudRow[] {
    if (this.offline) throw new Error('database unavailable');
    if (!this.rows[table]) this.rows[table] = [];
    this.writes.push({ table, operation, body });
    if (operation === 'insert') {
      const inserts = Array.isArray(body) ? body : [body ?? {}];
      const created = inserts.map((value) => ({
        id: value.id ?? `mock-${++this.nextId}`,
        created_at: FIXED_NOW.toISOString(),
        accepted_at: null,
        ...value,
      }));
      this.rows[table]!.push(...created);
      return created;
    }
    const matches = (row: CloudRow) => filters.every(({ column, value }) => row[column] === value);
    if (operation === 'update') {
      const updated = this.rows[table]!.filter(matches);
      for (const row of updated) Object.assign(row, body);
      return updated;
    }
    if (operation === 'delete') {
      const deleted = this.rows[table]!.filter(matches);
      this.rows[table] = this.rows[table]!.filter((row) => !matches(row));
      return deleted;
    }
    const selected = this.rows[table]!.filter(matches);
    if (columns === '*') return selected;
    const fields = columns.split(',').map((field) => field.trim());
    return selected.map((row) => Object.fromEntries(fields.filter((field) => field in row).map((field) => [field, row[field]])));
  }
}

function setup(role: TeamRole = 'owner') {
  const cloud = new FakeCloud();
  if (role !== 'owner') cloud.rows.mingle_members![0]!.role = role;
  const changed = vi.fn();
  const account = {
    snapshot: () => ({ configured: true }),
    withAuthenticatedClient: async <T>(callback: (client: SupabaseClient, user: User) => Promise<T>) => {
      cloud.verifyCount++;
      if (cloud.offline) throw new Error('account connection unavailable');
      return callback(cloud.client, cloud.user);
    },
  };
  const service = new TeamService({ account: account as never, changed, now: () => FIXED_NOW });
  return { cloud, service, changed };
}

it('creates a team with the live account as owner and notifies after persistence', async () => {
  const { cloud, service, changed } = setup();
  const team = await service.createTeam({ name: '  Mingle team  ' });
  expect(team).toEqual({
    id: expect.any(String), name: 'Mingle team', ownerId: OWNER_ID, role: 'owner', createdAt: FIXED_NOW.toISOString(),
  });
  expect(cloud.verifyCount).toBe(1);
  expect(cloud.rows.mingle_teams).toHaveLength(1);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('persists only a SHA-256 invitation hash, returns the one-time token, and enforces seven-day expiry', async () => {
  const { cloud, service, changed } = setup();
  const created = await service.invite({ teamId: TEAM_ID, email: '  New.Member@Example.com ', role: 'member' });
  const stored = cloud.rows.mingle_invitations![0]!;
  expect(created.token).toHaveLength(43);
  expect(stored.email).toBe('new.member@example.com');
  expect(stored.token_hash).toBe(createHash('sha256').update(created.token).digest('hex'));
  expect(stored.token_hash).not.toBe(created.token);
  expect(Date.parse(String(stored.expires_at)) - FIXED_NOW.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  expect(created.invitation).not.toHaveProperty('tokenHash');
  expect(created.invitation).not.toHaveProperty('token_hash');
  expect(changed).toHaveBeenCalledTimes(1);
});

it('rejects invite and project creation for an ordinary member before writing', async () => {
  const { cloud, service, changed } = setup('member');
  await expect(service.invite({ teamId: TEAM_ID, email: 'other@example.com', role: 'member' })).rejects.toMatchObject({ status: 403 });
  await expect(service.createProject({ teamId: TEAM_ID, name: 'Private project', repositoryUrl: null })).rejects.toMatchObject({ status: 403 });
  expect(cloud.writes.filter((write) => write.operation === 'insert')).toHaveLength(0);
  expect(changed).not.toHaveBeenCalled();
});

it('accepts only an invitation for the verified account and rejects replay', async () => {
  const changed = vi.fn();
  const invited = setup();
  invited.cloud.rows.mingle_invitations!.push({
    id: 'invite-1', team_id: TEAM_ID, email: 'member@example.com', role: 'member',
    token_hash: createHash('sha256').update('one-time-invitation-token-value-x').digest('hex'),
    expires_at: new Date(FIXED_NOW.getTime() + 60_000).toISOString(), accepted_at: null, created_at: FIXED_NOW.toISOString(),
  });
  invited.cloud.useAccount(MEMBER_ID, 'member@example.com');
  const hash = String(invited.cloud.rows.mingle_invitations![0]!.token_hash);
  const token = 'one-time-invitation-token-value-x';
  const serviceForInvitee = new TeamService({
    account: {
      snapshot: () => ({ configured: true }),
      withAuthenticatedClient: async <T>(callback: (client: SupabaseClient, user: User) => Promise<T>) => callback(invited.cloud.client, invited.cloud.user),
    } as never,
    changed,
    now: () => FIXED_NOW,
  });
  const member = await serviceForInvitee.acceptInvite({ token });
  expect(member).toMatchObject({ teamId: TEAM_ID, userId: MEMBER_ID, role: 'member', revokedAt: null });
  expect(invited.cloud.acceptedTokenHash).toBe(hash);
  await expect(serviceForInvitee.acceptInvite({ token })).rejects.toMatchObject({ status: 409 });
  expect(changed).toHaveBeenCalledTimes(1);

  invited.cloud.useAccount(OTHER_ID, 'stranger@example.com');
  await expect(serviceForInvitee.acceptInvite({ token })).rejects.toMatchObject({ status: 409 });
});

it('requires a confirmed email before attempting invitation consumption', async () => {
  const { cloud, service } = setup();
  cloud.useAccount(MEMBER_ID, 'member@example.com', false);
  await expect(service.acceptInvite({ token: 'one-time-invitation-token-value-x' })).rejects.toMatchObject({ status: 403 });
  expect(cloud.acceptedTokenHash).toBeNull();
});

it('enforces receiver-side membership and role-aware revocation', async () => {
  const { cloud, service, changed } = setup('admin');
  cloud.rows.mingle_members!.push(
    { team_id: TEAM_ID, user_id: MEMBER_ID, role: 'admin', created_at: FIXED_NOW.toISOString(), revoked_at: null },
    { team_id: TEAM_ID, user_id: OTHER_ID, role: 'member', created_at: FIXED_NOW.toISOString(), revoked_at: null },
  );
  await expect(service.assertMember(TEAM_ID)).resolves.toMatchObject({ userId: OWNER_ID, role: 'admin' });
  await expect(service.revokeMember({ teamId: TEAM_ID, userId: MEMBER_ID })).rejects.toMatchObject({ status: 403 });
  await expect(service.revokeMember({ teamId: TEAM_ID, userId: OWNER_ID })).rejects.toMatchObject({ status: 409 });
  expect(cloud.rows.mingle_members![2]!.revoked_at).toBeNull();
  expect(changed).not.toHaveBeenCalled();

  cloud.useAccount(NONMEMBER_ID, 'outsider@example.com');
  await expect(service.assertMember(TEAM_ID)).rejects.toMatchObject({ status: 403 });
});

it('returns an honest stable snapshot when cloud access is unavailable', async () => {
  const { cloud, service } = setup();
  cloud.offline = true;
  await expect(service.snapshot()).resolves.toEqual({
    teams: [], members: [], invitations: [], projects: [], userId: null, configured: true,
    error: expect.stringContaining('Teams could not be loaded'),
  });
});

function bridgeFixture() {
  const user = {
    id: OWNER_ID, email: 'owner@example.com', email_confirmed_at: FIXED_NOW.toISOString(), is_anonymous: false,
    identities: [{ provider: 'google' }], user_metadata: { full_name: 'Owner' },
  } as unknown as User;
  const client = {
    auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) },
  } as unknown as SupabaseClient;
  const changed = vi.fn();
  const bridge = Object.assign(Object.create(AccountService.prototype), {
    ready: Promise.resolve(),
    closing: new AbortController(),
    mutationInProgress: false,
    generation: 3,
    client,
    attempt: null,
    state: { user: { id: OWNER_ID, email: 'owner@example.com', name: 'Owner' } },
    changed,
    authenticatedOperationContext: new AsyncLocalStorage(),
  }) as AccountService;
  return { bridge, changed, client };
}

it('allows concurrent and nested authenticated-client callbacks without global lock contention', async () => {
  const { bridge, changed, client } = bridgeFixture();
  let release!: () => void;
  const holdOuter = new Promise<void>((resolve) => { release = resolve; });
  const outer = bridge.withAuthenticatedClient(async (_client, user) => {
    await holdOuter;
    return bridge.withAuthenticatedClient(async (nestedClient, nestedUser) => ({
      sameClient: nestedClient === client,
      sameUser: nestedUser.id === user.id,
    }));
  });
  const concurrent = await bridge.withAuthenticatedClient(async (_client, user) => `parallel:${user.id}`);
  expect(concurrent).toBe(`parallel:${OWNER_ID}`);
  release();
  await expect(outer).resolves.toEqual({ sameClient: true, sameUser: true });
  expect(client.auth.getUser).toHaveBeenCalledTimes(3);
  expect(changed).not.toHaveBeenCalled();
});

it('discards callback results if an account mutation fences the verified generation', async () => {
  const { bridge } = bridgeFixture();
  let entered!: () => void;
  let release!: () => void;
  const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
  const holdCallback = new Promise<void>((resolve) => { release = resolve; });
  const pending = bridge.withAuthenticatedClient(async () => {
    entered();
    await holdCallback;
    return 'must-not-escape';
  });
  await callbackEntered;
  Object.assign(bridge, { mutationInProgress: true, generation: 4 });
  release();
  await expect(pending).rejects.toMatchObject({ status: 409 });
});

import type { SupabaseClient, User } from '@supabase/supabase-js';

export interface AcceptanceDevice {
  id: string;
  team_id: string;
  owner_id: string;
  name: string;
  signing_public_key: string;
  encryption_public_key: string;
  fingerprint: string;
  last_seen_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface AcceptanceLink {
  team_id: string;
  device_id: string;
  peer_device_id: string;
  peer_fingerprint: string;
  created_at: string;
}

export interface AcceptanceEnvelope {
  id: string;
  team_id: string;
  from_device_id: string;
  to_device_id: string;
  idempotency_key: string;
  kind: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  created_at: string;
  expires_at: string;
  received_at: string;
}

type Row = Record<string, unknown>;
type QueryError = { code?: string; message: string };
type QueryResult = { data: unknown; error: QueryError | null };
type Filter = { op: 'eq' | 'is' | 'gte' | 'in'; column: string; value: unknown };

/**
 * Local authenticated relay fixture for composed acceptance tests. It stores only signed ciphertext and
 * models the mailbox policies: active membership, device ownership/revocation and reciprocal key pins.
 * It is deliberately a test boundary, not a Supabase/PostgREST deployment emulator.
 */
export class AuthenticatedLocalRelay {
  readonly members = new Map<string, Set<string>>();
  readonly projects: Row[] = [];
  readonly devices: AcceptanceDevice[] = [];
  readonly links: AcceptanceLink[] = [];
  readonly envelopes: AcceptanceEnvelope[] = [];
  failEnvelopeWrites = 0;
  private clock: () => number = Date.now;

  setClock(clock: () => number): void { this.clock = clock; }

  addTeam(teamId: string, ownerIds: string[], sharedProjectId: string): void {
    this.members.set(teamId, new Set(ownerIds));
    this.projects.push({ id: sharedProjectId, team_id: teamId });
  }

  account(ownerId: string): AcceptanceAccount {
    return new AcceptanceAccount(this, ownerId);
  }

  activeMember(teamId: string, ownerId: string): boolean {
    return this.members.get(teamId)?.has(ownerId) ?? false;
  }

  revokeMember(teamId: string, ownerId: string): void {
    this.members.get(teamId)?.delete(ownerId);
  }

  restoreMember(teamId: string, ownerId: string): void {
    const members = this.members.get(teamId);
    if (members) members.add(ownerId);
  }

  client(ownerId: string): SupabaseClient {
    return { from: (table: string) => new RelayQuery(this, ownerId, table) } as unknown as SupabaseClient;
  }

  nowIso(): string { return new Date(this.clock()).toISOString(); }

  private table(name: string): Row[] {
    if (name === 'mingle_members') {
      return [...this.members].flatMap(([team_id, owners]) => [...owners].map((user_id) => ({ team_id, user_id, revoked_at: null })));
    }
    if (name === 'mingle_projects') return this.projects;
    if (name === 'mingle_devices') return this.devices as unknown as Row[];
    if (name === 'mingle_device_links') return this.links as unknown as Row[];
    if (name === 'mingle_envelopes') return this.envelopes as unknown as Row[];
    throw new Error(`Unexpected authenticated relay table: ${name}`);
  }

  async execute(ownerId: string, tableName: string, action: string, values: unknown, filters: Filter[], range: [number, number] | null,
    order: Array<[string, boolean]>, returning: boolean, ignoreDuplicates: boolean): Promise<QueryResult> {
    const rows = this.table(tableName);
    if (action === 'upsert' && tableName === 'mingle_envelopes' && this.failEnvelopeWrites > 0) {
      this.failEnvelopeWrites -= 1;
      return { data: null, error: { code: '503', message: 'The local relay is temporarily unavailable.' } };
    }
    const matches = (row: Row) => filters.every(({ op, column, value }) => {
      if (op === 'is') return row[column] === value;
      if (op === 'gte') return String(row[column]) >= String(value);
      if (op === 'in') return Array.isArray(value) && value.includes(row[column]);
      return row[column] === value;
    });

    if (action === 'select') {
      let selected = rows.filter((row) => matches(row) && this.canRead(ownerId, tableName, row));
      for (const [column, ascending] of [...order].reverse()) {
        selected = selected.sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1));
      }
      if (range) selected = selected.slice(range[0], range[1] + 1);
      return { data: structuredClone(selected), error: null };
    }

    if (action === 'insert' || action === 'upsert') {
      const items = (Array.isArray(values) ? values : [values]) as Row[];
      const inserted: Row[] = [];
      for (const item of items) {
        if (tableName === 'mingle_envelopes' && (action === 'upsert' || ignoreDuplicates)) {
          const existing = this.envelopes.find((row) => row.team_id === item.team_id && row.from_device_id === item.from_device_id &&
            row.to_device_id === item.to_device_id && row.idempotency_key === item.idempotency_key);
          if (existing) continue;
        }
        const error = this.insert(ownerId, tableName, item);
        if (error) return { data: null, error };
        if (returning) inserted.push(rows.at(-1)!);
      }
      return { data: returning ? inserted : null, error: null };
    }

    if (action === 'update') {
      const selected = rows.filter(matches);
      if (tableName !== 'mingle_devices' || !Object.keys(values as Row).every((key) => ['last_seen_at', 'revoked_at'].includes(key))) {
        return { data: null, error: { code: '42501', message: 'The authenticated relay denies this update.' } };
      }
      const updated: Row[] = [];
      for (const row of selected) {
        if (!this.activeMember(String(row.team_id), ownerId) || row.owner_id !== ownerId || row.revoked_at) continue;
        Object.assign(row, values);
        row.last_seen_at = this.nowIso();
        updated.push(structuredClone(row));
      }
      return { data: returning ? updated : null, error: null };
    }

    if (action === 'delete') {
      const removed = rows.filter((row) => matches(row) && this.canDelete(ownerId, tableName, row));
      const remove = new Set(removed);
      const remaining = rows.filter((row) => !remove.has(row));
      rows.splice(0, rows.length, ...remaining);
      return { data: removed, error: null };
    }
    return { data: null, error: { code: '0A000', message: `Unsupported relay operation: ${action}` } };
  }

  private canRead(ownerId: string, table: string, row: Row): boolean {
    const teamId = String(row.team_id ?? '');
    if (!this.activeMember(teamId, ownerId)) return false;
    if (table === 'mingle_members' || table === 'mingle_projects' || table === 'mingle_devices') return true;
    if (table === 'mingle_device_links') {
      return this.owns(ownerId, String(row.device_id), teamId) || this.owns(ownerId, String(row.peer_device_id), teamId);
    }
    if (table !== 'mingle_envelopes') return false;
    const from = this.device(String(row.from_device_id), teamId);
    const to = this.device(String(row.to_device_id), teamId);
    return Boolean(from && to && to.owner_id === ownerId && !from.revoked_at && !to.revoked_at &&
      this.activeMember(teamId, from.owner_id) && Date.parse(String(row.expires_at)) > this.clock() &&
      this.mutual(teamId, from.id, to.id));
  }

  private canDelete(ownerId: string, table: string, row: Row): boolean {
    const teamId = String(row.team_id ?? '');
    if (!this.activeMember(teamId, ownerId)) return false;
    if (table === 'mingle_device_links') return this.owns(ownerId, String(row.device_id), teamId) && !this.device(String(row.device_id), teamId)?.revoked_at;
    if (table === 'mingle_envelopes') return this.device(String(row.to_device_id), teamId)?.owner_id === ownerId;
    return false;
  }

  private insert(ownerId: string, table: string, item: Row): QueryError | null {
    const teamId = String(item.team_id ?? '');
    if (!this.activeMember(teamId, ownerId)) return { code: '42501', message: 'The account is not an active team member.' };
    if (table === 'mingle_devices') {
      if (item.owner_id !== ownerId || this.device(String(item.id), teamId)) return { code: '42501', message: 'Device registration is not owned by this account.' };
      this.devices.push({ ...item, last_seen_at: this.nowIso(), created_at: this.nowIso(), revoked_at: null } as AcceptanceDevice);
      return null;
    }
    if (table === 'mingle_device_links') {
      const own = this.device(String(item.device_id), teamId);
      const peer = this.device(String(item.peer_device_id), teamId);
      if (!own || own.owner_id !== ownerId || own.revoked_at || !peer || peer.revoked_at || peer.fingerprint !== item.peer_fingerprint ||
        !this.activeMember(teamId, peer.owner_id)) return { code: '42501', message: 'The account cannot pin this peer device.' };
      if (this.link(teamId, own.id, peer.id)) return { code: '23505', message: 'This fingerprint pin already exists.' };
      this.links.push({ ...item, created_at: this.nowIso() } as AcceptanceLink);
      return null;
    }
    if (table === 'mingle_envelopes') {
      const from = this.device(String(item.from_device_id), teamId);
      const to = this.device(String(item.to_device_id), teamId);
      if (!from || from.owner_id !== ownerId || !to || from.revoked_at || to.revoked_at || !this.activeMember(teamId, to.owner_id) ||
        !this.mutual(teamId, from.id, to.id) || Date.parse(String(item.expires_at)) <= this.clock()) {
        return { code: '42501', message: 'Mailbox insert requires an active sender, recipient, and reciprocal verified pins.' };
      }
      if (this.envelopes.some((row) => row.team_id === teamId && row.from_device_id === from.id && row.to_device_id === to.id && row.idempotency_key === item.idempotency_key)) {
        return { code: '23505', message: 'Mailbox idempotency key already exists.' };
      }
      this.envelopes.push({ ...item, received_at: this.nowIso() } as AcceptanceEnvelope);
      return null;
    }
    return { code: '42501', message: 'The authenticated relay denies this insert.' };
  }

  private device(id: string, teamId: string): AcceptanceDevice | undefined {
    return this.devices.find((device) => device.id === id && device.team_id === teamId);
  }

  private owns(ownerId: string, deviceId: string, teamId: string): boolean {
    return this.device(deviceId, teamId)?.owner_id === ownerId;
  }

  private link(teamId: string, deviceId: string, peerDeviceId: string): AcceptanceLink | undefined {
    return this.links.find((link) => link.team_id === teamId && link.device_id === deviceId && link.peer_device_id === peerDeviceId);
  }

  private mutual(teamId: string, a: string, b: string): boolean {
    const left = this.device(a, teamId);
    const right = this.device(b, teamId);
    const forward = this.link(teamId, a, b);
    const reverse = this.link(teamId, b, a);
    return Boolean(left && right && !left.revoked_at && !right.revoked_at && this.activeMember(teamId, left.owner_id) && this.activeMember(teamId, right.owner_id) &&
      forward?.peer_fingerprint === right.fingerprint && reverse?.peer_fingerprint === left.fingerprint);
  }
}

/** Mutable signed-in account bridge; each callback gets its own authenticated relay client. */
export class AcceptanceAccount {
  constructor(private readonly relay: AuthenticatedLocalRelay, public ownerId: string) {}

  setOwner(ownerId: string): void { this.ownerId = ownerId; }

  snapshot(): { status: string; user: { id: string } | null } {
    return this.ownerId ? { status: 'signed-in', user: { id: this.ownerId } } : { status: 'signed-out', user: null };
  }

  async withAuthenticatedClient<T>(callback: (client: SupabaseClient, user: User) => Promise<T>): Promise<T> {
    const ownerId = this.ownerId;
    const user = { id: ownerId, app_metadata: { provider: 'google' }, user_metadata: {}, aud: 'authenticated', created_at: new Date().toISOString() } as User;
    return callback(this.relay.client(ownerId), user);
  }
}

class RelayQuery implements PromiseLike<QueryResult> {
  private action = 'select';
  private values: unknown;
  private ignoreDuplicates = false;
  private returning = false;
  private rangeValue: [number, number] | null = null;
  private readonly filters: Filter[] = [];
  private readonly orderValues: Array<[string, boolean]> = [];

  constructor(private readonly relay: AuthenticatedLocalRelay, private readonly ownerId: string, private readonly table: string) {}
  select(_columns?: string): this { if (this.action !== 'select') this.returning = true; return this; }
  insert(values: unknown): this { this.action = 'insert'; this.values = values; return this; }
  upsert(values: unknown, options?: { ignoreDuplicates?: boolean }): this { this.action = 'upsert'; this.values = values; this.ignoreDuplicates = options?.ignoreDuplicates ?? false; return this; }
  update(values: unknown): this { this.action = 'update'; this.values = values; return this; }
  delete(): this { this.action = 'delete'; return this; }
  eq(column: string, value: unknown): this { this.filters.push({ op: 'eq', column, value }); return this; }
  is(column: string, value: null): this { this.filters.push({ op: 'is', column, value }); return this; }
  gte(column: string, value: unknown): this { this.filters.push({ op: 'gte', column, value }); return this; }
  in(column: string, values: unknown[]): this { this.filters.push({ op: 'in', column, value: values }); return this; }
  order(column: string, options?: { ascending?: boolean }): this { this.orderValues.push([column, options?.ascending !== false]); return this; }
  range(from: number, to: number): this { this.rangeValue = [from, to]; return this; }

  async maybeSingle(): Promise<QueryResult> {
    const result = await this.execute();
    const values = Array.isArray(result.data) ? result.data : [];
    return { ...result, data: values[0] ?? null };
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private execute(): Promise<QueryResult> {
    return this.relay.execute(this.ownerId, this.table, this.action, this.values, this.filters, this.rangeValue,
      this.orderValues, this.returning, this.ignoreDuplicates);
  }
}

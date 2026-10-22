import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  AcceptTeamInvitationSchema,
  CreateTeamProjectSchema,
  CreateTeamSchema,
  InviteTeamMemberSchema,
  RevokeTeamMemberSchema,
  TeamInvitationRoleSchema,
  TeamRoleSchema,
  type CreatedTeamInvitation,
  type CreateTeamInput,
  type CreateTeamProjectInput,
  type InviteTeamMemberInput,
  type RevokeTeamMemberInput,
  type SharedTeamProject,
  type Team,
  type TeamInvitation,
  type TeamMember,
  type TeamRole,
  type TeamSnapshot,
} from '../../../../packages/contracts/src/teams.ts';
import type { AccountService } from '../account/service.ts';
import { conflict, HttpError } from '../util.ts';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_LIMIT = 500;
type Row = Record<string, unknown>;
type CloudError = { code?: string | null } | null;
type AccountBridge = Pick<AccountService, 'snapshot' | 'withAuthenticatedClient'>;

function failCloud(error: CloudError, message: string): never {
  if (error?.code === '23505') throw conflict('That team record already exists. Refresh the team snapshot and try again.');
  if (error?.code === '42501') throw new HttpError(403, 'Your active team role does not allow this operation.');
  if (error?.code === 'P0001') throw conflict('The invitation is invalid, expired, already accepted, or belongs to another account.');
  throw new HttpError(502, message);
}

function requireRow(data: unknown, error: CloudError, message: string): Row {
  if (error) failCloud(error, message);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(502, message);
  return data as Row;
}

function requireRows(data: unknown, error: CloudError, message: string): Row[] {
  if (error) failCloud(error, message);
  if (!Array.isArray(data) || data.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new HttpError(502, message);
  return data as Row[];
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(502, 'The team service returned an unsupported response.');
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new HttpError(502, 'The team service returned an unsupported response.');
  return value;
}

function teamRole(row: Row): TeamRole {
  const parsed = TeamRoleSchema.safeParse(row.role);
  if (!parsed.success) throw new HttpError(502, 'The team service returned an unsupported member role.');
  return parsed.data;
}

function mapTeam(row: Row, role: TeamRole): Team {
  return {
    id: text(row, 'id'), name: text(row, 'name'), ownerId: text(row, 'owner_id'), role,
    createdAt: text(row, 'created_at'),
  };
}

function mapMember(row: Row): TeamMember {
  return {
    teamId: text(row, 'team_id'), userId: text(row, 'user_id'), role: teamRole(row),
    createdAt: text(row, 'created_at'), revokedAt: nullableText(row, 'revoked_at'),
  };
}

function mapInvitation(row: Row): TeamInvitation {
  const role = TeamInvitationRoleSchema.safeParse(row.role);
  if (!role.success) throw new HttpError(502, 'The team service returned an unsupported invitation role.');
  return {
    id: text(row, 'id'), teamId: text(row, 'team_id'), email: text(row, 'email'),
    role: role.data, expiresAt: text(row, 'expires_at'),
    acceptedAt: nullableText(row, 'accepted_at'), createdAt: text(row, 'created_at'),
  };
}

function mapProject(row: Row): SharedTeamProject {
  return {
    id: text(row, 'id'), teamId: text(row, 'team_id'), name: text(row, 'name'),
    repositoryUrl: nullableText(row, 'repository_url'), createdAt: text(row, 'created_at'),
  };
}

function assertAdminRole(member: TeamMember): void {
  if (member.role !== 'owner' && member.role !== 'admin') throw new HttpError(403, 'Only a team owner or admin can do that.');
}

/** Account-backed team membership and shared-project operations. All cloud requests use the verified user client under RLS. */
export class TeamService {
  constructor(private readonly options: {
    account: AccountBridge;
    changed: () => void;
    /** Injectable clock for deterministic expiry checks; production defaults to the system clock. */
    now?: () => Date;
  }) {}

  private now(): Date { return this.options.now?.() ?? new Date(); }

  /** Run a server-only Supabase operation as the live verified account user. */
  withClient<T>(callback: (client: SupabaseClient, user: User) => Promise<T>): Promise<T> {
    return this.options.account.withAuthenticatedClient(callback);
  }

  async snapshot(): Promise<TeamSnapshot> {
    const empty: TeamSnapshot = {
      teams: [], members: [], invitations: [], projects: [], userId: null,
      configured: this.options.account.snapshot().configured,
    };
    try {
      return await this.withClient(async (client, user) => {
        const [teamResult, memberResult, inviteResult, projectResult] = await Promise.all([
          client.from('mingle_teams').select('id,name,owner_id,created_at').order('created_at', { ascending: true }).limit(SNAPSHOT_LIMIT),
          client.from('mingle_members').select('team_id,user_id,role,created_at,revoked_at').is('revoked_at', null).order('created_at', { ascending: true }).limit(SNAPSHOT_LIMIT),
          client.from('mingle_invitations').select('id,team_id,email,role,expires_at,accepted_at,created_at').order('created_at', { ascending: false }).limit(SNAPSHOT_LIMIT),
          client.from('mingle_projects').select('id,team_id,name,repository_url,created_at').order('created_at', { ascending: true }).limit(SNAPSHOT_LIMIT),
        ]);
        const members = requireRows(memberResult.data, memberResult.error, 'Team members could not be loaded.');
        const teams = requireRows(teamResult.data, teamResult.error, 'Teams could not be loaded.').map((row) => {
          const ownMembership = members.find((member) => member.team_id === row.id && member.user_id === user.id);
          if (!ownMembership) throw new HttpError(502, 'Team membership changed while the snapshot was loading. Refresh and try again.');
          return mapTeam(row, teamRole(ownMembership));
        });
        return {
          teams,
          members: members.map(mapMember),
          invitations: requireRows(inviteResult.data, inviteResult.error, 'Team invitations could not be loaded.').map(mapInvitation),
          projects: requireRows(projectResult.data, projectResult.error, 'Shared projects could not be loaded.').map(mapProject),
          userId: user.id,
          configured: true,
        };
      });
    } catch (error) {
      const message = error instanceof HttpError
        ? error.message
        : 'Teams could not be loaded. Check account sign-in, network access, and cloud database setup.';
      return { ...empty, error: message };
    }
  }

  async createTeam(input: CreateTeamInput): Promise<Team> {
    const { name } = CreateTeamSchema.parse(input);
    const team = await this.withClient(async (client, user) => {
      const { data, error } = await client.from('mingle_teams')
        .insert({ id: randomUUID(), name, owner_id: user.id })
        .select('id,name,owner_id,created_at').single();
      return mapTeam(requireRow(data, error, 'The team could not be created.'), 'owner');
    });
    this.options.changed();
    return team;
  }

  async invite(input: InviteTeamMemberInput): Promise<CreatedTeamInvitation> {
    const parsed = InviteTeamMemberSchema.parse(input);
    const created = await this.withClient(async (client, user) => {
      const actor = await this.findActiveMember(client, parsed.teamId, user.id);
      assertAdminRole(actor);
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
      const expiresAt = new Date(this.now().getTime() + INVITATION_TTL_MS).toISOString();
      const { data, error } = await client.from('mingle_invitations').insert({
        id: randomUUID(), team_id: parsed.teamId, email: parsed.email, role: parsed.role,
        token_hash: tokenHash, expires_at: expiresAt,
      }).select('id,team_id,email,role,expires_at,accepted_at,created_at').single();
      return { invitation: mapInvitation(requireRow(data, error, 'The invitation could not be created.')), token };
    });
    this.options.changed();
    return created;
  }

  async acceptInvite(input: { token: string }): Promise<TeamMember> {
    const { token } = AcceptTeamInvitationSchema.parse(input);
    const member = await this.withClient(async (client, user) => {
      if (!user.email || !user.email_confirmed_at) throw new HttpError(403, 'A verified account email is required to accept a team invitation.');
      const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
      const { data, error } = await client.rpc('accept_mingle_invitation', { p_token_hash: tokenHash });
      if (error) failCloud(error, 'The invitation could not be accepted.');
      if (typeof data !== 'string') throw new HttpError(502, 'The invitation service returned an unsupported response.');
      const { data: row, error: memberError } = await client.from('mingle_members')
        .select('team_id,user_id,role,created_at,revoked_at').eq('team_id', data).eq('user_id', user.id).is('revoked_at', null).maybeSingle();
      return mapMember(requireRow(row, memberError, 'The accepted team membership could not be loaded.'));
    });
    this.options.changed();
    return member;
  }

  async revokeMember(input: RevokeTeamMemberInput): Promise<TeamMember> {
    const parsed = RevokeTeamMemberSchema.parse(input);
    const result = await this.withClient(async (client, user) => {
      const actor = await this.findActiveMember(client, parsed.teamId, user.id);
      assertAdminRole(actor);
      if (user.id === parsed.userId) throw conflict('You cannot revoke your own team membership.');
      const { data: targetData, error: targetError } = await client.from('mingle_members')
        .select('team_id,user_id,role,created_at,revoked_at').eq('team_id', parsed.teamId).eq('user_id', parsed.userId).is('revoked_at', null).maybeSingle();
      if (targetError) failCloud(targetError, 'Team membership could not be checked.');
      if (!targetData) throw new HttpError(404, 'The active team member was not found.');
      const target = mapMember(targetData as Row);
      if (target.role === 'owner') throw new HttpError(403, 'The team owner cannot be revoked.');
      if (actor.role === 'admin' && target.role !== 'member') throw new HttpError(403, 'An admin can revoke members but not another admin.');
      const revokedAt = this.now().toISOString();
      const { data, error } = await client.from('mingle_members').update({ revoked_at: revokedAt })
        .eq('team_id', parsed.teamId).eq('user_id', parsed.userId).is('revoked_at', null)
        .select('team_id,user_id,role,created_at,revoked_at').maybeSingle();
      if (error) failCloud(error, 'The team member could not be revoked.');
      if (!data) throw conflict('Team membership changed before it could be revoked. Refresh the snapshot and try again.');
      return mapMember(data as Row);
    });
    this.options.changed();
    return result;
  }

  async createProject(input: CreateTeamProjectInput): Promise<SharedTeamProject> {
    const parsed = CreateTeamProjectSchema.parse(input);
    const project = await this.withClient(async (client, user) => {
      const actor = await this.findActiveMember(client, parsed.teamId, user.id);
      assertAdminRole(actor);
      const { data, error } = await client.from('mingle_projects').insert({
        id: randomUUID(), team_id: parsed.teamId, name: parsed.name, repository_url: parsed.repositoryUrl,
      }).select('id,team_id,name,repository_url,created_at').single();
      return mapProject(requireRow(data, error, 'The shared project could not be created.'));
    });
    this.options.changed();
    return project;
  }

  /** Verify current authorization on the receiving device before proceeding. */
  assertMember(teamId: string): Promise<TeamMember> {
    const parsedTeamId = zTeamId(teamId);
    return this.withClient((client, user) => this.findActiveMember(client, parsedTeamId, user.id));
  }

  private async findActiveMember(client: SupabaseClient, teamId: string, userId: string): Promise<TeamMember> {
    const { data, error } = await client.from('mingle_members')
      .select('team_id,user_id,role,created_at,revoked_at').eq('team_id', teamId).eq('user_id', userId).is('revoked_at', null).maybeSingle();
    if (error) failCloud(error, 'Active team membership could not be checked.');
    if (!data) throw new HttpError(403, 'Active team membership is required.');
    return mapMember(data as Row);
  }
}

function zTeamId(teamId: string): string {
  const parsed = RevokeTeamMemberSchema.shape.teamId.safeParse(teamId);
  if (!parsed.success) throw new HttpError(400, 'A valid team ID is required.');
  return parsed.data;
}

import { z } from 'zod';

export const TeamRoleSchema = z.enum(['owner', 'admin', 'member']);
export type TeamRole = z.infer<typeof TeamRoleSchema>;

export const TeamInvitationRoleSchema = z.enum(['admin', 'member']);
export type TeamInvitationRole = z.infer<typeof TeamInvitationRoleSchema>;

const TeamIdSchema = z.string().uuid();
const TeamNameSchema = z.string().trim().min(1).max(100);

export const CreateTeamSchema = z.object({ name: TeamNameSchema }).strict();
export type CreateTeamInput = z.infer<typeof CreateTeamSchema>;

export const InviteTeamMemberSchema = z.object({
  teamId: TeamIdSchema,
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  role: TeamInvitationRoleSchema,
}).strict();
export type InviteTeamMemberInput = z.infer<typeof InviteTeamMemberSchema>;

export const AcceptTeamInvitationSchema = z.object({
  token: z.string().min(32).max(512),
}).strict();
export type AcceptTeamInvitationInput = z.infer<typeof AcceptTeamInvitationSchema>;

export const RevokeTeamMemberSchema = z.object({
  teamId: TeamIdSchema,
  userId: z.string().uuid(),
}).strict();
export type RevokeTeamMemberInput = z.infer<typeof RevokeTeamMemberSchema>;

const RepositoryUrlSchema = z.string().trim().max(2048).nullable().optional().refine((value) => {
  if (value == null || value === '') return true;
  try {
    const url = new URL(value);
    return ['https:', 'ssh:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'Use an HTTPS or SSH repository URL without embedded credentials');

export const CreateTeamProjectSchema = z.object({
  teamId: TeamIdSchema,
  name: TeamNameSchema,
  repositoryUrl: RepositoryUrlSchema,
}).strict().transform((input) => ({ ...input, repositoryUrl: input.repositoryUrl || null }));
export type CreateTeamProjectInput = z.infer<typeof CreateTeamProjectSchema>;

export interface Team {
  id: string;
  name: string;
  ownerId: string;
  role: TeamRole;
  createdAt: string;
}

export interface TeamMember {
  teamId: string;
  userId: string;
  role: TeamRole;
  createdAt: string;
  revokedAt: string | null;
}

/** Public invitation metadata. The bearer token and its hash are never included. */
export interface TeamInvitation {
  id: string;
  teamId: string;
  email: string;
  role: TeamInvitationRole;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

/** Returned once by invite(); callers must explicitly show/share token to the invitee. */
export interface CreatedTeamInvitation {
  invitation: TeamInvitation;
  token: string;
}

export interface SharedTeamProject {
  id: string;
  teamId: string;
  name: string;
  repositoryUrl: string | null;
  createdAt: string;
}

/** Stable UI snapshot; service failures retain an empty, truthful snapshot and an error. */
export interface TeamSnapshot {
  teams: Team[];
  members: TeamMember[];
  invitations: TeamInvitation[];
  projects: SharedTeamProject[];
  userId: string | null;
  configured: boolean;
  error?: string;
}

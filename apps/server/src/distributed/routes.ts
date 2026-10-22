import { z } from 'zod';
import {
  CreateTeamSchema, InviteTeamMemberSchema, AcceptTeamInvitationSchema, RevokeTeamMemberSchema, CreateTeamProjectSchema,
} from '../../../../packages/contracts/src/teams.ts';
import { RegisterDeviceSchema, LinkDeviceSchema, RevokeDeviceSchema } from '../../../../packages/contracts/src/devices.ts';
import {
  BindRemoteProjectSchema, PublishRemoteAgentsSchema, RequestRemoteDelegationSchema, SuggestRemoteFallbackSchema,
  DecideRemoteExecutionSchema, SendRemoteMessageSchema, PublishRemoteTaskSchema, RefreshRemoteAgentsSchema,
} from '../../../../packages/contracts/src/remote-execution.ts';
import {
  GitTransferRequestSchema, GitIntegrationRequestSchema, RemoteCommandRequestSchema, DistributedRequestDecisionSchema,
} from '../../../../packages/contracts/src/remote-git.ts';
import type { Ctx } from '../routes.ts';
import type { DistributedWorkspaceService } from './service.ts';
import { HttpError } from '../util.ts';

type AddRoute = (method: string, path: string, handler: (context: Ctx) => unknown | Promise<unknown>) => unknown;
const empty = z.object({}).strict();
const teamQuery = z.object({ teamId: z.string().uuid().optional() }).strict();
const requestId = (ctx: Ctx): string => {
  const id = ctx.params.id;
  if (!id || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) throw new HttpError(404, 'Request not found.');
  return id;
};

/** Runs behind the same local Host/Origin checks as every existing workspace route. */
export function registerDistributedRoutes(add: AddRoute, s: DistributedWorkspaceService): void {
  const base = '/api/distributed';
  add('GET', `${base}/snapshot`, (ctx) => {
    const { teamId } = teamQuery.parse(Object.fromEntries(ctx.url.searchParams));
    return s.snapshot(teamId);
  });
  add('POST', `${base}/teams`, async (ctx) => s.teams.createTeam(await ctx.body(CreateTeamSchema)));
  add('POST', `${base}/invitations`, async (ctx) => s.teams.invite(await ctx.body(InviteTeamMemberSchema)));
  add('POST', `${base}/invitations/accept`, async (ctx) => s.teams.acceptInvite(await ctx.body(AcceptTeamInvitationSchema)));
  add('POST', `${base}/members/revoke`, async (ctx) => s.teams.revokeMember(await ctx.body(RevokeTeamMemberSchema)));
  add('POST', `${base}/projects`, async (ctx) => s.teams.createProject(await ctx.body(CreateTeamProjectSchema)));
  add('POST', `${base}/devices/register`, async (ctx) => s.transport.register(await ctx.body(RegisterDeviceSchema)));
  add('POST', `${base}/devices/link`, async (ctx) => s.transport.link(await ctx.body(LinkDeviceSchema)));
  add('POST', `${base}/devices/revoke`, async (ctx) => { await s.transport.revoke(await ctx.body(RevokeDeviceSchema)); return { ok: true }; });
  add('POST', `${base}/sync`, async (ctx) => { await ctx.body(empty); await s.transport.sync(); return { ok: true }; });
  add('POST', `${base}/projects/bind`, async (ctx) => s.bindProject(await ctx.body(BindRemoteProjectSchema)));
  add('POST', `${base}/agents/publish`, async (ctx) => s.execution.publishAgents(await ctx.body(PublishRemoteAgentsSchema)));
  add('POST', `${base}/agents/refresh`, async (ctx) => s.execution.refreshPublishedAgents(await ctx.body(RefreshRemoteAgentsSchema)));
  add('GET', `${base}/groups/:id`, (ctx) => s.groupSnapshot(requestId(ctx)));
  add('POST', `${base}/delegations`, async (ctx) => s.execution.requestDelegation(await ctx.body(RequestRemoteDelegationSchema)));
  add('POST', `${base}/fallbacks/suggest`, async (ctx) => s.execution.suggestFallback(await ctx.body(SuggestRemoteFallbackSchema)));
  add('POST', `${base}/approvals/:id`, async (ctx) => s.execution.decide({ ...await ctx.body(DecideRemoteExecutionSchema.omit({ requestId: true })), requestId: requestId(ctx) }));
  add('POST', `${base}/messages`, async (ctx) => s.execution.sendMessage(await ctx.body(SendRemoteMessageSchema)));
  add('POST', `${base}/tasks/publish`, async (ctx) => s.execution.publishTask(await ctx.body(PublishRemoteTaskSchema)));
  add('POST', `${base}/git/request`, async (ctx) => s.git.request(await ctx.body(GitTransferRequestSchema)));
  add('POST', `${base}/git/integrate`, async (ctx) => s.git.requestIntegration(await ctx.body(GitIntegrationRequestSchema)));
  add('POST', `${base}/git/:id/decision`, async (ctx) => s.decideGit({ ...await ctx.body(DistributedRequestDecisionSchema.omit({ requestId: true })), requestId: requestId(ctx) }));
  add('POST', `${base}/commands/request`, async (ctx) => s.commands.request(await ctx.body(RemoteCommandRequestSchema)));
  add('POST', `${base}/commands/:id/decision`, async (ctx) => s.commands.decide({ ...await ctx.body(DistributedRequestDecisionSchema.omit({ requestId: true })), requestId: requestId(ctx) }));
  add('GET', `${base}/repository`, (ctx) => s.inspectRepository(BindRemoteProjectSchema.parse(Object.fromEntries(ctx.url.searchParams))));
}

import { z } from 'zod';
import {
  CreateProjectInvitationSchema, JoinProjectInvitationSchema, PreviewProjectInvitationSchema,
} from '../../../../packages/contracts/src/project-collaboration.ts';
import type { Ctx } from '../routes.ts';
import { ProjectCollaborationService } from './service.ts';
import { HttpError } from '../util.ts';

type AddRoute = (method: string, path: string, handler: (context: Ctx) => unknown | Promise<unknown>) => unknown;
const empty = z.object({}).strict();

function projectId(ctx: Ctx): string {
  const id = ctx.params.projectId;
  if (!id || !/^[A-Za-z0-9_.-]{1,100}$/.test(id)) throw new HttpError(404, 'Project not found.');
  return id;
}

function invitationId(ctx: Ctx): string {
  const id = ctx.params.invitationId;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new HttpError(404, 'Project invitation not found.');
  }
  return id;
}

/** Mount project-first teammate routes behind the existing loopback Host/Origin guard. */
export function registerProjectCollaborationRoutes(add: AddRoute, service: ProjectCollaborationService): void {
  add('GET', '/api/projects/:projectId/collaboration', (ctx) => service.snapshot(projectId(ctx)));
  add('POST', '/api/projects/:projectId/collaboration/invitations', async (ctx) =>
    service.createInvitation(projectId(ctx), await ctx.body(CreateProjectInvitationSchema)));
  add('POST', '/api/projects/:projectId/collaboration/invitations/:invitationId/delivery', async (ctx) => {
    await ctx.body(empty);
    return service.resendInvitation(projectId(ctx), invitationId(ctx));
  });
  add('DELETE', '/api/projects/:projectId/collaboration/invitations/:invitationId', (ctx) =>
    service.revokeInvitation(projectId(ctx), invitationId(ctx)));
  add('POST', '/api/project-invitations/preview', async (ctx) =>
    service.previewInvitation(await ctx.body(PreviewProjectInvitationSchema)));
  add('POST', '/api/project-invitations/join', async (ctx) =>
    service.joinInvitation(await ctx.body(JoinProjectInvitationSchema)));
}

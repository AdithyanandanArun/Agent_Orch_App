import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  CreateGroupSchema, AddGroupAgentSchema, UpdateGroupSchema, SendGroupMessageSchema, RepositoryCommitSchema, RepositoryPushSchema, RepositoryBranchSchema, RepositoryPullRequestSchema, BrowserConnectSchema, BrowserActionSchema, ApprovalDecisionSchema, ConversationIdSchema, ImportConversationSchema, ProviderSchema, CloneProjectSchema, NewProjectSchema, CreateProjectSchema, CreateSessionSchema, CreateTaskSchema, HandoffSchema, SendMessageSchema, UpdateProjectSchema, UpdateSessionSchema, UpdateSettingsSchema, UpdateTaskSchema,
} from '@relay/contracts';
import type { Bootstrap, SessionUsage } from '@relay/contracts';
import { gitStatus } from './git.ts';
import type { Hub } from './hub.ts';
import { listDirectory, readTextFile, writeTextFile } from './paths.ts';
import type { ProviderService } from './provider-service.ts';
import type { SessionRuntime } from './runtime.ts';
import type { Store } from './store.ts';
import type { TaskService } from './tasks.ts';
import type { HandoffService } from './handoffs.ts';
import type { WorkspaceService } from './workspace.ts';
import type { ServerConfig } from './config.ts';
import type { TerminalManager } from './terminal.ts';
import { HttpError, badRequest, conflict, notFound } from './util.ts';
import { resolveRunConfig } from './session-config.ts';
import type { ImportService } from './imports.ts';
import { defaultModel } from './provider-config.ts';
import type { DirectoryService } from './directories.ts';
import type { ProjectSources } from './project-sources.ts';
import type { ProjectIntelligenceService } from './project-intelligence/service.ts';
import type { RepositoryService } from './repository/service.ts';
import type { GroupService } from './groups/service.ts';
import type { BrowserService } from './browser/service.ts';
import { antigravityInstallState, startAntigravityInstall } from './antigravity-install.ts';
import { antigravityAuthState, cancelAntigravityAuth, startAntigravityAuth } from './antigravity-auth.ts';

export interface Services {
  config: ServerConfig; store: Store; hub: Hub; workspace: WorkspaceService; runtime: SessionRuntime; tasks: TaskService; handoffs: HandoffService;
  groups: GroupService; intelligence: ProjectIntelligenceService; repository: RepositoryService; browser: BrowserService; providers: ProviderService; imports: ImportService; directories: DirectoryService; projectSources: ProjectSources; terminals: TerminalManager; startedAt: number; getPort: () => number;
}

export class Reply {
  constructor(readonly status: number, readonly body: unknown) {}
}

interface Ctx { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; body<T>(schema: z.ZodType<T>): Promise<T> }
type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Route { method: string; regex: RegExp; keys: string[]; handler: Handler }

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9_.-]{1,100}$/;

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern.replace(/:([A-Za-z]+)/g, (_m, key: string) => { keys.push(key); return '([^/]+)'; });
  return { regex: new RegExp(`^${source}$`), keys };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw badRequest(`${where}${issue?.message ?? 'Invalid request'}`);
}

const executable = z.string().max(4096).refine((v) => !/[\0\r\n]/.test(v), 'Executable path contains control characters');
const SettingsPatch = UpdateSettingsSchema.extend({ claudeExecutable: executable.optional(), codexExecutable: executable.optional(), antigravityExecutable: executable.optional(), browserExecutable: executable.optional(), browserCdpEndpoint: z.string().max(2048).refine((value) => {
  if (!value) return true;
  try { const url = new URL(value); return ['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Boolean(url.port) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}, 'Use a loopback HTTP or WebSocket endpoint with an explicit port').optional() });
const MessagesQuery = z.object({ limit: z.coerce.number().int().min(1).max(2000).optional(), before: z.string().max(100).optional() });
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0), projectId: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(5000).optional() });
const WriteFile = z.object({ content: z.string() });
const ImportsQuery = z.object({ provider: ProviderSchema, projectId: z.string().min(1).max(100).optional(), cursor: z.string().min(1).max(4096).optional() }).strict();
const DirectoriesQuery = z.object({ path: z.string().min(1).max(4096).optional(), query: z.string().max(200).optional(), hidden: z.enum(['true', 'false']).optional() }).strict();
const RevealDirectory = z.object({ path: z.string().min(1).max(4096) }).strict();

export function buildRouter(s: Services) {
  const routes: Route[] = [];
  const add = (method: string, pattern: string, handler: Handler) => routes.push({ method, ...compile(pattern), handler });
  const touch = () => s.store.touch();
  const param = (ctx: Ctx, key: string) => {
    const value = ctx.params[key]!;
    if (!ID.test(value)) throw notFound('Not found');
    return value;
  };

  const browserSession = (ctx: Ctx) => {
    const id = param(ctx, 'id');
    if (!s.store.getSession(id)) throw notFound('Session not found');
    return id;
  };
  const emptyBrowserBody = z.object({}).strict();
  add('GET', '/api/browser/discovery', () => s.browser.discovery());
  add('POST', '/api/browser/install', async (ctx) => { await ctx.body(emptyBrowserBody); return s.browser.install(); });
  add('GET', '/api/sessions/:id/browser', (ctx) => s.browser.status(browserSession(ctx)));
  add('POST', '/api/sessions/:id/browser/connect', async (ctx) => s.browser.connect(browserSession(ctx), await ctx.body(BrowserConnectSchema)));
  add('POST', '/api/sessions/:id/browser/disconnect', async (ctx) => { const id = browserSession(ctx); await ctx.body(emptyBrowserBody); return s.browser.disconnect(id); });
  add('POST', '/api/sessions/:id/browser/tabs', async (ctx) => s.browser.open(browserSession(ctx), (await ctx.body(z.object({ url: z.string().min(1).max(4096).optional() }).strict())).url));
  add('GET', '/api/sessions/:id/browser/tabs/:tabId/snapshot', (ctx) => {
    const query = parse(z.object({ image: z.enum(['true', 'false']).optional() }).strict(), Object.fromEntries(ctx.url.searchParams));
    return s.browser.snapshot(browserSession(ctx), param(ctx, 'tabId'), query.image === 'true');
  });
  add('POST', '/api/sessions/:id/browser/tabs/:tabId/action', async (ctx) => {
    const id = browserSession(ctx);
    const body = await ctx.body(z.object({ action: BrowserActionSchema, clientId: z.string().min(1).max(100) }).strict());
    return s.browser.act(id, param(ctx, 'tabId'), body.action, { kind: 'human', id: body.clientId });
  });
  add('POST', '/api/sessions/:id/browser/tabs/:tabId/control', async (ctx) => {
    const id = browserSession(ctx);
    const body = await ctx.body(z.object({ owner: z.enum(['human', 'agent']), clientId: z.string().min(1).max(100) }).strict());
    return s.browser.control(id, param(ctx, 'tabId'), body.owner, body.clientId);
  });

  add('GET', '/api/health', () => {
    const counts = s.store.counts();
    const cached = s.providers.cached();
    return {
      ok: true, version: s.config.version, node: process.version, startedAt: new Date(s.startedAt).toISOString(), uptimeSeconds: Math.round((Date.now() - s.startedAt) / 1000),
      host: s.config.host, port: s.getPort(), dataDir: s.config.dataDir,
      database: { ok: true, schemaVersion: s.store.schemaVersion(), ...counts },
      runtime: { activeRuns: s.runtime.activeCount(), terminals: s.terminals.count, websocketClients: s.hub.clientCount },
      providers: cached ? cached.map((p) => ({ id: p.id, available: p.available, version: p.version })) : null,
      web: { served: Boolean(s.config.webDistDir) },
    };
  });

  add('GET', '/api/bootstrap', async () => {
    const providers = await s.providers.snapshot();
    const runs = s.store.bootstrapRuns();
    const body: Bootstrap = {
      groups: s.groups.snapshots(), runs, toolCalls: s.store.bootstrapToolCalls(runs.map((run) => run.id)),
      projects: s.store.listProjects(), sessions: s.store.listSessions(), messages: s.store.bootstrapMessages(300), tasks: s.store.listTasks(),
      events: s.store.recentEvents(500), approvals: s.store.bootstrapApprovals(50), providers, settings: s.store.getSettings(), version: s.config.version,
    };
    return body;
  });

  add('GET', '/api/runs/:id/tools', (ctx) => {
    const run = s.store.getRun(param(ctx, 'id'));
    if (!run || !s.store.getSession(run.sessionId)) throw notFound('Run not found');
    return s.store.listRunTools(run.id);
  });
  add('GET', '/api/runs/:id/changes', (ctx) => {
    const run = s.store.getRun(param(ctx, 'id'));
    if (!run || !s.store.getSession(run.sessionId)) throw notFound('Run not found');
    if (run.status === 'running') throw conflict('Changes are saved after the run finishes');
    const changes = s.store.getRunChanges(run.id);
    if (!changes) throw notFound('This run has no saved change snapshot');
    return changes;
  });
  add('GET', '/api/tool-calls/:id', (ctx) => {
    const call = s.store.getToolCall(param(ctx, 'id'));
    if (!call || !s.store.getSession(call.sessionId)) throw notFound('Tool call not found');
    return call;
  });

  add('GET', '/api/projects', () => s.store.listProjects());
  add('GET', '/api/directories', (ctx) => {
    const query = parse(DirectoriesQuery, Object.fromEntries(ctx.url.searchParams));
    return s.directories.list(query.path, query.query, query.hidden === 'true');
  });
  add('POST', '/api/directories/reveal', async (ctx) => s.directories.reveal((await ctx.body(RevealDirectory)).path));
  add('POST', '/api/projects/new', async (ctx) => new Reply(201, await s.projectSources.create(await ctx.body(NewProjectSchema))));
  add('POST', '/api/projects/clone', async (ctx) => new Reply(201, await s.projectSources.clone(await ctx.body(CloneProjectSchema))));
  add('GET', '/api/imports', (ctx) => {
    const query = parse(ImportsQuery, Object.fromEntries(ctx.url.searchParams));
    return s.imports.list(query.provider, query.projectId, query.cursor);
  });
  add('GET', '/api/imports/:provider/:id', (ctx) => s.imports.read(parse(ProviderSchema, ctx.params.provider), parse(ConversationIdSchema, ctx.params.id)));
  add('POST', '/api/imports', async (ctx) => {
    const input = await ctx.body(ImportConversationSchema);
    const result = await s.imports.import(input.provider, input.conversationId);
    return new Reply(result.alreadyImported ? 200 : 201, result);
  });
  add('POST', '/api/projects', async (ctx) => {
    const { project, created } = await s.workspace.createProject(await ctx.body(CreateProjectSchema));
    return new Reply(created ? 201 : 200, project);
  });
  add('GET', '/api/projects/:id/files', async (ctx) => {
    const scope = s.workspace.resolveScope(param(ctx, 'id'), ctx.url.searchParams.get('sessionId') ?? undefined);
    return listDirectory(scope.root, ctx.url.searchParams.get('path'));
  });
  add('GET', '/api/projects/:id/file', async (ctx) => {
    const scope = s.workspace.resolveScope(param(ctx, 'id'), ctx.url.searchParams.get('sessionId') ?? undefined);
    const rel = ctx.url.searchParams.get('path');
    if (!rel) throw badRequest('path is required');
    return readTextFile(scope.root, rel);
  });
  add('PUT', '/api/projects/:id/file', async (ctx) => {
    const scope = s.workspace.resolveScope(param(ctx, 'id'), ctx.url.searchParams.get('sessionId') ?? undefined);
    const rel = ctx.url.searchParams.get('path');
    if (!rel) throw badRequest('path is required');
    const { content } = await ctx.body(WriteFile);
    const saved = await writeTextFile(scope.root, rel, content);
    s.store.recordEvent({ projectId: scope.project.id, sessionId: scope.session?.id ?? null, type: 'file.saved', summary: `File saved: ${saved.path}`, payload: { path: saved.path, bytes: Buffer.byteLength(content) } });
    return saved;
  });
  const repositoryQuery = z.object({ sessionId: z.string().min(1).max(100).optional(), refresh: z.enum(['true', 'false']).optional() }).strict();
  add('GET', '/api/projects/:id/repository', (ctx) => {
    const query = parse(repositoryQuery, Object.fromEntries(ctx.url.searchParams));
    return s.repository.state(param(ctx, 'id'), query.sessionId);
  });
  add('GET', '/api/projects/:id/github', (ctx) => {
    const query = parse(repositoryQuery, Object.fromEntries(ctx.url.searchParams));
    return s.repository.github(param(ctx, 'id'), query.sessionId, query.refresh === 'true');
  });
  add('POST', '/api/projects/:id/repository/commit', async (ctx) => s.repository.commit(param(ctx, 'id'), await ctx.body(RepositoryCommitSchema)));
  add('POST', '/api/projects/:id/repository/push', async (ctx) => s.repository.push(param(ctx, 'id'), await ctx.body(RepositoryPushSchema)));
  add('POST', '/api/projects/:id/repository/branch', async (ctx) => s.repository.branch(param(ctx, 'id'), await ctx.body(RepositoryBranchSchema)));
  add('POST', '/api/projects/:id/repository/pull-request', async (ctx) => s.repository.pullRequest(param(ctx, 'id'), await ctx.body(RepositoryPullRequestSchema)));
  add('GET', '/api/projects/:id/context', (ctx) => s.intelligence.context(param(ctx, 'id')));
  add('POST', '/api/projects/:id/context/refresh', async (ctx) => {
    await ctx.body(z.object({}).strict());
    return s.intelligence.refresh(param(ctx, 'id'));
  });
  add('GET', '/api/projects/:id/git', async (ctx) => {
    const scope = s.workspace.resolveScope(param(ctx, 'id'), ctx.url.searchParams.get('sessionId') ?? undefined);
    return gitStatus(scope.root);
  });

  const emptyGroupBody = z.object({}).strict();
  add('POST', '/api/groups', async (ctx) => new Reply(201, await s.groups.create(await ctx.body(CreateGroupSchema))));
  add('GET', '/api/groups/:id', (ctx) => s.groups.get(param(ctx, 'id')));
  add('PATCH', '/api/groups/:id', async (ctx) => s.groups.update(param(ctx, 'id'), await ctx.body(UpdateGroupSchema)));
  add('POST', '/api/groups/:id/agents', async (ctx) => new Reply(201, await s.groups.addAgent(param(ctx, 'id'), await ctx.body(AddGroupAgentSchema))));
  add('DELETE', '/api/groups/:id/members/:memberId', (ctx) => s.groups.removeMember(param(ctx, 'id'), param(ctx, 'memberId')));
  add('POST', '/api/groups/:id/messages', async (ctx) => new Reply(202, s.groups.send(param(ctx, 'id'), await ctx.body(SendGroupMessageSchema))));
  add('POST', '/api/groups/:id/pause', async (ctx) => { await ctx.body(emptyGroupBody); return s.groups.pause(param(ctx, 'id')); });
  add('POST', '/api/groups/:id/stop', async (ctx) => { await ctx.body(emptyGroupBody); return s.groups.stop(param(ctx, 'id')); });
  add('POST', '/api/groups/:id/resume', async (ctx) => { await ctx.body(emptyGroupBody); return s.groups.resume(param(ctx, 'id')); });
  add('POST', '/api/groups/:id/members/:memberId/resume', async (ctx) => { await ctx.body(emptyGroupBody); return s.groups.resumeMember(param(ctx, 'id'), param(ctx, 'memberId')); });
  add('POST', '/api/groups/:id/members/:memberId/interrupt', async (ctx) => { await ctx.body(emptyGroupBody); return s.groups.stopMember(param(ctx, 'id'), param(ctx, 'memberId')); });

  add('POST', '/api/sessions', async (ctx) => new Reply(201, await s.workspace.createSession(await ctx.body(CreateSessionSchema))));
  add('PATCH', '/api/projects/:id', async (ctx) => s.workspace.renameProject(param(ctx, 'id'), (await ctx.body(UpdateProjectSchema)).name));
  add('PATCH', '/api/sessions/:id', async (ctx) => {
    const id = param(ctx, 'id');
    const patch = await ctx.body(UpdateSessionSchema);
    const session = s.store.getSession(id);
    if (s.groups.forSession(id) && patch.provider && patch.provider !== session?.provider) throw conflict('Group members retain their provider identity. Add another agent to use a different provider.');
    return s.workspace.updateSession(id, patch);
  });
  add('DELETE', '/api/sessions/:id', async (ctx) => {
    const id = param(ctx, 'id');
    if (s.groups.forSession(id)) throw conflict('Remove this agent from its group before archiving it. The original conversation remains the group entry.');
    s.workspace.archiveSession(id);
    await s.browser.disconnect(id);
    return { ok: true };
  });
  add('GET', '/api/sessions/:id/messages', (ctx) => {
    const id = param(ctx, 'id');
    if (!s.store.getSession(id)) throw notFound('Session not found');
    const query = parse(MessagesQuery, Object.fromEntries(ctx.url.searchParams));
    return s.store.listMessages(id, { limit: query.limit, beforeId: query.before });
  });
  add('GET', '/api/sessions/:id/catalog', (ctx) => {
    const session = s.store.getSession(param(ctx, 'id'));
    if (!session) throw notFound('Session not found');
    return s.providers.catalog(session, ctx.url.searchParams.get('refresh') === 'true');
  });
  add('GET', '/api/sessions/:id/usage', async (ctx) => {
    const session = s.store.getSession(param(ctx, 'id'));
    if (!session) throw notFound('Session not found');
    const usage = await s.providers.usage(session, ctx.url.searchParams.get('refresh') === 'true');
    const latest = s.store.getSession(session.id);
    if (!latest) throw notFound('Session not found');
    if (latest.provider !== session.provider || latest.model !== session.model) throw conflict('The session provider or model changed. Open usage again.');
    const result: SessionUsage = { ...usage, session: { id: latest.id, inputTokens: latest.inputTokens, outputTokens: latest.outputTokens, costUsd: latest.costUsd } };
    return result;
  });
  add('POST', '/api/sessions/:id/messages', async (ctx) => {
    const id = param(ctx, 'id');
    const { content, skills: selected } = await ctx.body(SendMessageSchema);
    const session = s.store.getSession(id);
    if (!session) throw notFound('Session not found');
    const group = s.groups.forSession(id);
    if (group) {
      if (selected?.length) throw badRequest('Select skills in an independent session. Group messages currently route through the team composer.');
      const member = group.members.find((row) => row.sessionId === id && !row.removedAt);
      if (!member) throw conflict('This agent is no longer in the group. Refresh the conversation.');
      return new Reply(202, s.groups.send(group.group.id, { content, ...(id === group.group.anchorSessionId ? {} : { recipients: [member.id] }) }));
    }
    if (s.runtime.isActive(id)) throw conflict('Session already has an active run or provider cleanup is still in progress');
    const catalog = selected?.length ? await s.providers.catalog(session, true) : null;
    const skills = [...new Set(selected ?? [])].map((key) => {
      const skill = catalog?.skills.find((row) => row.id === key && row.enabled);
      if (!skill) throw badRequest('A selected skill is no longer available. Refresh the skill picker and select it again.');
      return skill;
    });
    if (session.provider === 'claude' && skills.length > 1) throw badRequest('Claude supports one explicitly selected skill per message.');
    const latest = s.store.getSession(id);
    if (!latest) throw notFound('Session not found');
    if (s.groups.forSession(id)) throw conflict('This session joined a group while loading skills. Send through its group conversation.');
    if (latest.provider !== session.provider || latest.model !== session.model || latest.worktreePath !== session.worktreePath) throw conflict('Session settings changed while loading skills. Send the message again.');
    s.runtime.start(id, content, { skills });
    return new Reply(202, { accepted: true });
  });
  add('POST', '/api/sessions/:id/interrupt', (ctx) => {
    const id = param(ctx, 'id');
    if (!s.store.getSession(id)) throw notFound('Session not found');
    const group = s.groups.forSession(id);
    const member = group?.members.find((row) => row.sessionId === id && !row.removedAt);
    if (group && member) s.groups.stopMember(group.group.id, member.id);
    else s.runtime.interrupt(id);
    return { ok: true };
  });

  add('POST', '/api/tasks', async (ctx) => new Reply(201, s.tasks.create(await ctx.body(CreateTaskSchema))));
  add('PATCH', '/api/tasks/:id', async (ctx) => s.tasks.update(param(ctx, 'id'), await ctx.body(UpdateTaskSchema)));
  add('POST', '/api/tasks/:id/run', (ctx) => {
    const task = s.tasks.assertRunnable(param(ctx, 'id'));
    if (s.groups.forSession(task.sessionId!)) return new Reply(202, s.groups.runTask(task.id));
    const prompt = s.tasks.buildPrompt(task);
    s.runtime.start(task.sessionId!, prompt, { taskId: task.id, userMessage: { content: prompt, kind: 'task' } });
    return new Reply(202, { accepted: true });
  });

  add('POST', '/api/handoffs', async (ctx) => new Reply(201, await s.handoffs.create(await ctx.body(HandoffSchema))));
  add('POST', '/api/approvals/:id', async (ctx) => s.runtime.decide(param(ctx, 'id'), (await ctx.body(ApprovalDecisionSchema)).decision));

  add('GET', '/api/settings', () => s.store.getSettings());
  add('PATCH', '/api/settings', async (ctx) => {
    let patch = await ctx.body(SettingsPatch);
    const before = s.store.getSettings();
    const proposed = { ...before, ...patch };
    const selectedModel = defaultModel(proposed.defaultProvider, proposed);
    const selectedModelWasPatched = defaultModel(proposed.defaultProvider, before) !== selectedModel;
    if (patch.defaultProvider !== undefined || selectedModelWasPatched || patch.defaultEffort !== undefined || patch.defaultPolicy !== undefined || patch.defaultServiceTier !== undefined) {
      const resolved = resolveRunConfig(s.providers.cached()?.find((row) => row.id === proposed.defaultProvider), {
        provider: proposed.defaultProvider, model: selectedModel, effort: proposed.defaultEffort,
        policy: proposed.defaultPolicy, serviceTier: proposed.defaultServiceTier,
      }, { effort: patch.defaultEffort !== undefined, policy: patch.defaultPolicy !== undefined, serviceTier: patch.defaultServiceTier !== undefined });
      patch = { ...patch, defaultEffort: resolved.effort, defaultPolicy: resolved.policy, defaultServiceTier: resolved.serviceTier };
    }
    if (patch.groupDefaults) {
      for (const configuration of [patch.groupDefaults.orchestrator, patch.groupDefaults.worker]) {
        if (!configuration) continue;
        const info = s.providers.cached()?.find((row) => row.id === configuration.provider);
        if (info?.models.length && !info.models.some((model) => model.id === configuration.model || model.aliases?.includes(configuration.model))) throw badRequest('Choose a model from the current provider catalog for agent defaults.');
        resolveRunConfig(info, configuration, { effort: true, policy: true, serviceTier: true });
      }
    }
    const next = s.store.tx(() => {
      const updated = s.store.updateSettings(patch);
      s.store.recordEvent({ type: 'settings.updated', summary: 'Settings updated', payload: { fields: Object.keys(patch) } });
      return updated;
    });
    if (before.antigravityExecutable !== next.antigravityExecutable) cancelAntigravityAuth(s.config.dataDir);
    if (before.claudeExecutable !== next.claudeExecutable || before.codexExecutable !== next.codexExecutable || before.antigravityExecutable !== next.antigravityExecutable) s.providers.invalidate();
    return next;
  });
  add('GET', '/api/providers', () => s.providers.list());
  add('GET', '/api/providers/antigravity/auth', () => antigravityAuthState(s.config.dataDir, s.store.getSettings()));
  add('POST', '/api/providers/antigravity/auth', async (ctx) => {
    await ctx.body(z.object({}).strict());
    return startAntigravityAuth(s.config.dataDir, s.store.getSettings(), () => {
      s.providers.invalidate();
      touch();
    });
  });
  add('DELETE', '/api/providers/antigravity/auth', () => cancelAntigravityAuth(s.config.dataDir));
  add('GET', '/api/providers/antigravity/install', () => antigravityInstallState(s.config.dataDir));
  add('POST', '/api/providers/antigravity/install', async (ctx) => {
    await ctx.body(z.object({}).strict());
    const previousExecutable = s.store.getSettings().antigravityExecutable;
    return startAntigravityInstall(s.config.dataDir, (executable) => {
      s.store.tx(() => {
        // A long download must not overwrite a path the user selected in the meantime.
        if (s.store.getSettings().antigravityExecutable === previousExecutable) {
          if (previousExecutable !== executable) cancelAntigravityAuth(s.config.dataDir);
          s.store.updateSettings({ antigravityExecutable: executable });
        }
        s.store.recordEvent({ type: 'provider.installed', summary: 'Antigravity runtime installed', payload: { provider: 'antigravity', version: '1.4.1' } });
      });
      s.providers.invalidate();
      touch();
    });
  });
  add('POST', '/api/providers/refresh', async () => {
    const result = await s.providers.refresh();
    touch();
    return result;
  });
  add('GET', '/api/events', (ctx) => {
    const query = parse(EventsQuery, Object.fromEntries(ctx.url.searchParams));
    return s.store.listEvents({ after: query.after, projectId: query.projectId, limit: query.limit });
  });

  return async function dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<Reply> {
    const method = (req.method ?? 'GET').toUpperCase();
    let pathMatched = false;
    for (const route of routes) {
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]!); });
      const ctx: Ctx = { req, res, url, params, body: async (schema) => parse(schema, await readBody(req)) };
      const result = await route.handler(ctx);
      return result instanceof Reply ? result : new Reply(200, result);
    }
    if (pathMatched) throw new HttpError(405, 'Method not allowed');
    throw notFound('Unknown API route');
  };
}

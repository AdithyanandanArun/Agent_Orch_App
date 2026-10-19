import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CreateProjectSchema, CreateSessionSchema } from '@relay/contracts';
import type { Project, Session } from '@relay/contracts';
import type { z } from 'zod';
import { addWorktree, repoInfo } from './git.ts';
import type { RuntimeLike } from './app-types.ts';
import type { Store } from './store.ts';
import { badRequest, conflict, newId, notFound, slugify, unprocessable } from './util.ts';

type CreateProject = z.infer<typeof CreateProjectSchema>;
type CreateSession = z.infer<typeof CreateSessionSchema>;

/** Project and session lifecycle: canonical paths, worktree isolation, archival. */
export class WorkspaceService {
  constructor(private readonly store: Store, private readonly dataDir: string, private readonly runtime: RuntimeLike) {}

  async createProject(input: CreateProject): Promise<{ project: Project; created: boolean }> {
    let requested = input.path;
    if (requested === '~' || requested.startsWith('~/')) requested = path.join(os.homedir(), requested.slice(1));
    if (!path.isAbsolute(requested)) throw badRequest('Project path must be absolute');
    let real: string;
    try {
      real = await fsp.realpath(requested);
    } catch {
      throw badRequest('Project path does not exist');
    }
    const stat = await fsp.stat(real);
    if (!stat.isDirectory()) throw badRequest('Project path is not a directory');
    if (real === path.parse(real).root) throw badRequest('Refusing to open the filesystem root as a project');
    const existing = this.store.getProjectByPath(real);
    if (existing) return { project: existing, created: false };
    const project = this.store.tx(() => {
      const created = this.store.insertProject({ name: input.name, path: real });
      this.store.recordEvent({ projectId: created.id, type: 'project.created', summary: `Project opened: ${created.name}`, payload: { projectId: created.id } });
      return created;
    });
    return { project, created: true };
  }

  async createSession(input: CreateSession): Promise<Session> {
    const project = this.store.getProject(input.projectId);
    if (!project) throw notFound('Project not found');
    const id = newId('ses');
    let worktreePath = project.path;
    let branch: string | null = null;
    const info = await repoInfo(project.path);
    if (input.isolated) {
      if (!info.isRepo) throw unprocessable('This project is not a Git repository, so an isolated worktree cannot be created. Create the session with isolated=false to work directly in the folder.');
      if (!info.hasHead) throw unprocessable('This repository has no commits yet. Make an initial commit before creating an isolated session, or opt out of isolation.');
      branch = `relay/${slugify(input.name)}-${id.slice(4, 12)}`;
      const target = path.join(this.dataDir, 'worktrees', project.id, id);
      await addWorktree(project.path, target, branch);
      // A project that lives in a sub-directory of its repository keeps the same relative position in the worktree.
      worktreePath = info.prefix ? path.join(await fsp.realpath(target), ...info.prefix.split('/')) : await fsp.realpath(target);
    } else if (info.isRepo) {
      branch = info.branch;
    }
    return this.store.tx(() => {
      const session = this.store.insertSession({ id, projectId: project.id, name: input.name, provider: input.provider, model: input.model, effort: input.effort, policy: input.policy, isolated: input.isolated, worktreePath, branch });
      this.store.recordEvent({ projectId: project.id, sessionId: id, type: 'session.created', summary: `Session created: ${session.name}`, payload: { provider: session.provider, model: session.model, isolated: session.isolated, branch } });
      return session;
    });
  }

  renameSession(id: string, name: string): Session {
    const session = this.store.getSession(id);
    if (!session) throw notFound('Session not found');
    return this.store.tx(() => {
      const updated = this.store.updateSession(id, { name });
      this.store.recordEvent({ projectId: session.projectId, sessionId: id, type: 'session.renamed', summary: `Session renamed: ${session.name} → ${name}`, payload: { from: session.name, to: name } });
      return updated;
    });
  }

  /** Archives session metadata. The worktree and its branch are intentionally left on disk. */
  archiveSession(id: string): void {
    const session = this.store.getSession(id);
    if (!session) throw notFound('Session not found');
    if (this.runtime.isActive(id) || session.status === 'running' || session.status === 'waiting') throw conflict('Interrupt the running session before archiving it');
    this.store.tx(() => {
      const tasks = this.store.unassignTasksOfSession(id);
      this.store.archiveSession(id);
      this.store.recordEvent({ projectId: session.projectId, sessionId: id, type: 'session.archived', summary: `Session archived: ${session.name}`, payload: { worktreeKept: session.worktreePath, unassignedTasks: tasks.map((t) => t.id) } });
    });
  }

  /** Resolves the directory a project- or session-scoped request operates on. */
  resolveScope(projectId: string, sessionId?: string): { project: Project; root: string; session?: Session } {
    const project = this.store.getProject(projectId);
    if (!project) throw notFound('Project not found');
    if (!sessionId) return { project, root: project.path };
    const session = this.store.getSession(sessionId);
    if (!session || session.projectId !== project.id) throw notFound('Session not found in this project');
    return { project, root: session.worktreePath, session };
  }
}


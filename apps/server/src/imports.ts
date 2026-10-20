import fs from 'node:fs/promises';
import path from 'node:path';
import { ConversationIdSchema } from '@mingle/contracts';
import type { ExternalConversationDetails, ExternalConversationList, ImportConversationResult, Provider } from '@mingle/contracts';
import type { RuntimeLike } from './app-types.ts';
import { repoInfo } from './git.ts';
import type { ProviderService } from './provider-service.ts';
import { resolveRunConfig } from './session-config.ts';
import { defaultModel, providerExecutable, providerName } from './provider-config.ts';
import type { Store } from './store.ts';
import type { ProviderRuntime } from './types.ts';
import { badRequest, conflict, errorMessage, HttpError, notFound, redactSecrets, truncate } from './util.ts';

/** Metadata discovery never resumes a thread. Only an explicit composer send starts inference. */
function unsupportedImport(provider: 'antigravity' | 'opencode'): string {
  return provider === 'opencode'
    ? 'OpenCode conversation import is not supported. ACP can list native sessions, but Mingle has no verified bounded history reader for them; continue a Mingle OpenCode session to resume its conversation.'
    : 'Antigravity conversation import is not supported because its native history protocol has not been verified.';
}

export class ImportService {
  private pending = new Map<string, Promise<unknown>>();
  constructor(private store: Store, private native: ProviderRuntime, private providers: ProviderService, private runtime: RuntimeLike) {}

  private async discover<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    if (this.pending.size >= 4) throw conflict('Conversation history is busy. Try again shortly.');
    const promise = Promise.resolve().then(operation).catch((error) => {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `Could not read local conversation history: ${truncate(redactSecrets(errorMessage(error)), 400)}`);
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, promise);
    return promise;
  }

  async list(provider: Provider, projectId?: string, cursor?: string): Promise<ExternalConversationList> {
    if (provider === 'antigravity' || provider === 'opencode') throw badRequest(unsupportedImport(provider));
    if (!this.native.listConversations) throw badRequest('This runtime does not support importing conversations.');
    const project = projectId ? this.store.getProject(projectId) : undefined;
    if (projectId && !project) throw notFound('Project not found');
    const settings = this.store.getSettings();
    const result = await this.discover(JSON.stringify(['list', provider, project?.path, cursor, providerExecutable(provider, settings)]),
      () => this.native.listConversations!(provider, settings, { directory: project?.path, cursor }));
    return { ...result, conversations: result.conversations.filter((row) => row.provider === provider && ConversationIdSchema.safeParse(row.id).success).map((row) => {
      const existing = this.store.findProviderSession(provider, row.id);
      return { ...row, ...(existing ? { importedSessionId: existing.id } : {}) };
    }) };
  }

  private async directory(value: string | null): Promise<string> {
    if (!value || value.length > 4096 || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw badRequest('This conversation has no usable original folder.');
    let canonical: string;
    try {
      canonical = await fs.realpath(value);
      if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Not a folder');
    } catch { throw badRequest('The original folder is no longer available on this device.'); }
    if (canonical === path.parse(canonical).root) throw badRequest('The filesystem root cannot be used as a session folder.');
    return canonical;
  }

  async read(provider: Provider, id: string): Promise<ExternalConversationDetails> {
    if (provider === 'antigravity' || provider === 'opencode') throw badRequest(unsupportedImport(provider));
    if (!ConversationIdSchema.safeParse(id).success) throw badRequest('Invalid conversation ID');
    if (!this.native.readConversation) throw badRequest('This runtime does not support importing conversations.');
    const settings = this.store.getSettings();
    const result = await this.discover(JSON.stringify(['read', provider, id, providerExecutable(provider, settings)]),
      () => this.native.readConversation!(provider, settings, id));
    const latestSettings = this.store.getSettings();
    if (latestSettings.codexExecutable !== settings.codexExecutable || latestSettings.claudeExecutable !== settings.claudeExecutable || latestSettings.antigravityExecutable !== settings.antigravityExecutable || latestSettings.opencodeExecutable !== settings.opencodeExecutable) throw conflict('Provider settings changed while loading history. Open the conversation again.');
    if (result.conversation.id !== id || result.conversation.provider !== provider) throw conflict('The provider returned a different conversation. Refresh the history list.');
    // Never mutate a shared in-flight result while decorating it for this request.
    const conversation = { ...result.conversation };
    const existing = this.store.findProviderSession(provider, id);
    if (existing) conversation.importedSessionId = existing.id;
    try { await this.directory(conversation.directory); }
    catch (error) { conversation.unavailableReason = errorMessage(error); }
    return { ...result, conversation };
  }

  async import(provider: Provider, id: string): Promise<ImportConversationResult> {
    if (provider === 'antigravity' || provider === 'opencode') throw badRequest(unsupportedImport(provider));
    const details = await this.read(provider, id);
    if (details.conversation.unavailableReason) throw badRequest(details.conversation.unavailableReason);
    const directory = await this.directory(details.conversation.directory);
    const info = await repoInfo(directory);
    const settings = this.store.getSettings();
    const metadata = this.providers.cached()?.find((row) => row.id === provider);
    const recordedModel = details.conversation.model;
    const known = metadata?.models.find((row) => row.id === recordedModel || row.aliases?.includes(recordedModel ?? ''));
    const model = known?.id ?? defaultModel(provider, settings);
    const config = resolveRunConfig(metadata, { provider, model, effort: settings.defaultEffort, policy: 'supervised', serviceTier: 'standard' });
    const notices = [...details.notices];
    if (!known) notices.push('The original model was not reported or is no longer listed. This session uses your saved provider model.');
    let remaining = 2_000_000;
    let limited = details.truncated || details.messages.length > 200;
    const prepared: typeof details.messages = [];
    for (const message of details.messages.slice(-200).reverse()) {
      if (remaining <= 0) { limited = true; break; }
      const redacted = redactSecrets(message.content);
      const maximum = Math.min(20_000, remaining);
      const content = truncate(redacted, maximum);
      if (redacted.length > maximum) limited = true;
      if (!content.trim()) continue;
      remaining -= content.length;
      prepared.push({ ...message, content });
    }
    prepared.reverse();
    if (limited) notices.push('The displayed transcript is limited. The provider retains the original conversation context.');
    return this.store.tx(() => {
      // Recheck inside the transaction so concurrent requests cannot create duplicate imports.
      const existing = this.store.findProviderSession(provider, id);
      if (existing) {
        if (this.runtime.isActive(existing.id) || existing.status === 'running' || existing.status === 'waiting') throw conflict('This conversation is already running in Mingle.');
        if (existing.worktreePath !== directory) throw conflict('This conversation already belongs to a Mingle session in a different folder. Open that session to continue.');
        if (!this.store.getProject(existing.projectId)) {
          const restored = this.store.restoreProject(existing.projectId);
          this.store.recordEvent({ projectId: restored.id, type: 'project.restored', summary: `Project reopened: ${restored.name}`, payload: { projectId: restored.id } });
        }
        const archived = !this.store.getSession(existing.id);
        const session = archived ? this.store.restoreSession(existing.id) : existing;
        const project = this.store.getProject(session.projectId)!;
        if (archived) this.store.recordEvent({ projectId: project.id, sessionId: session.id, type: 'session.restored', summary: `Session restored: ${session.name}`, payload: {} });
        return { session, project, alreadyImported: true, notices: ['Opened the existing Mingle session; its settings and transcript were kept.'] };
      }
      const prior = this.store.getProjectByPath(directory, true);
      const removed = prior && !this.store.getProject(prior.id);
      const project = prior ? this.store.restoreProject(prior.id) : this.store.insertProject({ name: path.basename(directory).slice(0, 100) || 'Imported project', path: directory });
      if (removed) this.store.recordEvent({ projectId: project.id, type: 'project.restored', summary: `Project reopened: ${project.name}`, payload: { projectId: project.id } });
      const created = this.store.insertSession({ projectId: project.id, name: redactSecrets(details.conversation.title).trim().slice(0, 100) || 'Imported conversation',
        provider, model, effort: config.effort, policy: 'supervised', serviceTier: 'standard', isolated: false, worktreePath: directory, branch: info.isRepo ? info.branch : null });
      const session = this.store.updateSession(created.id, { providerSessionId: id });
      for (const message of prepared) {
        const date = message.createdAt && Number.isFinite(Date.parse(message.createdAt)) ? new Date(message.createdAt).toISOString() : undefined;
        this.store.insertMessage({ sessionId: session.id, role: message.role, content: message.content, kind: 'imported', createdAt: date });
      }
      this.store.insertMessage({ sessionId: session.id, role: 'system', kind: 'info', content: [
        `Imported ${providerName(provider)} conversation. Your next message resumes it in its original folder. This session works directly in that folder with Supervised permissions.`, ...notices,
      ].join('\n\n') });
      this.store.recordEvent({ projectId: project.id, sessionId: session.id, type: 'session.imported', summary: `Conversation imported: ${session.name}`, payload: { provider, isolated: false } });
      return { session, project, alreadyImported: false, notices };
    });
  }
}

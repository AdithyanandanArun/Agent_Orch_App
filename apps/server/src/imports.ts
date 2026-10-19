import fs from 'node:fs/promises';
import path from 'node:path';
import { ConversationIdSchema } from '@relay/contracts';
import type { ExternalConversationDetails, ExternalConversationList, ImportConversationResult, Provider } from '@relay/contracts';
import type { RuntimeLike } from './app-types.ts';
import { repoInfo } from './git.ts';
import type { ProviderService } from './provider-service.ts';
import { resolveRunConfig } from './session-config.ts';
import type { Store } from './store.ts';
import type { ProviderRuntime } from './types.ts';
import { badRequest, conflict, errorMessage, HttpError, notFound, redactSecrets, truncate } from './util.ts';

/** Metadata discovery never resumes a thread. Only an explicit composer send starts inference. */
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
    if (!this.native.listConversations) throw badRequest('This runtime does not support importing conversations.');
    const project = projectId ? this.store.getProject(projectId) : undefined;
    if (projectId && !project) throw notFound('Project not found');
    const settings = this.store.getSettings();
    const result = await this.discover(JSON.stringify(['list', provider, project?.path, cursor, settings.codexExecutable, settings.claudeExecutable]),
      () => this.native.listConversations!(provider, settings, { directory: project?.path, cursor }));
    return { ...result, conversations: result.conversations.filter((row) => row.provider === provider && ConversationIdSchema.safeParse(row.id).success).map((row) => {
      const existing = this.store.findProviderSession(provider, row.id);
      return { ...row, ...(existing ? { importedSessionId: existing.id } : {}) };
    }) };
  }

  private async directory(value: string | null): Promise<string> {
    if (!value || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw badRequest('This conversation has no usable original folder.');
    let canonical: string;
    try {
      canonical = await fs.realpath(value);
      if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Not a folder');
    } catch { throw badRequest('The original folder is no longer available on this device.'); }
    if (canonical === path.parse(canonical).root) throw badRequest('The filesystem root cannot be used as a session folder.');
    return canonical;
  }

  async read(provider: Provider, id: string): Promise<ExternalConversationDetails> {
    if (!ConversationIdSchema.safeParse(id).success) throw badRequest('Invalid conversation ID');
    if (!this.native.readConversation) throw badRequest('This runtime does not support importing conversations.');
    const settings = this.store.getSettings();
    const result = await this.discover(JSON.stringify(['read', provider, id, settings.codexExecutable, settings.claudeExecutable]),
      () => this.native.readConversation!(provider, settings, id));
    const latestSettings = this.store.getSettings();
    if (latestSettings.codexExecutable !== settings.codexExecutable || latestSettings.claudeExecutable !== settings.claudeExecutable) throw conflict('Provider settings changed while loading history. Open the conversation again.');
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
    const details = await this.read(provider, id);
    if (details.conversation.unavailableReason) throw badRequest(details.conversation.unavailableReason);
    const directory = await this.directory(details.conversation.directory);
    const info = await repoInfo(directory);
    const settings = this.store.getSettings();
    const metadata = this.providers.cached()?.find((row) => row.id === provider);
    const recordedModel = details.conversation.model;
    const known = metadata?.models.find((row) => row.id === recordedModel || row.aliases?.includes(recordedModel ?? ''));
    const model = known?.id ?? (provider === 'codex' ? settings.defaultCodexModel : settings.defaultClaudeModel);
    const config = resolveRunConfig(metadata, { provider, model, effort: settings.defaultEffort, policy: 'supervised', serviceTier: 'standard' });
    const notices = [...details.notices];
    if (!known) notices.push('The original model was not reported or is no longer listed. This session uses your saved provider model.');
    if (details.truncated) notices.push('The displayed transcript is limited. The provider retains the original conversation context.');
    return this.store.tx(() => {
      // Recheck inside the transaction so concurrent requests cannot create duplicate imports.
      const existing = this.store.findProviderSession(provider, id);
      if (existing) {
        if (this.runtime.isActive(existing.id) || existing.status === 'running' || existing.status === 'waiting') throw conflict('This conversation is already running in Relay.');
        if (existing.worktreePath !== directory) throw conflict('This conversation already belongs to a Relay session in a different folder. Open that session to continue.');
        const archived = !this.store.getSession(existing.id);
        const session = archived ? this.store.restoreSession(existing.id) : existing;
        const project = this.store.getProject(session.projectId)!;
        if (archived) this.store.recordEvent({ projectId: project.id, sessionId: session.id, type: 'session.restored', summary: `Session restored: ${session.name}`, payload: {} });
        return { session, project, alreadyImported: true, notices: ['Opened the existing Relay session; its settings and transcript were kept.'] };
      }
      const project = this.store.getProjectByPath(directory) ?? this.store.insertProject({ name: path.basename(directory).slice(0, 100) || 'Imported project', path: directory });
      const created = this.store.insertSession({ projectId: project.id, name: redactSecrets(details.conversation.title).trim().slice(0, 100) || 'Imported conversation',
        provider, model, effort: config.effort, policy: 'supervised', serviceTier: 'standard', isolated: false, worktreePath: directory, branch: info.isRepo ? info.branch : null });
      const session = this.store.updateSession(created.id, { providerSessionId: id });
      let remaining = 2_000_000;
      for (const message of details.messages.slice(-200)) {
        if (remaining <= 0) break;
        const content = truncate(redactSecrets(message.content), Math.min(20_000, remaining));
        if (!content.trim()) continue;
        remaining -= content.length;
        const date = message.createdAt && Number.isFinite(Date.parse(message.createdAt)) ? new Date(message.createdAt).toISOString() : undefined;
        this.store.insertMessage({ sessionId: session.id, role: message.role, content, kind: 'imported', createdAt: date });
      }
      this.store.insertMessage({ sessionId: session.id, role: 'system', kind: 'info', content: [
        `Imported ${provider === 'codex' ? 'Codex' : 'Claude'} conversation. Your next message resumes it in its original folder. This session works directly in that folder with Supervised permissions.`, ...notices,
      ].join('\n\n') });
      this.store.recordEvent({ projectId: project.id, sessionId: session.id, type: 'session.imported', summary: `Conversation imported: ${session.name}`, payload: { provider, isolated: false } });
      return { session, project, alreadyImported: false, notices };
    });
  }
}

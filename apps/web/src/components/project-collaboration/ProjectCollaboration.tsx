import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, CircleAlert, FolderOpen, Mail, RefreshCw, Users } from 'lucide-react';
import type { AccountState, Project, Provider, ProviderInfo, ProviderModel, Session } from '@mingle/contracts';
import { api, errorMessage } from '../../lib/api';
import { useMingle } from '../../store/store';
import { copyText } from '../../lib/clipboard';
import { createIdempotencyKey, distributedApi } from '../distributed/api';
import { Badge, Button, InlineError, Modal, ProviderMark, StatusDot } from '../ui';
import { projectCollaborationApi, CollaborationApiError, recordText, type CollaborationRecord, type InvitationPreview, type ProjectCollaborationSnapshot } from './api';
import '../../styles/project-collaboration.css';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const JOIN_PROVIDERS: Provider[] = ['codex', 'claude', 'opencode'];

function errorStatus(cause: unknown): number {
  return cause instanceof CollaborationApiError ? cause.status : 0;
}

function selectedProviderInfo(providers: readonly ProviderInfo[], provider: string): ProviderInfo | undefined {
  return providers.find((item) => item.id === provider && JOIN_PROVIDERS.includes(item.id));
}

function supervisedModels(info: ProviderInfo | undefined): ProviderModel[] {
  if (!info?.available) return [];
  return info.models.filter((model) => {
    const policies = model.policies ?? info.policies;
    const supportsSupervised = policies ? policies.includes('supervised') : JOIN_PROVIDERS.includes(info.id);
    return supportsSupervised && reasoningChoices(info, model).length > 0;
  });
}

/** Use native catalog choices when reported; otherwise mirror the runtime's documented defaults. */
function reasoningChoices(info: ProviderInfo, model: ProviderModel): NonNullable<ProviderModel['reasoningEfforts']> {
  if (model.reasoningEfforts?.length) return model.reasoningEfforts;
  if (model.reasoningEfforts) return [{ id: 'none', label: 'Native/default' }];
  if (info.id === 'codex' || info.id === 'claude') return [
    { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
  ];
  return [{ id: 'none', label: 'Native/default' }];
}

function localSessionLabel(session: Session): string {
  return `${session.provider[0]!.toUpperCase()}${session.provider.slice(1)} · ${session.model}`;
}

export function ProjectTeammatesDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const boot = useMingle((state) => state.boot);
  const localSessions = (boot?.sessions ?? []).filter((session) => session.projectId === project.id);
  const [snapshot, setSnapshot] = useState<ProjectCollaborationSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<{ status: 'sent' | 'failed' | 'not_configured'; message: string; email: string; joinUrl?: string } | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [localSelection, setLocalSelection] = useState<string[] | null>(null);
  const [sharing, setSharing] = useState(false);
  const [note, setNote] = useState('');
  const [taskId, setTaskId] = useState('');
  const [sharedAction, setSharedAction] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await projectCollaborationApi.snapshot(project.id, signal);
      if (id === requestId.current && !signal?.aborted) setSnapshot(result);
    } catch (cause) {
      if (id === requestId.current && !signal?.aborted) setError(errorMessage(cause));
    } finally {
      if (id === requestId.current && !signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { requestId.current++; controller.abort(); };
    // `project.id` keys the dialog; use one bounded initial read per dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => {
    const controller = new AbortController();
    void api.account(controller.signal).then(setAccount).catch(() => setAccount(null));
    return () => controller.abort();
  }, []);

  const localAgents = localSessions;
  const rosterAgents = snapshot?.agents ?? [];
  const sharedLocalIds = localAgents.filter((session) => rosterAgents.some((agent) => recordText(agent, ['sessionId']) === session.id)).map((session) => session.id);
  const remoteAgents = rosterAgents.filter((agent) => !(account?.user?.id && recordText(agent, ['accountId']) === account.user.id && localAgents.some((session) => session.id === recordText(agent, ['sessionId']))));
  const selectedLocalIds = localSelection ?? sharedLocalIds;
  const manageableRole = snapshot?.members.find((member) => recordText(member, ['accountId']) === account?.user?.id)?.role;
  const canManageRoster = manageableRole === 'leader' || manageableRole === 'admin';
  const memberMap = new Map(snapshot?.members.map((member) => [recordText(member, ['accountId']), member]) ?? []);
  const shareableTasks = (boot?.tasks ?? []).filter((task) => task.projectId === project.id);
  const selectedRemote = remoteAgents.find((agent, index) => {
    const agentId = recordText(agent, ['id', 'agentId', 'sharedAgentId'], `team-agent-${index}`);
    return agentId === selectedAgentId;
  });
  const emailStatus = snapshot?.email;

  const sendInvite = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalized) || sending) return;
    setSending(true);
    setError(null);
    setDelivery(null);
    try {
      const result = await projectCollaborationApi.invite(project.id, { email: normalized, role });
      setDelivery({
        status: result.delivery.status,
        email: result.invitation.email || normalized,
        message: result.delivery.message ?? '',
        ...((result.joinUrl ?? result.invitation.joinUrl) ? { joinUrl: result.joinUrl ?? result.invitation.joinUrl } : {}),
      });
      setEmail('');
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSending(false); }
  };

  const updatePublishedAgents = async () => {
    if (!snapshot?.project || !canManageRoster || sharing) return;
    setSharing(true);
    setError(null);
    try {
      await distributedApi.publishAgents({ teamId: snapshot.project.teamId, sharedProjectId: snapshot.project.sharedProjectId, sessionIds: selectedLocalIds.filter((id) => localAgents.some((session) => session.id === id && session.policy === 'supervised')) });
      setSharedAction('Your selected Supervised local agents are now reflected in the shared project roster.');
      setLocalSelection(null);
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSharing(false); }
  };

  const revokeMember = async (member: CollaborationRecord) => {
    const accountId = recordText(member, ['accountId']);
    const address = recordText(member, ['email'], 'this teammate');
    if (!snapshot?.project || !accountId || !canManageRoster || accountId === account?.user?.id) return;
    if (!window.confirm(`Remove ${address} from this project team? Their devices will lose future team authority.`)) return;
    setError(null);
    try {
      await distributedApi.revokeMember({ teamId: snapshot.project.teamId, userId: accountId });
      setSharedAction(`${address} was removed from the project roster.`);
      await refresh();
    } catch (cause) { setError(errorMessage(cause)); }
  };

  const shareNote = async (event: FormEvent) => {
    event.preventDefault();
    const content = note.trim();
    if (!content || !snapshot?.project || sharedAction === 'sending-note') return;
    setSharedAction('sending-note');
    setError(null);
    try {
      await distributedApi.sendMessage({ teamId: snapshot.project.teamId, sharedProjectId: snapshot.project.sharedProjectId, content, idempotencyKey: createIdempotencyKey() });
      setNote('');
      setSharedAction('Project note shared with the team. No local provider session was started.');
      await refresh();
    } catch (cause) { setSharedAction(null); setError(errorMessage(cause)); }
  };

  const shareTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!taskId || !snapshot?.project) return;
    setSharedAction('sharing-task');
    setError(null);
    try {
      await distributedApi.publishTask({ teamId: snapshot.project.teamId, sharedProjectId: snapshot.project.sharedProjectId, taskId });
      setSharedAction('Task shared with the project team.');
      await refresh();
    } catch (cause) { setSharedAction(null); setError(errorMessage(cause)); }
  };

  const openTeamWorkspace = () => {
    onClose();
    useMingle.getState().openSettings({ section: 'team', projectId: project.id, teamTab: 'recovery' });
  };

  return <Modal title="Teammates" description={`Invite people to work on ${project.name}. Your local agents stay yours.`} onClose={onClose} width={640}>
    <div className="pc-dialog" aria-busy={loading || sending}>
      <div className="pc-invite-intro"><span className="pc-icon"><Mail size={17} /></span><div><strong>Invite by email</strong><p>They’ll join this project from their own Mingle and choose their own checkout and provider.</p></div></div>
      {emailStatus?.configured === false ? <p className="pc-inline-note" role="status"><CircleAlert size={14} /> Email delivery is not configured. {emailStatus.message || 'New invites may be created, but they cannot be delivered until email is configured.'}</p> : null}
      {error ? <InlineError onRetry={() => void refresh()}>{error}</InlineError> : null}
      <form className="pc-invite-form" onSubmit={(event) => void sendInvite(event)}>
        <label className="pc-field pc-field--email"><span>Teammate email</span><input autoComplete="email" type="email" value={email} onChange={(event) => { setEmail(event.target.value); setDelivery(null); }} placeholder="name@example.com" required /></label>
        <label className="pc-field pc-field--role"><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value as 'member' | 'admin')}><option value="member">Member</option><option value="admin">Admin</option></select></label>
        <Button type="submit" variant="primary" size="sm" disabled={!EMAIL_PATTERN.test(email.trim()) || sending} busy={sending}>Send invite</Button>
      </form>
      {delivery ? <div className={`pc-delivery pc-delivery--${delivery.status}`} role="status">
        {delivery.status === 'sent' ? <Check size={14} /> : <CircleAlert size={14} />}
        <span>{delivery.status === 'sent' ? `Invitation email sent to ${delivery.email}.` : delivery.status === 'failed' ? `Invitation created, but email delivery failed for ${delivery.email}.` : `Invitation created, but no email was sent to ${delivery.email}.`}{delivery.message ? ` ${delivery.message}` : ''}</span>
        {delivery.joinUrl ? <Button size="sm" onClick={() => void copyText(delivery.joinUrl!).then(() => useMingle.getState().toast('success', 'Join link copied.')).catch(() => setError('Could not copy the join link.'))}>Copy join link</Button> : null}
      </div> : null}
      <div className="pc-roster-head"><div><h3>Project agents</h3><p>Inspect local and teammate agents together. Remote owners keep control of their model, permissions, stop and spend approvals.</p></div><Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()} aria-label="Refresh project agents"><RefreshCw size={13} />Refresh</Button></div>
      {loading && !snapshot ? <p className="pc-loading" role="status">Loading project roster…</p> : null}
      {snapshot?.project ? <p className="pc-project-ref"><Users size={13} /> {snapshot.project.name} <span>· shared project connected</span></p> : null}
      {!loading && snapshot && !snapshot.project ? <p className="pc-inline-note" role="status">This project’s collaboration workspace is being prepared. Refresh in a moment to see its roster.</p> : null}
      <div className="pc-agent-list" role="list" aria-label="Local and teammate agents">
        {localAgents.map((session) => <div className="pc-agent-row" role="listitem" key={`local-${session.id}`}>
          <input type="checkbox" aria-label={`Share ${session.name} with this project`} checked={selectedLocalIds.includes(session.id)} disabled={!snapshot?.project || !canManageRoster || session.policy !== 'supervised'} title={session.policy !== 'supervised' ? 'Only Supervised local agents can be shared.' : undefined} onChange={(event) => setLocalSelection((current) => {
            const selected = current ?? sharedLocalIds;
            return event.target.checked ? [...new Set([...selected, session.id])] : selected.filter((id) => id !== session.id);
          })} />
          <button type="button" className="pc-agent-select" onClick={() => { useMingle.getState().selectSession(session.id); onClose(); }} aria-label={`Inspect local agent ${session.name}`}>
            <ProviderMark provider={session.provider} size={17} /><span className="pc-agent-copy"><strong>{session.name}</strong><small>{localSessionLabel(session)} · this device</small></span><StatusDot status={session.status} /><Badge>Local</Badge>
          </button>
        </div>)}
        {remoteAgents.map((agent, index) => {
          const id = recordText(agent, ['id', 'agentId', 'sharedAgentId'], `team-agent-${index}`);
          const accountId = recordText(agent, ['accountId']);
          const member = memberMap.get(accountId);
          const provider = recordText(agent, ['provider'], 'Provider not reported');
          const model = recordText(agent, ['model'], 'Model not reported');
          const device = recordText(agent, ['deviceName', 'deviceId'], 'Device not reported');
          const ownerName = recordText(member, ['displayName', 'email'], accountId || 'Owner not reported');
          const name = recordText(agent, ['name', 'agentName', 'sessionName'], `${provider} agent`);
          const state = recordText(agent, ['state'], 'State not reported');
          const selected = selectedAgentId === id;
          return <div className={`pc-agent-row pc-agent-row--remote${selected ? ' is-selected' : ''}`} role="listitem" key={`remote-${id}`}>
            <button type="button" className="pc-agent-select" aria-pressed={selected} onClick={() => setSelectedAgentId(selected ? null : id)}>
              <span className="pc-team-avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span><span className="pc-agent-copy"><strong>{name}</strong><small>{ownerName} · {provider} · {model} · {device}</small></span><Badge tone={/busy|running/i.test(state) ? 'info' : 'neutral'}>{state}</Badge><Badge>Team</Badge>
            </button>
          </div>;
        })}
        {!localAgents.length && !remoteAgents.length && snapshot?.project ? <p className="pc-empty">No agents have been shared for this project yet. Existing local sessions remain private until you explicitly publish them.</p> : null}
      </div>
      {snapshot?.project && localAgents.length ? <div className="pc-roster-actions"><span>{selectedLocalIds.length} local agents selected · only Supervised sessions can be shared</span><Button size="sm" disabled={!canManageRoster || sharing || selectedLocalIds.length === 0 && sharedLocalIds.length === 0} busy={sharing} onClick={() => void updatePublishedAgents()}>Update shared agents</Button></div> : null}
      {selectedRemote ? <div className="pc-owner-note"><strong>{recordText(selectedRemote, ['name', 'agentName', 'sessionName'], `${recordText(selectedRemote, ['provider'], 'Teammate')} agent`)} · {recordText(selectedRemote, ['state'], 'State not reported')}</strong><span>Owner {recordText(memberMap.get(recordText(selectedRemote, ['accountId'])), ['displayName', 'email'], 'not reported')} · device {recordText(selectedRemote, ['deviceId'], 'not reported')} · {recordText(selectedRemote, ['provider'], 'Provider not reported')} · {recordText(selectedRemote, ['model'], 'Model not reported')} · owner retains model, permission, stop and spend control.</span><Button size="sm" onClick={openTeamWorkspace}>Open recovery controls <ArrowUpRight size={13} /></Button></div> : null}
      {snapshot?.project ? <div className="pc-shared-actions">
        <form className="pc-shared-note" onSubmit={(event) => void shareNote(event)}><label className="pc-field"><span>Share a project note</span><textarea value={note} onChange={(event) => { setNote(event.target.value); if (sharedAction && sharedAction !== 'sending-note') setSharedAction(null); }} placeholder="A decision, update or question for the team…" maxLength={5000} /></label><Button type="submit" size="sm" disabled={!note.trim() || sharedAction === 'sending-note'} busy={sharedAction === 'sending-note'}>Share note</Button></form>
        <form className="pc-share-task" onSubmit={(event) => void shareTask(event)}><label className="pc-field"><span>Share a project task</span><select aria-label="Task to share" value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">Choose a task…</option>{shareableTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><Button type="submit" size="sm" disabled={!taskId || sharedAction === 'sharing-task'} busy={sharedAction === 'sharing-task'}>Share task</Button></form>
        {sharedAction && !['sending-note', 'sharing-task'].includes(sharedAction) ? <p className="pc-shared-feedback" role="status">{sharedAction}</p> : null}
      </div> : null}
      {snapshot?.members?.length ? <details className="pc-members"><summary>Project members <span>{snapshot.members.length}</span></summary><div>{snapshot.members.map((member, index) => {
        const accountId = recordText(member, ['accountId']);
        const isSelf = Boolean(accountId && accountId === account?.user?.id);
        const memberRole = recordText(member, ['role'], 'member');
        const mayRemove = canManageRoster && !isSelf && memberRole !== 'leader' && (manageableRole === 'leader' || memberRole === 'member');
        return <p key={accountId || `member-${index}`}><span><strong>{recordText(member, ['displayName', 'email'], 'Project member')}</strong><small>{recordText(member, ['email'], 'Email not shared')} · {memberRole}{isSelf ? ' · you' : ''}</small></span>{mayRemove ? <Button size="sm" variant="danger" onClick={() => void revokeMember(member)}>Remove</Button> : null}</p>;
      })}</div></details> : null}
      {snapshot?.invitations?.length ? <details className="pc-invitations"><summary>Recent invitations <span>{snapshot.invitations.length}</span></summary><div>{snapshot.invitations.map((invite, index) => <p key={recordText(invite, ['id'], `invite-${index}`)}><strong>{recordText(invite, ['email'], 'Email not reported')}</strong><small>{recordText(invite, ['status', 'state'], 'Status not reported')} · expires {recordText(invite, ['expiresAt', 'expires_at'], 'not reported')}</small></p>)}</div></details> : null}
      <p className="pc-no-run-note">Inviting, joining and publishing agents don’t start a model run.</p>
    </div>
  </Modal>;
}

type InviteState = 'loading' | 'ready' | 'sign-in' | 'wrong-account' | 'expired' | 'revoked' | 'setup' | 'error';

function repoName(url: string): string {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).at(-1) ?? 'project';
    return segment.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 100) || 'project';
  } catch {
    const segment = url.split(/[/:]/).filter(Boolean).at(-1) ?? 'project';
    return segment.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 100) || 'project';
  }
}

function classifyPreviewError(cause: unknown, account: AccountState | null): InviteState {
  const message = errorMessage(cause).toLowerCase();
  const status = errorStatus(cause);
  if (account?.status !== 'signed-in' && (status === 401 || status === 403)) return 'sign-in';
  if (/revok/.test(message)) return 'revoked';
  if (/expir|expired/.test(message) || status === 410) return 'expired';
  if (/email|account|match|recipient|invited/.test(message) || status === 403) return 'wrong-account';
  return 'error';
}

export function ProjectInviteJoinDialog({ token, onClose, onOpenAccountSettings, onOpenProviderSettings }: {
  token: string; onClose: () => void; onOpenAccountSettings: () => void; onOpenProviderSettings: () => void;
}) {
  const boot = useMingle((state) => state.boot);
  const projects = boot?.projects ?? [];
  const eligibleProviders = useMemo(() => JOIN_PROVIDERS.flatMap((id) => {
    const info = selectedProviderInfo(boot?.providers ?? [], id);
    return info && supervisedModels(info).length ? [info] : [];
  }), [boot?.providers]);
  const [inviteState, setInviteState] = useState<InviteState>('loading');
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [account, setAccount] = useState<AccountState | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [providerId, setProviderId] = useState<Provider | ''>('');
  const [modelId, setModelId] = useState('');
  const [effortId, setEffortId] = useState('');
  const [source, setSource] = useState<'existing' | 'folder' | 'clone'>('existing');
  const [folderPath, setFolderPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const previewSequence = useRef(0);

  const currentProvider = eligibleProviders.find((item) => item.id === providerId);
  const models = supervisedModels(currentProvider);
  const selectedModel = models.find((item) => item.id === modelId) ?? models[0];
  const efforts = selectedModel && currentProvider ? reasoningChoices(currentProvider, selectedModel) : [];
  const selectedProject = projects.find((project) => project.id === selectedProjectId && !project.isExample);
  const accountEmail = account?.user?.email?.trim().toLowerCase() ?? '';
  const inviteEmail = preview?.email.trim().toLowerCase() ?? '';
  const emailMatches = Boolean(accountEmail && inviteEmail && accountEmail === inviteEmail);
  const signedIn = account?.status === 'signed-in';
  const canJoin = inviteState === 'ready' && Boolean(preview && signedIn && emailMatches && selectedProject && currentProvider && selectedModel && effortId && !joining && !workspaceBusy);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++previewSequence.current;
    setInviteState('loading');
    setPreview(null);
    setPreviewError('');
    setError(null);
    if (!INVITATION_TOKEN_PATTERN.test(token)) {
      setPreviewError('This invitation link is incomplete or invalid. Ask the project leader to send a new invitation.');
      setInviteState('error');
      return () => { previewSequence.current++; controller.abort(); };
    }
    void Promise.allSettled([projectCollaborationApi.preview(token, controller.signal), api.account(controller.signal)]).then(([previewResult, accountResult]) => {
      if (controller.signal.aborted || sequence !== previewSequence.current) return;
      const nextAccount = accountResult.status === 'fulfilled' ? accountResult.value : null;
      setAccount(nextAccount);
      if (previewResult.status === 'fulfilled') {
        setPreview(previewResult.value);
        if (nextAccount?.status === 'signed-in' && nextAccount.user?.email?.trim().toLowerCase() !== previewResult.value.email.trim().toLowerCase()) setInviteState('wrong-account');
        else if (!nextAccount || nextAccount.status !== 'signed-in') setInviteState('sign-in');
        else setInviteState('ready');
      } else {
        const cause = previewResult.reason;
        setPreviewError(errorMessage(cause));
        setInviteState(classifyPreviewError(cause, nextAccount));
      }
    });
    return () => { previewSequence.current++; controller.abort(); };
  }, [previewRetry, token]);

  useEffect(() => {
    if (account?.status !== 'signing-in') return;
    const refresh = () => void api.account().then((value) => setAccount(value)).catch((cause) => setError(errorMessage(cause)));
    const timer = window.setInterval(refresh, 1600);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [account?.status]);

  useEffect(() => {
    if (account?.status !== 'signed-in' || preview || inviteState !== 'sign-in') return;
    const controller = new AbortController();
    void projectCollaborationApi.preview(token, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setPreview(value);
      setInviteState(account.user?.email?.trim().toLowerCase() === value.email.trim().toLowerCase() ? 'ready' : 'wrong-account');
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setPreviewError(errorMessage(cause));
      setInviteState(classifyPreviewError(cause, account));
    });
    return () => controller.abort();
  }, [account, inviteState, preview, token]);

  useEffect(() => {
    if (!preview || ['loading', 'expired', 'revoked', 'error'].includes(inviteState)) return;
    if (account?.status !== 'signed-in') { setInviteState('sign-in'); return; }
    setInviteState(account.user?.email?.trim().toLowerCase() === preview.email.trim().toLowerCase() ? 'ready' : 'wrong-account');
  }, [account, inviteState, preview]);

  useEffect(() => {
    if (!eligibleProviders.length) { setProviderId(''); setModelId(''); setEffortId(''); return; }
    const provider = eligibleProviders.find((item) => item.id === providerId) ?? eligibleProviders[0]!;
    const providerModels = supervisedModels(provider);
    const model = providerModels.find((item) => item.id === modelId) ?? providerModels[0]!;
    const effortOptions = reasoningChoices(provider, model);
    const nextEffort = effortOptions.find((item) => item.id === effortId)?.id
      ?? effortOptions.find((item) => item.id === model.defaultReasoningEffort)?.id
      ?? effortOptions[0]?.id ?? '';
    if (provider.id !== providerId) setProviderId(provider.id as Provider);
    if (model.id !== modelId) setModelId(model.id);
    if (nextEffort !== effortId) setEffortId(nextEffort);
  }, [eligibleProviders, providerId, modelId, effortId]);

  const chooseExistingProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    setSource('existing');
    setError(null);
  };

  const addExistingFolder = async (event: FormEvent) => {
    event.preventDefault();
    if (!folderPath.trim() || workspaceBusy) return;
    setWorkspaceBusy(true);
    setError(null);
    try {
      const listing = await api.directories(folderPath.trim(), '', false);
      if (!listing.canSelect) throw new Error('Choose an existing folder that Mingle can open.');
      const project = await api.createProject({ name: listing.displayPath.split(/[\\/]/).filter(Boolean).at(-1) || 'Project', path: listing.path });
      await useMingle.getState().refreshNow();
      setSelectedProjectId(project.id);
      setSource('existing');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setWorkspaceBusy(false); }
  };

  const cloneRepository = async (event: FormEvent) => {
    event.preventDefault();
    if (!preview?.repositoryUrl || !parentPath.trim() || workspaceBusy) return;
    setWorkspaceBusy(true);
    setError(null);
    try {
      const listing = await api.directories(parentPath.trim(), '', false);
      if (!(listing.canCreateWithin ?? listing.canSelect)) throw new Error('Choose a folder where Mingle can create the repository checkout.');
      const project = await api.cloneProject({ url: preview.repositoryUrl, name: repoName(preview.repositoryUrl), parentPath: listing.path });
      await useMingle.getState().refreshNow();
      setSelectedProjectId(project.id);
      setSource('existing');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setWorkspaceBusy(false); }
  };

  const signIn = async () => {
    setError(null);
    try { setAccount(await api.accountSignIn()); }
    catch (cause) { setError(errorMessage(cause)); }
  };

  const switchAccount = async () => {
    setError(null);
    try { setAccount(await api.accountSignOut()); setInviteState('sign-in'); }
    catch (cause) { setError(errorMessage(cause)); }
  };

  const joinProject = async () => {
    if (!canJoin || !preview || !selectedProject || !currentProvider || !selectedModel || joining) return;
    setJoining(true);
    setError(null);
    try {
      const result = await projectCollaborationApi.join({
        token,
        localProjectId: selectedProject.id,
        agent: { provider: currentProvider.id as 'codex' | 'claude' | 'opencode', model: selectedModel.id, effort: effortId, policy: 'supervised' },
      });
      await useMingle.getState().refreshNow();
      if (result.projectId) useMingle.getState().selectProject(result.projectId);
      if (result.sessionId) useMingle.getState().selectSession(result.sessionId);
      setJoined(true);
    } catch (cause) {
      const state = classifyPreviewError(cause, account);
      if (state === 'expired' || state === 'revoked' || state === 'wrong-account') {
        setPreviewError(errorMessage(cause));
        setInviteState(state);
      } else setError(errorMessage(cause));
    }
    finally { setJoining(false); }
  };

  return <Modal title={joined ? 'Project joined' : 'Join project'} description={joined ? 'Your local agent is ready.' : 'Choose where the project lives on this device, then create your first supervised agent.'} onClose={onClose} width={700}>
    <div className="pc-join" aria-busy={inviteState === 'loading' || joining || workspaceBusy}>
      {inviteState === 'loading' ? <p className="pc-loading" role="status">Checking invitation and Mingle account…</p> : null}
      {inviteState === 'expired' || inviteState === 'revoked' ? <div className="pc-state-card pc-state-card--error"><CircleAlert size={19} /><div><h3>{inviteState === 'revoked' ? 'This invitation was revoked' : 'This invitation has expired'}</h3><p>{previewError || 'Ask the project owner to send a new invitation.'}</p></div></div> : null}
      {inviteState === 'error' ? <div className="pc-state-card pc-state-card--error"><CircleAlert size={19} /><div><h3>We couldn’t verify this invitation</h3><p>{previewError ? `${previewError} It may be expired, revoked, already used or issued to another account. Sign in to the invited account or ask a project leader to send a new invitation.` : 'It may be expired, revoked, already used or issued to another account. Sign in to the invited account or ask a project leader to send a new invitation.'}</p>{accountEmail ? <small>Signed in as {accountEmail}</small> : null}<Button size="sm" onClick={() => setPreviewRetry((value) => value + 1)}>Try again</Button></div></div> : null}
      {inviteState === 'sign-in' ? <div className="pc-state-card"><span className="pc-icon"><Users size={18} /></span><div><h3>Sign in to join this project</h3><p>{preview ? `This invitation is for ${preview.email}. Sign in to that Mingle account to continue.` : 'Sign in with the Mingle account that received this invitation.'} Your invitation stays in this window while sign-in finishes.</p>
        {account?.status === 'signing-in' ? <p className="pc-loading" role="status">Finish signing in in your browser. This window will resume automatically.</p> : account?.configured
          ? <Button variant="primary" size="sm" disabled={account.status === 'restoring'} onClick={() => void signIn()}>Continue with Google</Button>
          : <Button size="sm" onClick={onOpenAccountSettings}>Set up Mingle account</Button>}
        {account?.browserError ? <p className="pc-help">{account.browserError}</p> : null}
      </div></div> : null}
      {inviteState === 'wrong-account' ? <div className="pc-state-card pc-state-card--error"><CircleAlert size={19} /><div><h3>Use the invited account</h3><p>{preview ? `This invitation is for ${preview.email}.` : previewError} {accountEmail ? `You’re signed in as ${accountEmail}.` : ''}</p><Button size="sm" onClick={() => void switchAccount()}>Switch account</Button></div></div> : null}
      {inviteState === 'ready' && preview ? <>
        <div className="pc-join-summary"><div className="pc-join-mark"><Users size={18} /></div><div><span>PROJECT INVITATION</span><strong>{preview.projectName}</strong><small>Invited as {preview.email}{preview.expiresAt ? ` · expires ${new Date(preview.expiresAt).toLocaleDateString()}` : ''}</small></div><Badge tone="ok">Verified</Badge></div>
        {accountEmail && !emailMatches ? <div className="pc-inline-note pc-inline-note--warning" role="alert">This account does not match the invitation email. Switch to {preview.email} before continuing.</div> : null}
        {eligibleProviders.length === 0 ? <div className="pc-state-card pc-state-card--setup"><CircleAlert size={19} /><div><h3>Provider setup needed</h3><p>Set up Codex, Claude Code or OpenCode on this device. Mingle only offers a provider, model and Supervised policy actually reported by its local catalog.</p><Button size="sm" onClick={onOpenProviderSettings}>Open provider settings</Button></div></div> : <div className="pc-join-form">
          <fieldset className="pc-section"><legend>1. Choose a local checkout</legend><p>This link won’t clone or open files automatically. Pick a local project or explicitly create a checkout below.</p>
            {projects.filter((project) => !project.isExample).length ? <div className="pc-project-choices" role="radiogroup" aria-label="Local project">
              {projects.filter((project) => !project.isExample).map((project) => <button type="button" role="radio" aria-checked={selectedProjectId === project.id} className={`pc-project-choice${selectedProjectId === project.id ? ' is-selected' : ''}`} key={project.id} onClick={() => chooseExistingProject(project.id)}><FolderOpen size={15} /><span><strong>{project.name}</strong><small>{project.path}</small></span>{selectedProjectId === project.id ? <Check size={15} /> : null}</button>)}
            </div> : <p className="pc-empty">No local projects are registered on this device yet.</p>}
            <div className="pc-source-tabs" role="group" aria-label="Add a local checkout">
              <button type="button" aria-pressed={source === 'folder'} onClick={() => { setSource('folder'); setError(null); }}>Use existing folder</button>
              {preview.repositoryUrl ? <button type="button" aria-pressed={source === 'clone'} onClick={() => { setSource('clone'); setError(null); }}>Clone repository</button> : null}
            </div>
            {source === 'folder' ? <form className="pc-workspace-form" onSubmit={(event) => void addExistingFolder(event)}><label className="pc-field"><span>Existing folder path</span><input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="/path/to/project" autoComplete="off" spellCheck={false} /></label><Button type="submit" size="sm" disabled={!folderPath.trim() || workspaceBusy} busy={workspaceBusy}>Choose folder</Button></form> : null}
            {source === 'clone' && preview.repositoryUrl ? <form className="pc-workspace-form" onSubmit={(event) => void cloneRepository(event)}><label className="pc-field"><span>Clone into parent folder</span><input value={parentPath} onChange={(event) => setParentPath(event.target.value)} placeholder="/path/to/projects" autoComplete="off" spellCheck={false} /></label><Button type="submit" size="sm" disabled={!parentPath.trim() || workspaceBusy} busy={workspaceBusy}>Clone checkout</Button><small className="pc-workspace-note">{preview.repositoryUrl} · cloning happens only after you choose a destination and confirm.</small></form> : null}
          </fieldset>
          <fieldset className="pc-section"><legend>2. Choose your first agent</legend><p>This creates one session after you join. It uses your local provider login and starts no model run.</p>
            <div className="pc-agent-config">
              <label className="pc-field"><span>Provider</span><select value={providerId} onChange={(event) => { const next = event.target.value as Provider; const nextInfo = selectedProviderInfo(eligibleProviders, next); const nextModel = supervisedModels(nextInfo)[0]; const nextEfforts = nextInfo && nextModel ? reasoningChoices(nextInfo, nextModel) : []; setProviderId(next); setModelId(nextModel?.id ?? ''); setEffortId(nextEfforts.find((item) => item.id === nextModel?.defaultReasoningEffort)?.id ?? nextEfforts[0]?.id ?? ''); }}>
                {eligibleProviders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
              <label className="pc-field"><span>Model</span><select value={selectedModel?.id ?? ''} onChange={(event) => { const next = models.find((item) => item.id === event.target.value); const nextEfforts = currentProvider && next ? reasoningChoices(currentProvider, next) : []; setModelId(next?.id ?? ''); setEffortId(nextEfforts.find((item) => item.id === next?.defaultReasoningEffort)?.id ?? nextEfforts[0]?.id ?? ''); }}>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="pc-field"><span>Reasoning effort</span><select value={effortId} onChange={(event) => setEffortId(event.target.value)}>{efforts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            </div>
            {selectedModel && !selectedModel.reasoningEfforts ? <small className="pc-workspace-note">This model did not report effort choices; these are Mingle’s documented local runtime defaults.</small> : null}
            <div className="pc-policy-note"><Check size={13} /> Supervised · asks before actions that change files or run commands</div>
          </fieldset>
          {error ? <InlineError>{error}</InlineError> : null}
          <div className="pc-join-actions"><span>{!emailMatches ? `Sign in as ${preview.email} to continue.` : !selectedProject ? 'Choose a local checkout to continue.' : 'No provider work starts until you send a message.'}</span><Button type="button" variant="primary" disabled={!canJoin} busy={joining} onClick={() => void joinProject()}>Join project</Button></div>
        </div>}
      </> : null}
      {joined ? <div className="pc-state-card pc-state-card--success"><Check size={19} /><div><h3>You’re in</h3><p>Your first local session is ready. Nothing has been sent to the agent yet.</p><Button variant="primary" size="sm" onClick={onClose}>Open project</Button></div></div> : null}
      {error && inviteState !== 'ready' ? <InlineError>{error}</InlineError> : null}
    </div>
  </Modal>;
}

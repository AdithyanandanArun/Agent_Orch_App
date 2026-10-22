/** Thin, local-runtime HTTP client for the distributed workspace routes. */
export type DistributedRecord = Record<string, unknown>;

export interface DistributedSnapshot extends DistributedRecord {
  teams?: unknown;
  transport?: unknown;
  execution?: unknown;
  git?: unknown;
  commands?: unknown;
}

export interface DecideExecutionInput {
  requestId: string;
  decision: 'approved' | 'denied';
  shareProgress: boolean;
  expectedDigest: string;
  allowProviderSpend: boolean;
  allowUnverifiedQuota: boolean;
}
export type ExecutionDecisionBody = Omit<DecideExecutionInput, 'requestId'>;
export interface RequestDecisionBody { decision: 'approved' | 'denied'; expectedDigest: string }

export interface RequestDelegationInput {
  teamId: string;
  sharedProjectId: string;
  sourceSessionId: string;
  taskId: string;
  agentId: string;
  mode: 'provider-failure' | 'unpublished-recovery';
  content: string;
  idempotencyKey: string;
}

export interface SendRemoteMessageInput {
  teamId: string;
  sharedProjectId: string;
  content: string;
  idempotencyKey: string;
  agentId?: string;
  groupId?: string;
  taskId?: string;
  dependsOn?: string[];
}

export interface GitTransferInput {
  idempotencyKey?: string;
  teamId: string;
  sharedProjectId: string;
  toDeviceId: string;
  expectedHead: string;
  baseHead?: string;
  branch?: string;
}

export interface GitIntegrationInput {
  idempotencyKey?: string;
  teamId: string;
  sharedProjectId: string;
  incomingRequestId: string;
  action: 'merge' | 'push';
  expectedHead: string;
  expectedFingerprint: string;
  remoteName?: string;
}

export type RemoteCommandOperation =
  | { kind: 'git.version' }
  | { kind: 'git.status' }
  | { kind: 'git.head' }
  | { kind: 'git.branch' }
  | { kind: 'git.log'; limit: number }
  | { kind: 'git.showStat'; commit: string }
  | { kind: 'git.diffStat'; base: string; head: string };

export interface RemoteCommandInput {
  idempotencyKey?: string;
  teamId: string;
  sharedProjectId: string;
  toDeviceId: string;
  operation: RemoteCommandOperation;
  cwd: string;
}

export class DistributedApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'DistributedApiError';
    this.status = status;
  }
}

async function call<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new DistributedApiError('Cannot reach the local runtime. Check that Mingle is still running.', 0);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = '';
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string') message = parsed.error;
    } catch { /* use a short plain-text server error when available */ }
    if (!message && text && text.length < 300 && !text.trimStart().startsWith('<')) message = text.trim();
    if (!message) message = response.status >= 500 ? 'The distributed service could not complete this request.' : `Request failed with status ${response.status}.`;
    throw new DistributedApiError(message, response.status);
  }
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { throw new DistributedApiError('The distributed service returned an unreadable response.', response.status); }
}

const base = '/api/distributed';
const idPath = (path: string, id: string) => `${base}/${path}/${encodeURIComponent(id)}`;

/**
 * Route and request body names follow docs/distributed-implementation-plan.md.
 * Snapshot responses are intentionally treated as optional records while the
 * server service return interfaces are integrated by the orchestrator.
 */
export const distributedApi = {
  snapshot: (teamId?: string, signal?: AbortSignal) => {
    const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
    return call<DistributedSnapshot>(`${base}/snapshot${query}`, 'GET', undefined, signal);
  },
  createTeam: (name: string) => call<unknown>(`${base}/teams`, 'POST', { name }),
  invite: (input: { teamId: string; email: string; role: string }) => call<unknown>(`${base}/invitations`, 'POST', input),
  acceptInvite: (token: string) => call<unknown>(`${base}/invitations/accept`, 'POST', { token }),
  revokeMember: (input: { teamId: string; userId: string }) => call<unknown>(`${base}/members/revoke`, 'POST', input),
  createProject: (input: { teamId: string; name: string; repositoryUrl?: string }) => call<unknown>(`${base}/projects`, 'POST', input),
  registerDevice: (input: { teamId: string; name: string }) => call<unknown>(`${base}/devices/register`, 'POST', input),
  linkDevice: (input: { teamId: string; deviceId: string; fingerprint: string }) => call<unknown>(`${base}/devices/link`, 'POST', input),
  revokeDevice: (input: { teamId: string; deviceId: string }) => call<unknown>(`${base}/devices/revoke`, 'POST', input),
  sync: () => call<unknown>(`${base}/sync`, 'POST', {}),
  bindProject: (input: { teamId: string; sharedProjectId: string; localProjectId: string }) => call<unknown>(`${base}/projects/bind`, 'POST', input),
  publishAgents: (input: { teamId: string; sharedProjectId: string; sessionIds: string[] }) => call<unknown>(`${base}/agents/publish`, 'POST', input),
  delegation: (input: RequestDelegationInput) => call<unknown>(`${base}/delegations`, 'POST', input),
  suggestFallback: (input: { teamId: string; sharedProjectId: string; sourceSessionId: string; taskId: string }) => call<unknown>(`${base}/fallbacks/suggest`, 'POST', input),
  decideExecution: (id: string, input: ExecutionDecisionBody) => call<unknown>(idPath('approvals', id), 'POST', input),
  sendMessage: (input: SendRemoteMessageInput) => call<unknown>(`${base}/messages`, 'POST', input),
  requestGit: (input: GitTransferInput) => call<unknown>(`${base}/git/request`, 'POST', input),
  integrateGit: (input: GitIntegrationInput) => call<unknown>(`${base}/git/integrate`, 'POST', input),
  decideGit: (id: string, input: RequestDecisionBody) => call<unknown>(`${base}/git/${encodeURIComponent(id)}/decision`, 'POST', input),
  requestCommand: (input: RemoteCommandInput) => call<unknown>(`${base}/commands/request`, 'POST', input),
  decideCommand: (id: string, input: RequestDecisionBody) => call<unknown>(`${base}/commands/${encodeURIComponent(id)}/decision`, 'POST', input),
};

export function createIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function resultRecord(value: unknown): DistributedRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DistributedRecord : {};
}

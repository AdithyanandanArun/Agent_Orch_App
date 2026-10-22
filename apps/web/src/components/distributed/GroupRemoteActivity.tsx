import { useEffect, useState } from 'react';
import type { RemoteAgent, RemoteCollaborationMessage, RemoteCollaborationTask, RemoteExecutionRequest } from '@mingle/contracts';
import { useMingle } from '../../store/store';
import { Button } from '../ui';
import '../../styles/distributed.css';

interface GroupRemoteState { agents: RemoteAgent[]; messages: RemoteCollaborationMessage[]; tasks: RemoteCollaborationTask[]; requests: RemoteExecutionRequest[] }

/** Remote recoveries remain part of their source group, with authenticated device attribution. */
export function GroupRemoteActivity({ groupId }: { groupId: string }) {
  const [state, setState] = useState<GroupRemoteState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setState(null);
    setError(null);
    let closed = false;
    let pending: AbortController | null = null;
    const refresh = async () => {
      if (pending || closed || document.visibilityState !== 'visible') return;
      const controller = new AbortController();
      pending = controller;
      try {
        const response = await fetch(`/api/distributed/groups/${encodeURIComponent(groupId)}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Remote group activity could not be loaded. Check the account and linked devices in Team workspace.');
        const next = await response.json() as GroupRemoteState;
        if (!closed) { setState(next); setError(null); }
      } catch (cause) {
        if (!closed && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Remote activity unavailable.');
      } finally { if (pending === controller) pending = null; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => { closed = true; window.clearInterval(timer); pending?.abort(); };
  }, [groupId]);
  if (!state?.requests.length && !state?.messages.length && !error) return null;
  return <details className="group-remote-activity" open>
    <summary>Shared remote recovery{state ? ` · ${state.requests.length} request${state.requests.length === 1 ? '' : 's'}` : ''}</summary>
    {error ? <p role="status">{error}</p> : null}
    {state?.requests.map((request) => {
      const agent = state.agents.find((agent) => agent.id === request.agentId);
      return <article key={request.id}><strong>{agent?.name ?? 'Shared agent'} · {agent?.provider ?? 'provider not reported'} / {agent?.model ?? 'model not reported'}</strong><p>{request.task?.title ?? 'Recovery request'} · {request.state}</p><small>Device {request.targetDeviceId} · owner {request.targetOwnerId}. Execution and provider quota require that device owner’s approval.</small></article>;
    })}
    {state?.messages.map((message) => <article key={message.id}><small>{message.kind} · device {message.deviceId} · {new Date(message.createdAt).toLocaleTimeString()}</small><p>{message.content}</p></article>)}
    <Button size="sm" onClick={() => useMingle.getState().openSettings({ section: 'team' })}>Open Team workspace</Button>
  </details>;
}

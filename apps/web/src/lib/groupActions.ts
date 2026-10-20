import type { GroupSnapshot } from '@mingle/contracts';
import { useRelay } from '../store/store';
import { api, errorMessage } from './api';

async function settle(action: () => Promise<GroupSnapshot>): Promise<boolean> {
  const store = useRelay.getState();
  try {
    store.applyGroup(await action());
    void store.refreshNow();
    return true;
  } catch (cause) {
    store.toast('error', errorMessage(cause));
    void store.refreshNow();
    return false;
  }
}

export const pauseGroup = (id: string): Promise<boolean> => settle(() => api.pauseGroup(id));
export const resumeGroup = (id: string): Promise<boolean> => settle(() => api.resumeGroup(id));
export const interruptMember = (groupId: string, memberId: string): Promise<boolean> => settle(() => api.interruptGroupMember(groupId, memberId));
export const removeMember = (groupId: string, memberId: string): Promise<boolean> => settle(() => api.removeGroupMember(groupId, memberId));

/** The server pauses dispatch and interrupts all members atomically. Queued work needs explicit Resume. */
export async function stopGroup(snapshot: GroupSnapshot): Promise<void> {
  if (await settle(() => api.stopGroup(snapshot.group.id))) {
    useRelay.getState().toast('info', 'Group stopped and paused. Resume explicitly to continue queued work.');
  }
}
export const resumeMember = (groupId: string, memberId: string): Promise<boolean> => settle(() => api.resumeGroupMember(groupId, memberId));

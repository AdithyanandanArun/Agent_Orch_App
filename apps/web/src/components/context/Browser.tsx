import { Globe } from 'lucide-react';
import { useActiveSession } from '../../store/store';
import { EmptyState } from '../ui';
import { BrowserPane } from '../browser/BrowserPane';

/** The shared browser of the active session. It polls and streams only while this tab is on screen. */
export function Browser({ active }: { active: boolean }) {
  const session = useActiveSession();
  if (!session) return <EmptyState icon={<Globe size={20} />} title="No session selected">Select a session to see and share its browser.</EmptyState>;
  return <BrowserPane key={session.id} session={session} active={active} />;
}

import { useMingle } from '../../store/store';
import { dockBrowserPopout } from './desktopBridge';
import { BrowserPane } from './BrowserPane';
import { Button } from '../ui';

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Browser-only shell loaded by Electron for a single validated Mingle session. */
export function BrowserPopout({ sessionId }: { sessionId: string }) {
  const session = useMingle((state) => SESSION_ID.test(sessionId) ? state.boot?.sessions.find((item) => item.id === sessionId) : undefined);
  return (
    <main className="browser-popout-shell" aria-label="Mingle browser window">
      {session ? <BrowserPane key={session.id} session={session} active popout /> : (
        <div className="browser-detached" role="status">
          <strong>This session is not available.</strong>
          <span>Return this window to Mingle to continue.</span>
          <Button size="sm" onClick={() => void dockBrowserPopout()}>Dock to Mingle</Button>
        </div>
      )}
    </main>
  );
}

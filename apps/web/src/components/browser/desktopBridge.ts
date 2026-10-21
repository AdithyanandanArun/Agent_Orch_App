export interface BrowserDesktopBridge {
  openPopout(sessionId: string): Promise<boolean>;
  isPopoutOpen(sessionId: string): Promise<boolean>;
  focusPopout(sessionId: string): Promise<boolean>;
  dockPopout(sessionId?: string): Promise<boolean>;
  onPopoutClosed(listener: (sessionId: string) => void): () => void;
}

declare global {
  interface Window { mingleBrowserDesktop?: BrowserDesktopBridge }
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function canOpenBrowserPopout(): boolean {
  return typeof window !== 'undefined' && Boolean(window.mingleBrowserDesktop);
}

export async function openBrowserPopout(sessionId: string): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false;
  return window.mingleBrowserDesktop?.openPopout(sessionId) ?? false;
}

export async function isBrowserPopoutOpen(sessionId: string): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false;
  return window.mingleBrowserDesktop?.isPopoutOpen(sessionId) ?? false;
}

export async function focusBrowserPopout(sessionId: string): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false;
  return window.mingleBrowserDesktop?.focusPopout(sessionId) ?? false;
}

export async function dockBrowserPopout(sessionId?: string): Promise<boolean> {
  if (sessionId !== undefined && !SESSION_ID.test(sessionId)) return false;
  return window.mingleBrowserDesktop?.dockPopout(sessionId) ?? false;
}

export function onBrowserPopoutClosed(listener: (sessionId: string) => void): () => void {
  return window.mingleBrowserDesktop?.onPopoutClosed(listener) ?? (() => undefined);
}

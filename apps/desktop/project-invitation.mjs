const INVITATION_PREFIX = 'mingle://join?token=';
const INVITATION_PATTERN = /^mingle:\/\/join\?token=([A-Za-z0-9_-]{32,512})(?![\s\S])/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
export const MAX_PENDING_PROJECT_INVITATIONS = 16;

function isCanonicalBase64UrlToken(token) {
  return typeof token === 'string'
    && token.length >= 32
    && token.length <= 512
    && token.length % 4 !== 1
    && /^[A-Za-z0-9_-]+$/.test(token)
    && Buffer.from(token, 'base64url').toString('base64url') === token;
}

/** Accepts only the documented, canonical invitation link shape. */
export function parseProjectInvitationUrl(value) {
  if (typeof value !== 'string' || value.length > INVITATION_PREFIX.length + 512 || CONTROL_CHARACTERS.test(value)) return null;
  const match = INVITATION_PATTERN.exec(value);
  return match && isCanonicalBase64UrlToken(match[1]) ? match[1] : null;
}

/** Builds a renderer handoff URL only for Mingle's local loopback workspace. */
export function createProjectInvitationUrl(workspaceUrl, token) {
  if (!isCanonicalBase64UrlToken(token) || typeof workspaceUrl !== 'string') return null;
  let workspace;
  try { workspace = new URL(workspaceUrl); } catch { return null; }
  if (workspace.protocol !== 'http:' || workspace.hostname !== '127.0.0.1' || workspace.username || workspace.password) return null;
  const target = new URL('/', workspace.origin);
  target.search = `?join=${encodeURIComponent(token)}`;
  return target.href;
}

/**
 * Holds valid links until the local workspace window is ready, then navigates
 * serially. Callbacks keep Electron/OS APIs out of parser and dispatch tests.
 */
export function createProjectInvitationDispatcher({ getWorkspaceUrl, getWindow, focusWindow, navigate }) {
  let ready = false;
  let dispatching = false;
  const pending = [];

  async function drain() {
    if (!ready || dispatching || pending.length === 0) return;
    const window = getWindow();
    if (!window) return;

    const token = pending.shift();
    const targetUrl = createProjectInvitationUrl(getWorkspaceUrl(), token);
    if (!targetUrl) {
      void drain();
      return;
    }

    dispatching = true;
    try {
      focusWindow(window);
      await navigate(window, targetUrl);
    } catch { /* A failed navigation must not expose invitation data in logs. */ }
    finally {
      dispatching = false;
      void drain();
    }
  }

  return Object.freeze({
    accept(value) {
      const token = parseProjectInvitationUrl(value);
      if (!token || pending.length + Number(dispatching) >= MAX_PENDING_PROJECT_INVITATIONS) return false;
      pending.push(token);
      const window = getWindow();
      if (window) {
        try { focusWindow(window); } catch { /* Focus is best-effort. */ }
      }
      void drain();
      return true;
    },
    markWorkspaceReady() {
      ready = true;
      void drain();
    },
    getPendingCount() { return pending.length + Number(dispatching); },
  });
}

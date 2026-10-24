/** Invitation tokens remain in memory; the landing page makes no network calls. */
export function appLinkFromFragment(fragment) {
  if (typeof fragment !== 'string' || fragment.length > 1024 || !fragment.startsWith('#')) return null;
  const fields = new URLSearchParams(fragment.slice(1));
  const entries = [...fields.entries()];
  if (entries.length !== 1 || entries[0][0] !== 'token') return null;
  const token = entries[0][1];
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return null;
  return `mingle://join?token=${encodeURIComponent(token)}`;
}

if (typeof document !== 'undefined') {
  let appLink;
  const status = document.getElementById('status');
  const actions = document.getElementById('actions');
  const open = document.getElementById('open-mingle');
  const copy = document.getElementById('copy-link');
  function consumeInvitation() {
    appLink = appLinkFromFragment(window.location.hash);
    // Remove the bearer token before any user navigation or clipboard interaction.
    window.history.replaceState(null, '', window.location.pathname);
    actions.hidden = !appLink;
    open.removeAttribute('href');
    if (!appLink) {
      document.getElementById('description').textContent = 'This page needs a valid project invitation. Open the complete link from your invitation email, or ask the project lead for a new invitation.';
      status.textContent = 'No valid invitation link was found.';
    } else {
      document.getElementById('description').textContent = 'Open your invitation in Mingle to sign in, choose your project folder and add your first agent.';
      open.href = appLink;
      actions.hidden = false;
      status.textContent = 'Your identity and invitation will be checked inside Mingle.';
    }
  }
  consumeInvitation();
  window.addEventListener('hashchange', consumeInvitation);
  open.addEventListener('click', () => { status.textContent = 'Allow your browser to open Mingle. If it is not installed, download it below and reopen your invitation.'; });
  copy.addEventListener('click', async () => {
    if (!appLink) return;
    const copiedLink = appLink;
    try {
      await navigator.clipboard.writeText(copiedLink);
      if (appLink !== copiedLink) return;
      status.textContent = 'App link copied. Keep it private and open it on the computer running Mingle.';
    } catch {
      status.textContent = 'The browser could not copy the link. Use Open Mingle instead.';
    }
  });
}

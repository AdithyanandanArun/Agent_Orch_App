import type { BrowserSnapshot } from '@mingle/contracts';
import { refreshViewport } from './actions.ts';
import { BrowserError, withTimeout } from './errors.ts';
import { isEligibleTabUrl } from './url-policy.ts';
import { ACTION_TIMEOUT_MS, MAX_SCREENSHOT_WIDTH, MAX_TEXT_CHARS } from './limits.ts';
import { scopeRefs } from './refs.ts';
import type { TabEntry } from './tab.ts';

type SnapshotBody = Omit<BrowserSnapshot, 'tab'>;

/** Names that usually mark secrets even when a field is not a textbox (a custom widget, an input given another role). */
const SENSITIVE_NAME = /pass(?:word|code|phrase)|\bpin\b|\bcvv\b|\bcvc\b|security code|one-time|\botp\b|\bsecret\b/iu;
const FIELD_LINE = /^(\s*)- ([a-z]+)((?: "(?:[^"\\]|\\.)*")?)((?:\s*\[[^\]]*\])*)\s*(:.*)?$/u;
const TEXT_ROLES = new Set(['textbox', 'searchbox']);

function clip(text: string, max: number): { text: string; truncated: boolean } {
  const marker = '\n… [truncated]';
  return text.length > max ? { text: `${text.slice(0, max - marker.length)}${marker}`, truncated: true } : { text, truncated: false };
}

/**
 * Hides the value payload of every textbox (the label, ref and attributes stay, so the agent can still find and fill
 * the field). Redacting all of them is deliberate: a password input is a textbox too, with or without an accessible
 * name, in any frame, and no per-field probing is needed. Any other role whose name looks like a secret is hidden as well.
 */
export function redactFieldValues(aria: string): string {
  const lines = aria.split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = FIELD_LINE.exec(line);
    if (!match) {
      // An unexpected textbox layout must not leak its value: keep only the role and ref.
      const odd = /^(\s*)- (textbox|searchbox)\b/u.exec(line);
      if (!odd) { out.push(line); continue; }
      const ref = /\[ref=[A-Za-z0-9_-]+\]/u.exec(line)?.[0];
      out.push(`${odd[1]}- ${odd[2]}${ref ? ` ${ref}` : ''}: [hidden]`);
      while (index + 1 < lines.length && /^\s/u.test(lines[index + 1]!) && lines[index + 1]!.search(/\S/u) > odd[1]!.length) index++;
      continue;
    }
    const [, indent = '', role = '', name = '', attrs = '', value] = match;
    if (value === undefined || !(TEXT_ROLES.has(role) || SENSITIVE_NAME.test(name))) { out.push(line); continue; }
    out.push(`${indent}- ${role}${name}${attrs}: [hidden]`);
    // A value rendered as nested children ends the line with a bare colon; drop those deeper lines too.
    if (value.trim() === ':') while (index + 1 < lines.length && /^\s/u.test(lines[index + 1]!) && lines[index + 1]!.search(/\S/u) > indent.length) index++;
  }
  return out.join('\n');
}

async function visibleText(entry: TabEntry): Promise<string> {
  // innerText returns rendered text only: it never includes the values of form fields.
  const text = await withTimeout(
    entry.page.evaluate((max: number) => {
      const scope = globalThis as unknown as { document?: { body?: { innerText?: string } } };
      return (scope.document?.body?.innerText ?? '').slice(0, max + 1);
    }, MAX_TEXT_CHARS),
    ACTION_TIMEOUT_MS,
    'Reading the page text timed out.',
  );
  return text;
}

async function screenshot(entry: TabEntry): Promise<NonNullable<BrowserSnapshot['screenshot']>> {
  await refreshViewport(entry);
  const { width, height } = entry.viewport;
  if (width <= MAX_SCREENSHOT_WIDTH) {
    const png = await entry.page.screenshot({ type: 'png', scale: 'css', timeout: ACTION_TIMEOUT_MS });
    return { data: png.toString('base64'), mimeType: 'image/png' };
  }
  // Wider than the cap: have Chromium downscale instead of shipping a huge PNG.
  const session = await entry.page.context().newCDPSession(entry.page);
  try {
    const shot = await withTimeout(
      session.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: MAX_SCREENSHOT_WIDTH / width }, captureBeyondViewport: false }),
      ACTION_TIMEOUT_MS,
      'Taking the screenshot timed out.',
    );
    return { data: shot.data, mimeType: 'image/png' };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/**
 * Public-page snapshot: accessibility tree with refs scoped to this tab and snapshot, visible text and an optional
 * bounded PNG. Textbox values are redacted before anything leaves this function.
 */
export function captureSnapshot(entry: TabEntry, includeImage: boolean): Promise<SnapshotBody> {
  return entry.serializeSnapshot(async () => {
    const snapshot = ++entry.snapshotCounter;
    const navigation = entry.navigationVersion;
    // Native refs are replaced by the new snapshot, so the previous ones are unusable from this moment on.
    entry.liveSnapshot = null;
    if (entry.dialog) {
      const note = `The page is blocked by a JavaScript ${entry.dialog.type} dialog: "${entry.dialog.message}". Use the dialog action to accept or dismiss it before reading the page.`;
      return { accessibility: note, text: '', truncated: false };
    }
    const [aria, text] = await Promise.all([
      entry.page.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS }),
      visibleText(entry),
    ]);
    const accessibility = clip(scopeRefs(redactFieldValues(aria), entry.id, snapshot), MAX_TEXT_CHARS);
    const visible = clip(text, MAX_TEXT_CHARS);
    const body: SnapshotBody = { accessibility: accessibility.text, text: visible.text, truncated: accessibility.truncated || visible.truncated };
    if (includeImage) body.screenshot = await screenshot(entry);
    if (entry.page.isClosed() || navigation !== entry.navigationVersion || !isEligibleTabUrl(entry.page.url())) {
      throw new BrowserError(409, 'The page navigated while its snapshot was being captured. Take a fresh snapshot.');
    }
    entry.liveSnapshot = snapshot;
    return body;
  });
}

import type { BrowserSnapshot } from '@relay/contracts';
import { refreshViewport } from './actions.ts';
import { withTimeout } from './errors.ts';
import { ACTION_TIMEOUT_MS, MAX_SCREENSHOT_WIDTH, MAX_TEXT_CHARS } from './limits.ts';
import type { TabEntry } from './tab.ts';

type SnapshotBody = Omit<BrowserSnapshot, 'tab'>;

const MAX_FRAMES = 16;
const MAX_PASSWORD_FIELDS_PER_FRAME = 8;
/** Field names that usually hold secrets even when the input type is plain text. */
const SENSITIVE_NAME = /pass(?:word|code|phrase)|\bpin\b|\bcvv\b|\bcvc\b|security code|one-time|\botp\b|\bsecret\b/iu;
const TEXTBOX_LINE = /^(\s*)- textbox((?: "(?:[^"\\]|\\.)*")?)((?:\s*\[[^\]]*\])*)\s*(:.*)?$/u;
const REF_ATTR = /\[ref=([A-Za-z0-9_-]+)\]/gu;

function clip(text: string, max: number): { text: string; truncated: boolean } {
  const marker = '\n… [truncated]';
  return text.length > max ? { text: `${text.slice(0, max - marker.length)}${marker}`, truncated: true } : { text, truncated: false };
}

/**
 * Finds the snapshot refs of password inputs. Their accessible value would otherwise be printed in the tree, so the
 * refs are used only to hide it; the probe snapshot is discarded and values never leave this function.
 */
async function passwordRefs(entry: TabEntry): Promise<Set<string>> {
  const refs = new Set<string>();
  await Promise.all(entry.page.frames().slice(0, MAX_FRAMES).map(async (frame) => {
    const fields = frame.locator('input[type="password"]');
    const count = await withTimeout(fields.count(), 2000, 'Counting fields timed out.').catch(() => 0);
    for (let index = 0; index < Math.min(count, MAX_PASSWORD_FIELDS_PER_FRAME); index++) {
      const probe = await fields.nth(index).ariaSnapshot({ mode: 'ai', timeout: 2000 }).catch(() => '');
      for (const match of probe.matchAll(REF_ATTR)) refs.add(match[1]!);
    }
  }));
  return refs;
}

/** Replaces the value of password-like textboxes with a marker (value hidden, structure kept). */
export function redactSecretValues(aria: string, secretRefs: ReadonlySet<string>): string {
  const lines = aria.split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = TEXTBOX_LINE.exec(line);
    if (!match) { out.push(line); continue; }
    const [, indent = '', name = '', attrs = '', value] = match;
    const ref = /\[ref=([A-Za-z0-9_-]+)\]/u.exec(attrs)?.[1];
    const sensitive = (ref !== undefined && secretRefs.has(ref)) || SENSITIVE_NAME.test(name);
    if (!sensitive || value === undefined) { out.push(line); continue; }
    out.push(`${indent}- textbox${name}${attrs}: [hidden]`);
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

/** Public-page snapshot: accessibility tree with refs, visible text and an optional bounded PNG. */
export async function captureSnapshot(entry: TabEntry, includeImage: boolean): Promise<SnapshotBody> {
  if (entry.dialog) {
    const note = `The page is blocked by a JavaScript ${entry.dialog.type} dialog: "${entry.dialog.message}". Use the dialog action to accept or dismiss it before reading the page.`;
    return { accessibility: note, text: '', truncated: false };
  }
  const secrets = await passwordRefs(entry);
  const [aria, text] = await Promise.all([
    entry.page.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS }),
    visibleText(entry),
  ]);
  const accessibility = clip(redactSecretValues(aria, secrets), MAX_TEXT_CHARS);
  const visible = clip(text, MAX_TEXT_CHARS);
  const body: SnapshotBody = { accessibility: accessibility.text, text: visible.text, truncated: accessibility.truncated || visible.truncated };
  if (includeImage) body.screenshot = await screenshot(entry);
  return body;
}

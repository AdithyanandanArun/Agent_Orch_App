/**
 * Browser errors carry an HTTP-style status so routes can map them directly:
 * 400 invalid input, 403 policy or ownership, 404 unknown session/tab, 409 state conflict,
 * 422 the action itself failed in the page, 502 a page or debugging endpoint could not be reached, 503 the browser is unavailable.
 */
export class BrowserError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

/** First lines of a Playwright message without ANSI colours or the verbose "Call log:" section. */
export function cleanMessage(error: unknown, max = 600): string {
  const raw = error instanceof Error ? error.message || error.name : String(error);
  const text = raw.replace(ANSI, '').split(/\n\s*Call log:/u)[0]!.trim().replace(/\n{2,}/gu, '\n');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Turns arbitrary failures (Playwright, CDP, timeouts) into a BrowserError with actionable guidance. */
export function toBrowserError(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error;
  const message = cleanMessage(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || /Timeout \d+ms exceeded/u.test(message)) {
    return new BrowserError(422, `${message.split('\n')[0]} The element may be missing, hidden, disabled or covered. Take a fresh snapshot and retry.`);
  }
  const network = /net::(ERR_[A-Z_]+)/u.exec(message);
  if (network) return new BrowserError(502, `The page could not be loaded (${network[1]}). Check the address and the network connection.`);
  if (/strict mode violation/iu.test(message)) {
    return new BrowserError(422, 'The target matched more than one element. Use a more specific selector, a role with a name, or a ref from a fresh snapshot.');
  }
  if (/Target (?:page, context or browser|closed)|has been closed|Session closed|Connection closed/iu.test(message)) {
    return new BrowserError(404, 'The tab or browser was closed.');
  }
  if (/Execution context was destroyed|Cannot find context with specified id/iu.test(message)) {
    return new BrowserError(422, 'The page navigated while the action ran. Take a fresh snapshot and retry.');
  }
  return new BrowserError(422, message);
}

/** Rejects if `work` does not settle in time; the underlying promise keeps running but its failure is swallowed. */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  work.catch(() => undefined);
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BrowserError(422, message)), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

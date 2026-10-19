import { BrowserError, toBrowserError, withTimeout } from './errors.ts';
import { EVAL_DEADLINE_MS, EVAL_EXEC_TIMEOUT_MS, EVAL_PROBE_MS, EVAL_TERMINATE_WAIT_MS, MAX_EVAL_CHARS } from './limits.ts';
import type { CDPSession } from './playwright.ts';
import type { TabEntry } from './tab.ts';

/**
 * Page-side serializer, sent as source text to Runtime.callFunctionOn so no bundler transform touches it.
 * It walks the wrapped value with bounds on depth, visited values and string length before sending it to Node.
 * Slow getters remain subject to the evaluation deadline and termination handling.
 */
const SERIALIZER = `function (maxChars) {
  'use strict';
  var MAX_NODES = 4000, MAX_DEPTH = 8, MAX_STRING = 2000;
  var nodes = 0, cut = false, seen = [];
  function text(value) {
    if (value.length > MAX_STRING) { cut = true; return value.slice(0, MAX_STRING) + '…'; }
    return value;
  }
  function walk(value, depth) {
    if (++nodes > MAX_NODES) { cut = true; return '…'; }
    var kind = typeof value;
    if (value === null || kind === 'boolean') return value;
    if (kind === 'undefined') return '[undefined]';
    if (kind === 'string') return text(value);
    if (kind === 'number') return isFinite(value) ? value : String(value);
    if (kind === 'bigint') return String(value) + 'n';
    if (kind === 'symbol') return String(value);
    if (kind === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    if (seen.indexOf(value) >= 0) return '[Circular]';
    try {
      if (typeof value.nodeType === 'number' && typeof value.nodeName === 'string') {
        return '<' + value.nodeName.toLowerCase() + (value.id ? '#' + text(String(value.id)) : '') + '>';
      }
      if (value instanceof Error) return text(String(value.name) + ': ' + String(value.message));
      if (value instanceof Date) return isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
      if (value instanceof RegExp) return String(value);
      if (typeof ArrayBuffer !== 'undefined' && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return '[' + Object.prototype.toString.call(value).slice(8, -1) + ' ' + value.byteLength + ' bytes]';
      if (depth >= MAX_DEPTH) { cut = true; return '[' + (Array.isArray(value) ? 'Array' : 'Object') + ']'; }
      seen.push(value);
      var out;
      if (Array.isArray(value)) {
        out = [];
        for (var i = 0; i < value.length; i++) {
          if (nodes > MAX_NODES) { cut = true; out.push('…'); break; }
          out.push(walk(value[i], depth + 1));
        }
      } else if (typeof Map !== 'undefined' && value instanceof Map) {
        out = {};
        for (var pair of value) {
          if (nodes >= MAX_NODES) { cut = true; break; }
          out[text(String(pair[0]))] = walk(pair[1], depth + 1);
        }
      } else if (typeof Set !== 'undefined' && value instanceof Set) {
        out = [];
        for (var member of value) {
          if (nodes >= MAX_NODES) { cut = true; break; }
          out.push(walk(member, depth + 1));
        }
      } else {
        out = {};
        for (var key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (nodes >= MAX_NODES) { cut = true; out['…'] = '…'; break; }
          var item;
          try { item = value[key]; } catch (error) { item = '[Unreadable]'; }
          out[text(key)] = walk(item, depth + 1);
        }
      }
      seen.pop();
      return out;
    } catch (error) {
      return '[Unserializable]';
    }
  }
  if (this.failed) return { error: this.error };
  var json = JSON.stringify(walk(this.value, 0));
  if (json === undefined) json = String(this);
  if (json.length > maxChars) return { text: json.slice(0, maxChars), truncated: true };
  return { text: json, truncated: cut };
}`;

const EXPIRED = Symbol('expired');
const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

interface EvalOutput { result: string; truncated: boolean }

function describeException(details: { text: string; exception?: { description?: string; value?: unknown } | undefined }): string {
  const raw = details.exception?.description ?? (typeof details.exception?.value === 'string' ? details.exception.value : details.text);
  const first = raw.split('\n').slice(0, 4).join('\n');
  return first.length > 600 ? `${first.slice(0, 600)}…` : first;
}

async function runEvaluation(session: CDPSession, expression: string): Promise<EvalOutput> {
  try {
    // Always return an object handle. CDP returns primitive strings by value even with returnByValue:false;
    // wrapping prevents a large string result from crossing the transport before it can be bounded in the page.
    const source = expression.trim().replace(/;+$/u, '');
    const wrapped = `(async () => { try {
      let value = (${source});
      if (typeof value === 'function') value = value();
      return { value: await value };
    } catch (error) {
      let message; try { message = String(error && error.message !== undefined ? error.message : error).slice(0, 600); } catch { message = 'Unreadable error'; }
      return { failed: true, error: message };
    } })()`;
    const evaluated = await session.send('Runtime.evaluate', {
      expression: wrapped, awaitPromise: true, returnByValue: false, timeout: EVAL_EXEC_TIMEOUT_MS, objectGroup: 'relay-eval',
    });
    if (evaluated.exceptionDetails) throw new BrowserError(422, `The expression threw: ${describeException(evaluated.exceptionDetails)}`);
    const { result } = evaluated;
    if (!result.objectId) throw new BrowserError(422, 'The page did not return an evaluation handle.');
    const serialized = await session.send('Runtime.callFunctionOn', {
      objectId: result.objectId, functionDeclaration: SERIALIZER, arguments: [{ value: MAX_EVAL_CHARS }],
      returnByValue: true,
    });
    if (serialized.exceptionDetails) throw new BrowserError(422, `The result could not be read: ${describeException(serialized.exceptionDetails)}`);
    const value = serialized.result.value as { text?: unknown; truncated?: unknown; error?: unknown } | undefined;
    if (typeof value?.error === 'string') throw new BrowserError(422, `The expression threw: ${value.error}`);
    if (typeof value?.text !== 'string') throw new BrowserError(422, 'The result could not be read from the page.');
    return { result: value.text, truncated: value.truncated === true };
  } catch (error) {
    if (error instanceof Error && /Execution was terminated/iu.test(error.message)) {
      throw new BrowserError(422, `The expression kept the page busy for more than ${EVAL_EXEC_TIMEOUT_MS / 1000}s and was terminated. Avoid long synchronous loops.`);
    }
    throw toBrowserError(error);
  }
}

/** Gives up on an evaluation that outlived its deadline. Never closes the tab: it may be a person's own. */
async function abandon(session: CDPSession, run: Promise<unknown>): Promise<never> {
  const responsive = await withTimeout(session.send('Runtime.evaluate', { expression: '1' }), EVAL_PROBE_MS, 'probe timed out').then(() => true, () => false);
  if (responsive) {
    // The page is idle, so the script is only waiting on a promise. There is nothing to terminate, and work already
    // started by async callbacks cannot be undone; the evaluation is abandoned (the session detaches) and reported as failed.
    throw new BrowserError(422, `The expression did not finish within ${EVAL_DEADLINE_MS / 1000}s, so its result was discarded. A promise it started cannot be cancelled and may still complete in the page; take a snapshot to check the page before retrying.`);
  }
  // The main thread is stuck inside script. terminateExecution is only sent in this case because with an idle page it
  // would also doom the next script that runs.
  void session.send('Runtime.terminateExecution').catch(() => undefined);
  const settled = await Promise.race([run.then(() => true, () => true), delay(EVAL_TERMINATE_WAIT_MS).then(() => false)]);
  throw new BrowserError(422, settled
    ? 'The expression kept the page busy and was terminated. Avoid long synchronous loops.'
    : 'The expression is still blocking this tab and could not be stopped. Relay does not close tabs to cancel scripts; ask a person to reload or close the tab.');
}

/**
 * Runs a JavaScript expression (or function expression) in the page's main world through CDP Runtime.evaluate,
 * with V8's timeout for synchronous work, awaitPromise for promises and a bounded page-side serializer.
 * Runtime.callFunctionOn has no execution timeout, so serialization is covered by the overall deadline
 * and the probe/terminate fallback in `abandon`. Page JavaScript only; there is no access to Node.
 * Limits: a promise or timer the expression started cannot be cancelled once it has begun.
 */
export async function evaluateExpression(entry: TabEntry, expression: string): Promise<EvalOutput> {
  const pending = entry.page.context().newCDPSession(entry.page);
  const session = await withTimeout(pending, 5000, 'Could not attach to the tab to run the expression.').catch((error: unknown) => {
    // A session that arrives late must not stay attached to a tab that may belong to a person.
    void pending.then((late) => late.detach()).catch(() => undefined);
    throw toBrowserError(error);
  });
  try {
    const run = runEvaluation(session, expression);
    run.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<typeof EXPIRED>((resolve) => { timer = setTimeout(() => resolve(EXPIRED), EVAL_DEADLINE_MS); });
    const outcome = await Promise.race([run, expired]).finally(() => clearTimeout(timer));
    if (outcome !== EXPIRED) return outcome;
    return await abandon(session, run);
  } finally {
    await withTimeout(session.detach(), 2000, 'detach timed out').catch(() => undefined);
  }
}

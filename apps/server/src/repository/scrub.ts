import { redactSecrets } from '../util.ts';

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Removes URL userinfo, token shapes and control characters from tool output before it is logged, stored or shown. */
export function scrub(text: string, max = 800): string {
  let out = text.replace(ANSI, '').replace(CONTROL, '');
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, '$1***@');
  out = out.replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/g, '[redacted]');
  out = redactSecrets(out).trim();
  return out.length <= max ? out : `${out.slice(0, max)}…`;
}

/** First few meaningful lines of a failure, scrubbed and joined for a single-line message. */
export function failureSummary(text: string, lines = 4): string {
  return scrub(text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, lines).join(' '));
}

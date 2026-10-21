import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const unprocessable = (message: string) => new HttpError(422, message);

export type IdPrefix = 'prj' | 'ses' | 'msg' | 'tsk' | 'apr' | 'trm' | 'run' | 'tool' | 'cmp' | 'plan' | 'question';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export const nowIso = () => new Date().toISOString();

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{30,}/g,
  /ya29\.[A-Za-z0-9._~-]{16,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /(gh[pousr]_)[A-Za-z0-9]{20,}/g,
  /(api[_-]?key["'=:\s]+)[A-Za-z0-9._-]{16,}/gi,
];

/** Best-effort scrubbing of well-known credential shapes before text is persisted or logged. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    const value = process.env[key];
    if (value && value.length >= 8) out = out.split(value).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (_m, prefix) => `${typeof prefix === 'string' ? prefix : ''}[redacted]`);
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

export function slugify(text: string, max = 28): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
  return slug || 'session';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

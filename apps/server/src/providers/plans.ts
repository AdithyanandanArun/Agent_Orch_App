import { createHash } from 'node:crypto';
import type { ProviderTaskPlan } from '@mingle/contracts';
import { isRecord } from './common.js';

/** Title identities survive status updates and reordering; duplicate titles retain occurrence identities. */
export function nativePlanSteps(raw: unknown, titleKey: string): ProviderTaskPlan['steps'] | null {
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const seen = new Map<string, number>();
  const steps: ProviderTaskPlan['steps'] = [];
  for (const value of raw) {
    if (!isRecord(value) || typeof value[titleKey] !== 'string') return null;
    const fullTitle = (value[titleKey] as string).trim();
    const title = fullTitle.replace(/\s+/g, ' ').slice(0, 200);
    const status = value.status === 'inProgress' ? 'in_progress' : value.status;
    if (!title || !['pending', 'in_progress', 'completed', 'blocked'].includes(String(status))) return null;
    const digest = createHash('sha256').update(fullTitle.toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 24);
    const occurrence = (seen.get(digest) ?? 0) + 1;
    seen.set(digest, occurrence);
    steps.push({ id: `${digest}:${occurrence}`, title, ...(fullTitle.length > 200 ? { description: fullTitle.slice(0, 4000) } : {}), status: status as ProviderTaskPlan['steps'][number]['status'] });
  }
  return steps;
}

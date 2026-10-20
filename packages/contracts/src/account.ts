import { z } from 'zod';
import { ProviderSchema, EffortSchema } from './provider-config';

/** An explicit allowlist: permissions, credentials, machine paths and project data never sync. */
export const AccountPreferencesSchema = z.object({
  theme: z.enum(['dark', 'light']),
  defaultProvider: ProviderSchema,
  defaultCodexModel: z.string().trim().min(1).max(150),
  defaultClaudeModel: z.string().trim().min(1).max(150),
  defaultAntigravityModel: z.string().trim().min(1).max(150).optional(),
  defaultOpencodeModel: z.string().trim().min(1).max(150).optional(),
  defaultEffort: EffortSchema,
  autoCompactPercent: z.number().int().min(1).max(95).nullable(),
}).strict();
export type AccountPreferences = z.infer<typeof AccountPreferencesSchema>;
export interface SavedAccountPreferences { preferences: AccountPreferences; revision: number; updatedAt: string }

export const AccountConnectionSchema = z.object({
  url: z.string().url().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)));
    } catch { return false; }
  }, 'Use an HTTPS Supabase project URL, or a loopback URL for local development'),
  publishableKey: z.string().trim().regex(/^sb_publishable_[A-Za-z0-9_-]{10,}$/, 'Use a Supabase publishable key, never a secret or service-role key').max(4096),
}).strict();
export type AccountConnection = z.infer<typeof AccountConnectionSchema>;
export interface AccountState {
  configured: boolean;
  connection: AccountConnection | null;
  configurationSource: 'application' | 'environment' | 'device' | 'none';
  status: 'signed-out' | 'restoring' | 'signing-in' | 'signed-in';
  user: { id: string; email: string | null; name: string | null } | null;
  sessionStorage: 'os-encrypted' | 'memory';
  error: string | null;
  /** Only while the explicit sign-in attempt is active. Never persisted or logged. */
  authorizationUrl: string | null;
  browserError: string | null;
}
export const SaveAccountPreferencesSchema = z.object({
  preferences: AccountPreferencesSchema,
  expectedRevision: z.number().int().min(1).nullable(),
}).strict();

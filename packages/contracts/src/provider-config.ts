import { z } from 'zod';

export const ProviderSchema = z.enum(['codex', 'claude', 'antigravity', 'opencode']);
export type Provider = z.infer<typeof ProviderSchema>;
export const PolicySchema = z.enum(['supervised', 'balanced', 'auto', 'full-access']);
export type Policy = z.infer<typeof PolicySchema>;
// Harness model discovery advertises valid effort/tier identifiers; validate membership on the server.
export const EffortSchema = z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_-]*$/);
export type Effort = z.infer<typeof EffortSchema>;
export const ServiceTierSchema = z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_-]*$/);

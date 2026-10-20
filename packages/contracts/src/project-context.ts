import { z } from 'zod';
export type TaskOverride = 'title' | 'description' | 'acceptanceCriteria' | 'status' | 'sessionId' | 'dependsOn';
export interface TaskSource {
  kind: 'repository' | 'request' | 'provider' | 'github'; key: string;
  path?: string; line?: number; url?: string; runId?: string; providerId?: string; parentTaskId?: string;
  reportedStatus?: 'pending' | 'in_progress' | 'completed' | 'blocked'; missing?: boolean; overrides?: TaskOverride[];
}
export interface ProjectContext {
  projectId: string; status: 'indexing' | 'ready' | 'error'; scannedAt: string | null; root: string;
  isRepo: boolean; branch: string | null; head: string | null; fileCount: number;
  components: { id: string; name: string; path: string; kind: 'directory' | 'package' | 'config'; fileCount: number; dependencies: string[] }[];
  languages: { name: string; files: number }[];
  recentCommits: { sha: string; title: string; authoredAt: string }[];
  changedPaths: string[]; taskCount: number; notices: string[]; error: string | null;
}
export const ProviderTaskPlanSchema = z.object({
  planId: z.string().min(1).max(200), replace: z.boolean().optional(), explanation: z.string().max(4000).optional(),
  steps: z.array(z.object({ id: z.string().min(1).max(200), title: z.string().trim().min(1).max(200), description: z.string().max(4000).optional(), status: z.enum(['pending', 'in_progress', 'completed', 'blocked']), dependsOn: z.array(z.string().max(200)).max(100).optional() }).strict()).max(100),
}).strict();
export type ProviderTaskPlan = z.infer<typeof ProviderTaskPlanSchema>;

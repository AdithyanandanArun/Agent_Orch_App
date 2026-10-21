import { z } from 'zod';
import { ProviderSchema } from './provider-config';

export const PlanStepStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'blocked']);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

export const SessionPlanStatusSchema = z.enum(['review', 'approved', 'executing', 'completed', 'interrupted', 'failed']);
export type SessionPlanStatus = z.infer<typeof SessionPlanStatusSchema>;

export const SessionPlanStepSchema = z.object({
  id: z.string().min(1).max(200),
  providerId: z.string().max(200).nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(20),
  dependsOn: z.array(z.string().min(1).max(200)).max(100),
  status: PlanStepStatusSchema,
}).strict();
export type SessionPlanStep = z.infer<typeof SessionPlanStepSchema>;

export const SessionPlanStepsSchema = z.array(SessionPlanStepSchema).max(100).superRefine((steps, ctx) => {
  const indexes = new Map<string, number>();
  steps.forEach((step, index) => {
    const previous = indexes.get(step.id);
    if (previous !== undefined) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `Step ID duplicates step ${previous + 1}.` });
    else indexes.set(step.id, index);
  });

  const ids = new Set(indexes.keys());
  steps.forEach((step, index) => {
    const seen = new Set<string>();
    step.dependsOn.forEach((dependency, dependencyIndex) => {
      if (seen.has(dependency)) ctx.addIssue({ code: 'custom', path: [index, 'dependsOn', dependencyIndex], message: 'A dependency may only be listed once.' });
      seen.add(dependency);
      if (dependency === step.id) ctx.addIssue({ code: 'custom', path: [index, 'dependsOn', dependencyIndex], message: 'A step cannot depend on itself.' });
      else if (!ids.has(dependency)) ctx.addIssue({ code: 'custom', path: [index, 'dependsOn', dependencyIndex], message: 'A dependency must reference a step in this plan.' });
    });
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const step = steps[indexes.get(id) ?? -1];
    for (const dependency of step?.dependsOn ?? []) {
      if (dependency !== id && ids.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if ([...ids].some(visit)) ctx.addIssue({ code: 'custom', message: 'Step dependencies must not contain a cycle.' });
});

export const SessionPlanSchema = z.object({
  id: z.string().min(1).max(100), sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100),
  provider: ProviderSchema, providerPlanId: z.string().min(1).max(200), explanation: z.string().max(4000),
  steps: SessionPlanStepsSchema, revision: z.number().int().positive(), approvedRevision: z.number().int().positive().nullable(),
  status: SessionPlanStatusSchema, executionRunId: z.string().max(100).nullable(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export type SessionPlan = z.infer<typeof SessionPlanSchema>;

export const SessionPlanProposalSchema = z.object({
  providerPlanId: z.string().min(1).max(200),
  explanation: z.string().max(4000),
  steps: SessionPlanStepsSchema,
}).strict();
export type SessionPlanProposal = z.infer<typeof SessionPlanProposalSchema>;

export const EditSessionPlanSchema = z.object({
  expectedRevision: z.number().int().positive(),
  explanation: z.string().max(4000).optional(),
  steps: SessionPlanStepsSchema,
}).strict();
export type EditSessionPlan = z.infer<typeof EditSessionPlanSchema>;

export const UserInputOptionSchema = z.object({ label: z.string().trim().min(1).max(200), description: z.string().max(500).optional() }).strict();
export type UserInputOption = z.infer<typeof UserInputOptionSchema>;

export const UserInputFieldSchema = z.object({
  id: z.string().min(1).max(200), header: z.string().max(100).optional(), question: z.string().trim().min(1).max(2000),
  options: z.array(UserInputOptionSchema).max(20), multiSelect: z.boolean(), allowOther: z.boolean(), secret: z.boolean(),
}).strict();
export type UserInputField = z.infer<typeof UserInputFieldSchema>;

export const UserQuestionStatusSchema = z.enum(['pending', 'answered', 'cancelled']);
export type UserQuestionStatus = z.infer<typeof UserQuestionStatusSchema>;

export const UserQuestionSchema = z.object({
  id: z.string().min(1).max(100), sessionId: z.string().min(1).max(100), runId: z.string().min(1).max(100),
  provider: ProviderSchema, tool: z.string().min(1).max(200), questions: z.array(UserInputFieldSchema).min(1).max(10),
  status: UserQuestionStatusSchema, answers: z.record(z.string(), z.array(z.string().max(1000))).optional(),
  reason: z.string().max(500).optional(), createdAt: z.string(), resolvedAt: z.string().nullable(),
}).strict();
export type UserQuestion = z.infer<typeof UserQuestionSchema>;

/** Provider-neutral callback payload; nativeRequestId is persisted privately and never returned to renderers. */
export const NativeUserInputRequestSchema = z.object({
  nativeRequestId: z.string().min(1).max(300), tool: z.string().min(1).max(200), questions: z.array(UserInputFieldSchema).min(1).max(10),
}).strict();
export type NativeUserInputRequest = z.infer<typeof NativeUserInputRequestSchema>;
export type UserInputAnswers = Record<string, string[]>;

export const UserInputAnswersSchema = z.record(z.string().min(1).max(200), z.array(z.string().trim().min(1).max(1000)).min(1).max(20)).refine(
  (answers) => Object.keys(answers).length <= 10, 'Too many answers',
);

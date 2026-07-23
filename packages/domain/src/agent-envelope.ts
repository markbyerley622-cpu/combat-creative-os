import { z } from 'zod';

/**
 * The shared envelope every specialist agent is built on (architecture §6).
 * This file defines only the envelope shape — no specific agent's input/output
 * schema lives here yet; those land with each agent's implementation in a
 * later milestone.
 */

export const AgentValidationStatusSchema = z.enum([
  'VALID',
  'SCHEMA_INVALID',
  'NEEDS_HUMAN_REVIEW',
]);
export type AgentValidationStatus = z.infer<typeof AgentValidationStatusSchema>;

export const AgentInputContextSchema = z.object({
  campaignId: z.string().uuid(),
  priorArtifactRefs: z.array(z.string()).default([]),
  budgetRemainingCents: z.number().int().nonnegative(),
});
export type AgentInputContext = z.infer<typeof AgentInputContextSchema>;

export const AgentModelMetaSchema = z.object({
  model: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
});
export type AgentModelMeta = z.infer<typeof AgentModelMetaSchema>;

export interface AgentInput<T> {
  invocationId: string;
  workflowRunId: string;
  stage: string;
  promptVersion: string;
  input: T;
  context: AgentInputContext;
}

export interface AgentOutput<T> {
  invocationId: string;
  output: T | null;
  rationale?: string;
  modelMeta: AgentModelMeta;
  validationStatus: AgentValidationStatus;
}

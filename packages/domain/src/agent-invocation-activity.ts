import { z } from 'zod';
import { AgentInputAttachmentSchema, AgentInputContextSchema } from './agent-envelope';
import { CampaignStageSchema } from './workflow/campaign-stage';

/**
 * The Temporal Activity boundary contract for executing one specialist
 * agent (ADR-0004). Distinct from `@combat/agent-runtime`'s `AgentRun` (the
 * harness's own result shape) and `@combat/domain`'s illustrative
 * `AgentInput`/`AgentOutput` (architecture.md §6) — this is specifically
 * what a Temporal Activity accepts/returns, strict-Zod-validated so a
 * malformed workflow-to-activity call fails fast rather than reaching
 * `executeAgent` with an unvalidated shape.
 */

/**
 * Superset of `@combat/agent-runtime`'s `AgentFailureReason` — adds
 * `AGENT_NOT_FOUND` for a caller-supplied `agentName` that isn't in the
 * canonical registry at all (as opposed to `NOT_IMPLEMENTED`, which is a
 * registered-but-placeholder agent). Kept as a domain-level superset rather
 * than widening `agent-runtime`'s own union, since `AGENT_NOT_FOUND` can
 * only ever originate at the Activity boundary, before any `AgentDefinition`
 * exists to hand to `executeAgent`.
 */
export const AGENT_INVOCATION_FAILURE_REASONS = [
  'AGENT_NOT_FOUND',
  'NOT_IMPLEMENTED',
  'DISABLED',
  'INPUT_INVALID',
  'SCHEMA_INVALID',
  'PROVIDER_ERROR',
  'TIMEOUT',
  'BUDGET_EXCEEDED',
  'SELF_APPROVAL_FORBIDDEN',
] as const;
export const AgentInvocationFailureReasonSchema = z.enum(AGENT_INVOCATION_FAILURE_REASONS);
export type AgentInvocationFailureReason = z.infer<typeof AgentInvocationFailureReasonSchema>;

export const AgentInvocationFailureSchema = z.object({
  reason: AgentInvocationFailureReasonSchema,
  retryable: z.boolean(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type AgentInvocationFailure = z.infer<typeof AgentInvocationFailureSchema>;

/**
 * `budgetScope.shotId`, when present, is reserved for a future per-shot
 * budget check (the SHOT level of the four-level model, architecture.md
 * §4.3) — this milestone checks WORKSPACE/CAMPAIGN/PROVIDER only, matching
 * docs/domain-model.md §8's note that SHOT-level checks belong at
 * generation-dispatch granularity in a future `ShotGenerationWorkflow`
 * activity, not here.
 */
export const AgentBudgetScopeSchema = z
  .object({
    shotId: z.string().uuid().optional(),
  })
  .default({});
export type AgentBudgetScope = z.infer<typeof AgentBudgetScopeSchema>;

export const ExecuteSpecialistAgentInputSchema = z
  .object({
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    workflowRunId: z.string().min(1),
    stage: CampaignStageSchema,
    agentName: z.string().min(1),
    /** The prompt/definition version this invocation was authored against — recorded for audit, not enforced against the live registry (a live prompt upgrade is expected to be backward-compatible; see ADR-0004). */
    agentVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(1),
    payload: z.unknown(),
    context: AgentInputContextSchema,
    attachments: z.array(AgentInputAttachmentSchema).optional(),
    correlationId: z.string().min(1),
    causationId: z.string().min(1).optional(),
    budgetScope: AgentBudgetScopeSchema,
  })
  .refine((value) => value.context.campaignId === value.campaignId, {
    message: 'context.campaignId must match the top-level campaignId',
    path: ['context', 'campaignId'],
  });
export type ExecuteSpecialistAgentInput = z.infer<typeof ExecuteSpecialistAgentInputSchema>;

export const AgentInvocationModelMetaSchema = z.object({
  model: z.string(),
  promptVersion: z.number().int(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
});
export type AgentInvocationModelMeta = z.infer<typeof AgentInvocationModelMetaSchema>;

export const ExecuteSpecialistAgentOutputSchema = z.object({
  invocationId: z.string(),
  agentName: z.string(),
  agentVersion: z.number().int().nullable(),
  status: z.enum(['SUCCEEDED', 'FAILED']),
  result: z.unknown().nullable(),
  failure: AgentInvocationFailureSchema.nullable(),
  modelMeta: AgentInvocationModelMetaSchema.nullable(),
  costCents: z.number().int().nonnegative().nullable(),
  inputHash: z.string(),
  outputHash: z.string().nullable(),
  correlationId: z.string(),
  causationId: z.string().optional(),
  idempotencyKey: z.string(),
  attempt: z.number().int().positive(),
  startedAt: z.string(),
  completedAt: z.string(),
  /** True when this result was reconstructed from a previously-persisted `AgentInvocation` row rather than a fresh reasoning-provider call (idempotent Activity retry). */
  replayed: z.boolean(),
});
export type ExecuteSpecialistAgentOutput = z.infer<typeof ExecuteSpecialistAgentOutputSchema>;

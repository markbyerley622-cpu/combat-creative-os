import { z } from 'zod';

/**
 * Requirement 11: "Agent prompts must explicitly distinguish facts,
 * decisions, assumptions and recommendations." Every agent's prompt
 * instructs the model to fill this structure alongside its creative/
 * analytical result (see `agent-definition.ts`'s `buildEnvelopeSchema`), so
 * the distinction is enforced structurally rather than left to prose the
 * model may or may not follow.
 *
 * - `facts` — things taken directly from the input, not inferred.
 * - `decisions` — choices the agent made and is committing to in its output.
 * - `assumptions` — gaps in the input the agent filled in without being told,
 *   flagged so a human reviewer (or downstream agent) knows what to check.
 * - `recommendations` — suggestions for stages *after* this one that are not
 *   binding output, only advisory (never trusted structurally — see
 *   `rationale` on the historical AgentOutput envelope in
 *   packages/domain/src/agent-envelope.ts).
 */
export const ReasoningBreakdownSchema = z.object({
  facts: z.array(z.string().min(1)).default([]),
  decisions: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
  recommendations: z.array(z.string().min(1)).default([]),
});
export type ReasoningBreakdown = z.infer<typeof ReasoningBreakdownSchema>;

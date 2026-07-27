import { z } from 'zod';
import {
  CreativeDivergenceRecordSchema,
  CreativeMemoryContextSchema,
  LaunchConceptDirectiveSchema,
  LaunchConceptSchema,
  ProductLaunchBriefSchema,
} from '@combat/domain';

export const CreativeDirectorInputSchema = z.object({
  brandName: z.string().min(1),
  strategy: z.object({
    positioning: z.string().min(1),
    targetAudienceSummary: z.string().min(1),
    keyMessages: z.array(z.string().min(1)).min(1),
    toneGuidelines: z.array(z.string().min(1)).min(1),
  }),
  mandatories: z.array(z.string().min(1)).default([]),
  durationsSeconds: z.array(z.number().int().positive()).min(1),
  /**
   * M13: bounded, attributed insights from prior campaigns' performance —
   * each line carries its confidence band, evidence weight and source
   * `LearningRecord` id (see `formatLearningContext` in @combat/domain).
   * Advisory only: capped in count, never a substitute for the approved brief
   * or a human decision, and empty whenever no APPROVED, applicable,
   * sufficiently-evidenced learning exists.
   */
  priorLearnings: z.array(z.string().min(1)).default([]),
  /** Set only on a regeneration attempt following a CONCEPT-gate CHANGES_REQUESTED/REJECTED decision — the human reviewer's free-text comments, carried verbatim into this next attempt. */
  revisionFeedback: z.string().min(1).optional(),
  /** The requester's brief, verbatim. See `CampaignStrategistInputSchema` for why the summary is not a substitute. */
  campaignPrompt: z.string().min(1).max(8000).optional(),
  /** Binding product/event facts as `PRODUCT — …` / `EVENT — …` lines. */
  factualConstraints: z.array(z.string().min(1)).default([]),
  /** The product-launch brief, verbatim. See `CampaignStrategistInputSchema`. */
  productLaunch: ProductLaunchBriefSchema.optional(),
  /**
   * Which candidate of a competing set this invocation is producing, and which
   * structural positions the earlier candidates already took.
   *
   * Orchestration, not creative direction: the occupied positions are values
   * this agent itself emitted on earlier slots in the same run. Present only
   * alongside `productLaunch`, and the result must then carry `launchConcept`.
   */
  launchDirective: LaunchConceptDirectiveSchema.optional(),
  /**
   * Bounded, governed benchmark craft context for this role — attention
   * pattern, visual hierarchy, pacing philosophy, brand treatment. See
   * `CampaignStrategistInputSchema` for why it is optional and orchestrator-resolved.
   */
  creativeMemory: CreativeMemoryContextSchema.optional(),
});
export type CreativeDirectorInput = z.infer<typeof CreativeDirectorInputSchema>;

/**
 * Mirrors `@combat/domain`'s `CreativeConceptSchema` content fields, plus the
 * governance record this milestone requires. `creativeMemoryDivergence` is
 * deliberately *not* a concept content field: it is an audit artefact about how
 * the concept was reached, so it stays out of `CreativeConceptSchema` and is
 * persisted with the run's provenance instead.
 */
export const CreativeDirectorResultSchema = z.object({
  logline: z.string().min(1),
  visualDirection: z.string().min(1),
  narrativeArc: z.string().min(1),
  referenceNotes: z.array(z.string().min(1)).default([]),
  creativeMemoryDivergence: CreativeDivergenceRecordSchema.optional(),
  /**
   * The structured product-launch concept, returned when `launchDirective` was
   * supplied.
   *
   * Additive rather than a replacement: `logline`, `visualDirection` and
   * `narrativeArc` remain the fields the Script Director consumes, so a
   * selected launch concept flows into the existing planning chain unchanged
   * and every non-launch caller is untouched. What this adds is everything a
   * reviewer needs in order to *choose between* concepts, which the three
   * prose fields alone cannot carry.
   */
  launchConcept: LaunchConceptSchema.optional(),
});
export type CreativeDirectorResult = z.infer<typeof CreativeDirectorResultSchema>;

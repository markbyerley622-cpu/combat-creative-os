import { z } from 'zod';

/**
 * The 20 top-level campaign-production stages — the canonical lifecycle
 * (docs/adr/0002-campaign-lifecycle-alignment.md, docs/domain-model.md §4).
 * Performance analysis is deliberately **not** represented here: it is a
 * separate, independently-triggered `PerformanceAnalysisWorkflow` operating
 * on completed campaign/distribution records, so this workflow can complete
 * without waiting days or weeks for advertising results.
 */
export const CAMPAIGN_STAGES = [
  'DRAFT',
  'STRATEGY_REVIEW',
  'CONCEPT_REVIEW',
  'SCRIPT_REVIEW',
  'ASSET_COLLECTION',
  'PROMPTING',
  'SHOT_GENERATION',
  'VISUAL_QA',
  'CONTINUITY_QA',
  'HUMAN_SHOT_SELECTION',
  'COMPOSITING',
  'ROUGH_CUT',
  'SOUND_DESIGN',
  'FINAL_QA',
  'FINAL_APPROVAL',
  'VARIANT_GENERATION',
  'VARIANT_QA',
  'EXPORTING',
  'READY_FOR_DISTRIBUTION',
  'DISTRIBUTED',
] as const;

export const CampaignStageSchema = z.enum(CAMPAIGN_STAGES);
export type CampaignStage = z.infer<typeof CampaignStageSchema>;

import { z } from 'zod';

/**
 * The 17 top-level campaign production stages for this milestone. This is a
 * more granular decomposition than the illustrative stateDiagram in
 * docs/architecture.md §3.1 (which predates this schema work) — see
 * docs/domain-model.md and docs/architecture.md §7.1 item 8 for the mapping
 * and the note on why the two are not a line-for-line match.
 */
export const CAMPAIGN_STAGES = [
  'DRAFT',
  'STRATEGY_REVIEW',
  'CONCEPT_REVIEW',
  'SCRIPT_REVIEW',
  'ASSET_COLLECTION',
  'SHOT_GENERATION',
  'AUTOMATED_QA',
  'HUMAN_SHOT_SELECTION',
  'COMPOSITING',
  'ROUGH_CUT',
  'FINAL_QA',
  'FINAL_APPROVAL',
  'EXPORTING',
  'READY_FOR_DISTRIBUTION',
  'DISTRIBUTED',
  'PERFORMANCE_COLLECTION',
  'ITERATION_PLANNING',
] as const;

export const CampaignStageSchema = z.enum(CAMPAIGN_STAGES);
export type CampaignStage = z.infer<typeof CampaignStageSchema>;

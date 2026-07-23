import type { QualityFailureCategory } from '../schemas/shared-enums';
import type { CampaignStage } from './campaign-stage';

/**
 * Maps a typed QualityFailure category to the single campaign stage a
 * revision carrying that category routes to. Used by
 * `packages/database`'s transition-facts derivation for every stage with
 * more than one valid repair target (COMPOSITING, SOUND_DESIGN, FINAL_QA) —
 * see docs/domain-model.md §4.2 and
 * docs/adr/0002-campaign-lifecycle-alignment.md. Not every
 * `QualityFailureCategory` value drives routing (e.g. `PROMPT`/`GENERATION`
 * describe why a *shot generation* attempt failed and are consumed by the
 * bounded shot-retry facts instead, not by this map).
 */
export const QUALITY_FAILURE_ROUTING: Partial<Record<QualityFailureCategory, CampaignStage>> = {
  SHOT_UNUSABLE: 'HUMAN_SHOT_SELECTION',
  COMPOSITING_TECHNICAL: 'COMPOSITING',
  EDIT_TIMING: 'ROUGH_CUT',
  AUDIO_TECHNICAL: 'SOUND_DESIGN',
};

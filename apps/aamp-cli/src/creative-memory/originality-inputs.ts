import type { OriginalityEvaluationEntry } from '@combat/domain';

import type { CampaignPlan } from '../plan-campaign';

/**
 * Maps a finished plan onto what the originality evaluator reads.
 *
 * The selection of free text is deliberate, and two exclusions matter:
 *
 * - The **divergence record itself** is not fed in as output text. It is where
 *   an agent states what it avoided, so it necessarily quotes prohibitions —
 *   scanning it for imitation phrasing would flag exactly the compliance the
 *   prompt asks for. Its structured fields are read separately.
 * - The agent's **reasoning breakdown** is not included either. It is
 *   deliberation about the work, not the work, and the evaluator's job is to
 *   judge what a downstream stage will actually consume.
 *
 * Everything a later stage does consume — positioning, concept prose, shot
 * descriptions, generation prompts — is included in full.
 */
export function buildOriginalityEntries(plan: CampaignPlan): readonly OriginalityEvaluationEntry[] {
  const entries: OriginalityEvaluationEntry[] = [];
  const frameRate = 30;

  for (const record of plan.roleContexts) {
    const shared = {
      agentRole: record.agentRole,
      ...(record.context ? { context: record.context } : {}),
      ...(record.divergence ? { divergence: record.divergence } : {}),
    };

    switch (record.agentRole) {
      case 'CAMPAIGN_STRATEGIST':
        entries.push({
          ...shared,
          outputText: [
            plan.strategy.audienceProfile.name,
            ...plan.strategy.audienceProfile.painPoints,
            plan.strategy.strategy.positioning,
            plan.strategy.strategy.targetAudienceSummary,
            ...plan.strategy.strategy.keyMessages,
            ...plan.strategy.strategy.toneGuidelines,
          ],
        });
        break;
      case 'CREATIVE_DIRECTOR':
        entries.push({
          ...shared,
          outputText: [
            plan.concept.logline,
            plan.concept.visualDirection,
            plan.concept.narrativeArc,
            ...plan.concept.referenceNotes,
          ],
        });
        break;
      case 'SCRIPT_TIMING_DIRECTOR':
        entries.push({
          ...shared,
          outputText: plan.script.shots.map((shot) => shot.description),
          beatDurationsSeconds: plan.script.shots.map((shot) => shot.durationFrames / frameRate),
        });
        break;
      case 'SHOT_PROMPT_ENGINEER': {
        const brief = plan.shotBriefs.find(
          (_, index) => plan.shots[index]?.index === record.shotIndex,
        );
        if (!brief) break;
        entries.push({
          ...shared,
          outputText: [
            brief.promptText,
            ...(brief.negativePrompt ? [brief.negativePrompt] : []),
            brief.visualObjective,
            brief.action,
            brief.subject,
            brief.environment,
            brief.cameraMovement,
            brief.lensFraming,
            brief.lighting,
            brief.colorTreatment,
            ...brief.continuityRequirements,
            ...brief.qualityRubric,
          ],
        });
        break;
      }
      default: {
        const unreachable: never = record.agentRole;
        throw new Error(`unhandled Creative Memory agent role ${String(unreachable)}`);
      }
    }
  }

  return entries;
}

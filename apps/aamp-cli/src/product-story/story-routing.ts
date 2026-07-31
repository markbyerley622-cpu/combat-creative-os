import type { SceneSourceDecision } from '../storyboard-video/source-precedence';
import { ProductStoryError, type ProductStoryPlan } from './story-contracts';

/**
 * Re-routing the scenes the product story composites itself.
 *
 * The base source precedence is untouched: it still resolves every scene the
 * way it always did, and this runs afterwards over its output. What it changes
 * is narrow and stated — a scene the story plan declares as a plate composite
 * no longer needs a moving source from anywhere else, so it stops requiring
 * generation.
 *
 * That has three consequences worth naming, because each is the point:
 *
 *   - **It cannot spend money.** A scene that does not require generation is
 *     priced at nothing, so it can never reach the cost ceiling, the upload or
 *     the provider. The rerouting happens before the estimate for exactly that
 *     reason.
 *   - **It is not the silent still fallback.** A composited scene is genuinely
 *     moving: the plate carries an authored camera move and the interface on it
 *     is animated frame by frame. Nothing here promotes a held frame into the
 *     timeline, which is what that rule forbids.
 *   - **It removes scene 1's rejected take from the cut.** A named reviewer
 *     rejected those bytes for composition drift and a gaze lift, and a
 *     rejected take is not reused. The rerouting is recorded scene by scene
 *     rather than left to be inferred from what is missing.
 */

export interface StoryRoutingChange {
  readonly sceneNumber: number;
  readonly sourceTypeBefore: SceneSourceDecision['selectedSourceType'];
  readonly sourceTypeAfter: SceneSourceDecision['selectedSourceType'];
  readonly requiredGenerationBefore: boolean;
  readonly requiresGenerationAfter: false;
  readonly reason: string;
}

export interface StoryRoutingResult {
  readonly decisions: readonly SceneSourceDecision[];
  readonly changes: readonly StoryRoutingChange[];
}

export function applyProductStoryRouting(input: {
  readonly decisions: readonly SceneSourceDecision[];
  readonly plan: ProductStoryPlan;
}): StoryRoutingResult {
  const composited = new Map(
    input.plan.scenes
      .filter((scene) => scene.kind !== 'FOOTAGE_TREATMENT')
      .map((scene) => [scene.sceneNumber, scene]),
  );

  for (const sceneNumber of composited.keys()) {
    if (!input.decisions.some((decision) => decision.sceneNumber === sceneNumber)) {
      throw new ProductStoryError(
        'INVALID_STORY_PLAN',
        `the story plan composites scene ${sceneNumber}, which the run's source precedence never resolved`,
        sceneNumber,
      );
    }
  }

  const changes: StoryRoutingChange[] = [];
  const decisions = input.decisions.map((decision) => {
    const scene = composited.get(decision.sceneNumber);
    if (!scene) return decision;

    const reason =
      scene.kind === 'PLATE_UI_COMPOSITE'
        ? `this scene shows the Combat Reviews interface on a photographed handset. Its authoritative plate is rendered full-frame under an authored move and the mobile-native ${scene.surface} document is mapped onto the plate's calibrated screen. A generative model asked to redraw a product interface invents its contents, and the storyboard panel for this scene is a 470px landscape crop that can only sit inside a portrait frame — which is the defect this replaces.`
        : `this scene's picture is its authoritative plate under an authored deterministic move. The generated take bought for it was rejected by a named reviewer for composition drift and a gaze lift, and a rejected take is not reused.`;

    changes.push({
      sceneNumber: decision.sceneNumber,
      sourceTypeBefore: decision.selectedSourceType,
      sourceTypeAfter: 'DETERMINISTIC_MOTION_GRAPHICS',
      requiredGenerationBefore: decision.requiresGeneration,
      requiresGenerationAfter: false,
      reason,
    });

    return {
      ...decision,
      selectedSourceType: 'DETERMINISTIC_MOTION_GRAPHICS' as const,
      selectedIdentifier: scene.frameId,
      reasonSelected: reason,
      requiresGeneration: false,
      generationInputFrameId: scene.frameId,
      rejectedAlternatives: [
        ...decision.rejectedAlternatives,
        {
          sourceType: decision.selectedSourceType,
          identifier: decision.selectedIdentifier,
          reason:
            'the product story composites this scene deterministically, so no moving source is bought for it',
        },
      ],
    } satisfies SceneSourceDecision;
  });

  return { decisions, changes };
}

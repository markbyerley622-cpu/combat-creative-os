import { writeFile } from 'node:fs/promises';

import { panelAssetId } from '../flagship/storyboard-v2';
import { parseHumanPlan, type HumanCreativePlan } from '../preview/human-plan';
import { StoryboardVideoError } from './failures';
import type { PreparedSceneClip } from './scene-media';

/**
 * The plan the render actually executes.
 *
 * The authored campaign plan binds every beat to a still storyboard panel and
 * gives it a panel treatment. A scene that now has moving footage needs two
 * things changed and nothing else: a scene treatment that can act on video,
 * and a pinned in-point so the deterministic selector uses the window the trim
 * was cut for rather than searching the clip for one.
 *
 * Everything else — the beat order, the durations, the transitions, the
 * captions, the decorations, the audio cues, the CTA, the brand constraints —
 * is carried through untouched. The storyboard is locked art direction, and
 * replacing a still plate with a moving one is a change of source, not a
 * change of cut.
 *
 * The derived plan is written to the run directory and **re-parsed through
 * `parseHumanPlan`**, so there is no privileged path around the schema for
 * plans this code produced. If the derivation breaks an invariant the schema
 * enforces, it is refused here rather than rendered.
 */

/**
 * The treatment a moving scene gets.
 *
 * `STATIC_HOLD` deliberately. The motion is already in the footage — either
 * the model performed the scene's declared `cameraMotion`, or the acquired
 * plate was shot with a real camera. Layering a synthetic push on top would
 * produce two competing moves in one shot, and the panel treatments this
 * replaces are stills-only in any case.
 */
export const MOVING_SCENE_TREATMENT = 'STATIC_HOLD' as const;

export interface DeriveRenderPlanInput {
  readonly basePlan: HumanCreativePlan;
  /** Prepared clips by scene sequence (1-based). */
  readonly preparedClips: ReadonlyMap<number, PreparedSceneClip>;
}

export interface DerivedPlanChange {
  readonly sceneNumber: number;
  readonly beatId: string;
  readonly assetId: string;
  readonly treatmentBefore: string;
  readonly treatmentAfter: string;
  readonly pinnedInSeconds: number;
}

export interface DerivedRenderPlan {
  readonly plan: HumanCreativePlan;
  readonly changes: readonly DerivedPlanChange[];
}

export function deriveRenderPlan(input: DeriveRenderPlanInput): DerivedRenderPlan {
  const changes: DerivedPlanChange[] = [];

  const beats = input.basePlan.beats.map((beat, index) => {
    const sceneNumber = index + 1;
    const prepared = input.preparedClips.get(sceneNumber);
    if (!prepared) return beat;

    const expectedAssetId = panelAssetId({ sequence: sceneNumber });
    if (beat.source.assetId && beat.source.assetId !== expectedAssetId) {
      throw new StoryboardVideoError(
        'INVALID_STORYBOARD',
        `beat "${beat.id}" at position ${sceneNumber} binds asset "${beat.source.assetId}", but scene ${sceneNumber} stages its footage as "${expectedAssetId}". The plan and the storyboard disagree about which scene this beat is.`,
        sceneNumber,
      );
    }

    changes.push({
      sceneNumber,
      beatId: beat.id,
      assetId: expectedAssetId,
      treatmentBefore: beat.motion.treatment,
      treatmentAfter: MOVING_SCENE_TREATMENT,
      pinnedInSeconds: prepared.pinnedInSeconds,
    });

    return {
      ...beat,
      source: {
        ...beat.source,
        assetId: expectedAssetId,
        // Pinned, not searched: the trim was cut to put this beat's window
        // exactly here, and the selector's job becomes verifying that rather
        // than choosing somewhere else in a clip that has only one legal spot.
        inSeconds: prepared.pinnedInSeconds,
      },
      motion: { ...beat.motion, treatment: MOVING_SCENE_TREATMENT },
    };
  });

  // Re-parsed rather than trusted. A derivation that broke a schema invariant
  // is caught here, before FFmpeg, with the schema's own message.
  const plan = parseHumanPlan({ ...input.basePlan, beats }, '<derived render plan>');
  return { plan, changes };
}

export async function writeDerivedPlan(targetPath: string, plan: HumanCreativePlan): Promise<void> {
  await writeFile(targetPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
}

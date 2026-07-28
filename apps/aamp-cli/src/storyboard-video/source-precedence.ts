import type { ProductionAssetManifest } from '../production-assets';
import { StoryboardVideoError } from './failures';
import type { AcquiredOriginal, FootagePack } from './footage-pack';
import type { KeyframeLibrary } from './keyframe-library';
import {
  MANUAL_GENERATION_PROVENANCE,
  PROVIDER_GENERATION_PROVENANCE,
  type GenerationProvenance,
  type PreGeneratedClipLibrary,
} from './pre-generated-clips';
import {
  modeReachesGenerationProvider,
  sceneSlotSeconds,
  type SceneManifest,
  type SceneManifestEntry,
} from './scene-manifest';

/**
 * Which source fills each scene, decided once, deterministically, and with the
 * losers written down.
 *
 * The precedence is a statement about truthfulness, not about quality. A real
 * Combat Reviews capture outranks everything for a product-interface scene
 * because it is the only source that is *actually the product*; acquired
 * footage outranks generation because a real photograph of a real gym is a
 * stronger claim than a plausible one; generation outranks nothing at all
 * because a scene with no moving source is a scene that cannot be honestly
 * filled by holding a still and calling it a film.
 *
 *   1. `REAL_PRODUCT_CAPTURE`     — an exact Combat Reviews screen capture.
 *   2. `ACQUIRED_PRODUCTION_FOOTAGE` — a full-resolution, rights-cleared original.
 *   3. animated from the authoritative FRAME-XX, either
 *        `PRE_GENERATED_MANUAL_CLIP` — already animated by hand, or
 *        `LTX_GENERATED`             — animated by this pipeline, at cost.
 *   4. `DETERMINISTIC_MOTION_GRAPHICS` — exact typography, logo and CTA.
 *   5. refusal.
 *
 * The two members of level 3 are the same *kind* of source and a different
 * *provenance*. A clip the operator animated in LTX Studio is real footage and
 * there is no reason to buy it twice, so it wins within the level — but it is
 * recorded as `MANUAL_LTX_STUDIO` everywhere it travels, and nothing here may
 * describe it as something this pipeline produced. Counting hand-made footage
 * toward a claim about what the automated path can do would make the claim
 * untrue.
 *
 * **There is no still-image fallback for a required moving source.** A scene
 * declared `LTX_IMAGE_TO_VIDEO` whose generation fails does not quietly become
 * a held frame: the run fails with `NO_USABLE_SOURCE` and says which scene.
 * Silently degrading to a slideshow is the failure mode this whole milestone
 * exists to prevent, because the resulting file still passes every technical
 * gate and still looks, to anything but a human eye, like a finished
 * advertisement.
 *
 * Selection is pure: it reads the manifests and the measurements, consults no
 * clock and no network, and two runs over the same inputs decide identically.
 */

export const SOURCE_TYPES = [
  'REAL_PRODUCT_CAPTURE',
  'ACQUIRED_PRODUCTION_FOOTAGE',
  'PRE_GENERATED_MANUAL_CLIP',
  'LTX_GENERATED',
  'DETERMINISTIC_MOTION_GRAPHICS',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Ascending precedence. Index is the rank a report prints. */
export const SOURCE_PRECEDENCE: readonly SourceType[] = SOURCE_TYPES;

export interface RejectedAlternative {
  readonly sourceType: SourceType;
  readonly identifier: string;
  readonly reason: string;
}

export interface SceneSourceDecision {
  readonly sceneNumber: number;
  readonly sceneRole: string;
  readonly slotSeconds: number;
  readonly generationMode: SceneManifestEntry['generationMode'];
  readonly selectedSourceType: SourceType;
  /** The asset id, or the FRAME number when the source is a generation input. */
  readonly selectedIdentifier: string;
  readonly reasonSelected: string;
  readonly rejectedAlternatives: readonly RejectedAlternative[];
  /** Decided here; whether it *succeeded* is recorded later by the generation stage. */
  readonly requiresGeneration: boolean;
  /** The acquired original bound to this scene, when one was selected. */
  readonly acquiredAssetId?: string;
  /** The capture asset id bound to this scene, when one was selected. */
  readonly captureAssetId?: string;
  /** The authoritative keyframe this scene generates from, when it generates. */
  readonly generationInputFrameId?: string;
  /** Where the moving picture came from, when this scene has animated footage. */
  readonly generationProvenance?: GenerationProvenance;
  /** The hand-animated clip bound to this scene, when one was reused. */
  readonly preGeneratedClipPath?: string;
  readonly preGeneratedClipChecksumSha256?: string;
}

export interface SourceDecisionInput {
  readonly sceneManifest: SceneManifest;
  readonly storyboardRolesBySceneNumber: ReadonlyMap<number, string>;
  readonly keyframes: KeyframeLibrary;
  readonly footagePack: FootagePack | null;
  /** Clips the operator animated by hand. Reused rather than bought again. */
  readonly preGeneratedClips: PreGeneratedClipLibrary;
  /**
   * Scenes the operator explicitly asked to regenerate. The only way a scene
   * that already has a clip becomes a paid request again.
   */
  readonly regenerateScenes: ReadonlySet<number>;
  /** The work pack's library, where real Combat Reviews captures live. */
  readonly captureLibrary: ProductionAssetManifest | null;
  /**
   * How much material a scene needs from a moving source: its slot plus the
   * transition handles the deterministic selector will demand at each end.
   */
  readonly requiredSourceSecondsForScene: (scene: SceneManifestEntry) => number;
}

/**
 * A capture is eligible for a scene when it is a real product screen and the
 * scene is one that shows the product.
 *
 * Deliberately conservative: only `APP_SCREENSHOT` counts, and only for scenes
 * whose manifest says they preserve exact product UI. A capture pressed into a
 * photographic scene would be a screenshot standing in for a gym.
 */
function eligibleCaptures(
  scene: SceneManifestEntry,
  captureLibrary: ProductionAssetManifest | null,
): readonly { id: string; description: string }[] {
  if (!captureLibrary || !scene.preserveExactProductUi) return [];
  return captureLibrary.assets
    .filter((asset) => asset.role === 'APP_SCREENSHOT' && asset.kind === 'IMAGE')
    .filter((asset) => asset.tags.includes(`scene-${scene.sceneNumber}`))
    .map((asset) => ({ id: asset.id, description: asset.description }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Whether an acquired original can serve this scene.
 *
 * Two independent conditions, and both are refusals with a stated reason so
 * the report can explain a near-miss. The role must be one the author declared
 * acceptable for the scene — matching by tag similarity would let a boxing
 * plate fill a community-discussion beat because both mention "people" — and
 * the clip must be long enough to yield the scene's window plus its handles.
 */
function evaluateAcquired(
  scene: SceneManifestEntry,
  original: AcquiredOriginal,
  requiredSeconds: number,
): { eligible: true } | { eligible: false; reason: string } {
  if (!scene.acceptableFootageRoles.includes(original.role)) {
    return {
      eligible: false,
      reason: `role ${original.role} is not among the roles this scene accepts (${
        scene.acceptableFootageRoles.join(', ') || 'none declared'
      })`,
    };
  }
  if (original.measured.durationSeconds + 1e-6 < requiredSeconds) {
    return {
      eligible: false,
      reason: `runs ${original.measured.durationSeconds.toFixed(2)}s, short of the ${requiredSeconds.toFixed(2)}s this scene needs once transition handles are reserved`,
    };
  }
  if (original.watermarkPresent === true) {
    return { eligible: false, reason: 'a watermark was recorded on this original' };
  }
  return { eligible: true };
}

export function resolveSceneSources(input: SourceDecisionInput): readonly SceneSourceDecision[] {
  const decisions: SceneSourceDecision[] = [];
  // An original may only fill one scene: two scenes drawing on the same eight
  // seconds of footage is how a fifteen-second cut starts to look like a loop.
  const claimedOriginals = new Set<string>();

  for (const scene of [...input.sceneManifest.scenes].sort(
    (a, b) => a.sceneNumber - b.sceneNumber,
  )) {
    const rejected: RejectedAlternative[] = [];
    const requiredSeconds = input.requiredSourceSecondsForScene(scene);
    const sceneRole = input.storyboardRolesBySceneNumber.get(scene.sceneNumber) ?? 'UNKNOWN';
    const slotSeconds = sceneSlotSeconds(scene);
    const base = {
      sceneNumber: scene.sceneNumber,
      sceneRole,
      slotSeconds,
      generationMode: scene.generationMode,
    };

    // ---- 1. an exact real product capture ---------------------------------
    const captures = eligibleCaptures(scene, input.captureLibrary);
    if (captures.length > 0) {
      const winner = captures[0] as { id: string; description: string };
      for (const loser of captures.slice(1)) {
        rejected.push({
          sourceType: 'REAL_PRODUCT_CAPTURE',
          identifier: loser.id,
          reason: 'a lower asset id won the deterministic tie-break',
        });
      }
      decisions.push({
        ...base,
        selectedSourceType: 'REAL_PRODUCT_CAPTURE',
        selectedIdentifier: winner.id,
        reasonSelected:
          'a real Combat Reviews screen capture exists for this scene, and an exact capture of the product outranks every other source for a product-interface beat',
        rejectedAlternatives: rejected,
        requiresGeneration: false,
        captureAssetId: winner.id,
      });
      continue;
    }
    if (scene.preserveExactProductUi) {
      rejected.push({
        sourceType: 'REAL_PRODUCT_CAPTURE',
        identifier: `scene-${scene.sceneNumber}`,
        reason: 'no capture in the work pack is tagged for this scene',
      });
    }

    // ---- 2. full-resolution acquired production footage -------------------
    if (!modeReachesGenerationProvider(scene.generationMode)) {
      // An exact-UI or brand scene is not a photographic plate. Acquired
      // footage is not even considered for it — substituting a gym clip for a
      // rankings screen would change the story, not improve the picture.
      decisions.push({
        ...base,
        selectedSourceType: 'DETERMINISTIC_MOTION_GRAPHICS',
        selectedIdentifier: scene.sourceFrame,
        reasonSelected:
          scene.generationMode === 'EXACT_UI_MOTION'
            ? 'this scene shows the Combat Reviews interface, so it is animated deterministically from the approved frame. A generative model asked to redraw a rankings table invents its contents.'
            : 'this is the brand and call-to-action frame, held with restrained deterministic motion so the typography stays exactly as approved',
        rejectedAlternatives: rejected,
        requiresGeneration: false,
        generationInputFrameId: scene.sourceFrame,
      });
      continue;
    }

    const candidates = (input.footagePack?.originals ?? []).filter(
      (original) => !claimedOriginals.has(original.assetId),
    );
    const eligible: AcquiredOriginal[] = [];
    for (const original of candidates) {
      const verdict = evaluateAcquired(scene, original, requiredSeconds);
      if (verdict.eligible) {
        eligible.push(original);
      } else {
        rejected.push({
          sourceType: 'ACQUIRED_PRODUCTION_FOOTAGE',
          identifier: original.assetId,
          reason: verdict.reason,
        });
      }
    }
    for (const original of input.footagePack?.originals ?? []) {
      if (!claimedOriginals.has(original.assetId)) continue;
      rejected.push({
        sourceType: 'ACQUIRED_PRODUCTION_FOOTAGE',
        identifier: original.assetId,
        reason: 'an earlier scene already claimed this original',
      });
    }

    if (eligible.length > 0) {
      // Highest reviewed quality wins; asset id breaks the tie, so the choice
      // is stable across runs.
      const ordered = [...eligible].sort((a, b) => {
        const score = (b.visualReviewScore ?? 0) - (a.visualReviewScore ?? 0);
        return score !== 0 ? score : a.assetId.localeCompare(b.assetId);
      });
      const winner = ordered[0] as AcquiredOriginal;
      for (const loser of ordered.slice(1)) {
        rejected.push({
          sourceType: 'ACQUIRED_PRODUCTION_FOOTAGE',
          identifier: loser.assetId,
          reason: `scored ${loser.visualReviewScore ?? 'unscored'} against the winner's ${winner.visualReviewScore ?? 'unscored'}`,
        });
      }
      claimedOriginals.add(winner.assetId);
      decisions.push({
        ...base,
        selectedSourceType: 'ACQUIRED_PRODUCTION_FOOTAGE',
        selectedIdentifier: winner.assetId,
        reasonSelected: `a full-resolution rights-cleared original (${winner.measured.widthPx}x${winner.measured.heightPx}, ${winner.measured.durationSeconds.toFixed(2)}s, ${winner.provider}) satisfies this scene's role and gives it a real photographic plate rather than a generated one`,
        rejectedAlternatives: rejected,
        requiresGeneration: false,
        acquiredAssetId: winner.assetId,
      });
      continue;
    }

    // ---- 3. animated from the authoritative keyframe ----------------------
    const keyframe = input.keyframes.frames.find((frame) => frame.frameId === scene.sourceFrame);
    if (!keyframe) {
      throw new StoryboardVideoError(
        'MISSING_FRAME',
        `scene ${scene.sceneNumber} generates from ${scene.sourceFrame}, which the keyframe library does not hold`,
        scene.sceneNumber,
      );
    }

    const manualClip = input.preGeneratedClips.clips.find(
      (clip) => clip.sceneNumber === scene.sceneNumber,
    );
    const askedToRegenerate = input.regenerateScenes.has(scene.sceneNumber);

    if (manualClip && !askedToRegenerate) {
      decisions.push({
        ...base,
        selectedSourceType: 'PRE_GENERATED_MANUAL_CLIP',
        selectedIdentifier: manualClip.frameId,
        reasonSelected: `${manualClip.fileName} was animated by hand in LTX Studio and is already real footage for this scene (${manualClip.widthPx}x${manualClip.heightPx}, ${manualClip.durationSeconds.toFixed(2)}s). It is reused rather than bought again. This pipeline did not produce these bytes: provenance is ${MANUAL_GENERATION_PROVENANCE}.`,
        rejectedAlternatives: [
          ...rejected,
          {
            sourceType: 'LTX_GENERATED',
            identifier: scene.sourceFrame,
            reason:
              'a hand-animated clip already covers this scene; pass --regenerate-scene to spend on it again',
          },
        ],
        requiresGeneration: false,
        generationInputFrameId: scene.sourceFrame,
        generationProvenance: MANUAL_GENERATION_PROVENANCE,
        preGeneratedClipPath: manualClip.absolutePath,
        preGeneratedClipChecksumSha256: manualClip.checksumSha256,
      });
      continue;
    }

    if (manualClip && askedToRegenerate) {
      rejected.push({
        sourceType: 'PRE_GENERATED_MANUAL_CLIP',
        identifier: manualClip.frameId,
        reason:
          'a hand-animated clip exists but --regenerate-scene named this scene explicitly, so it is regenerated at cost',
      });
    }

    decisions.push({
      ...base,
      selectedSourceType: 'LTX_GENERATED',
      selectedIdentifier: scene.sourceFrame,
      reasonSelected:
        'no real moving source and no hand-animated clip satisfies this scene, so it is animated from the approved production keyframe. The frame is authoritative art; the model supplies motion, not content.',
      rejectedAlternatives: rejected,
      requiresGeneration: true,
      generationInputFrameId: scene.sourceFrame,
      generationProvenance: PROVIDER_GENERATION_PROVENANCE,
    });
  }

  return decisions;
}

/**
 * Refuses a run whose generative scenes cannot be generated.
 *
 * Called after the generation stage reports what actually happened. This is
 * where "no slideshow fallback" is enforced: a required moving source that
 * failed is a failed run, named scene by scene, not a still quietly promoted
 * into the timeline.
 */
export function assertNoSilentStillFallback(
  decisions: readonly SceneSourceDecision[],
  generatedSceneNumbers: ReadonlySet<number>,
): void {
  const missing = decisions
    .filter((decision) => decision.requiresGeneration)
    .filter((decision) => !generatedSceneNumbers.has(decision.sceneNumber));
  if (missing.length === 0) return;
  throw new StoryboardVideoError(
    'NO_USABLE_SOURCE',
    `${missing.length} scene(s) require a moving source that was never produced: ${missing
      .map((decision) => `scene ${decision.sceneNumber} (${decision.sceneRole})`)
      .join(
        ', ',
      )}. The run stops here rather than holding the still frame — a generated scene that silently becomes a slideshow still passes every technical gate and is not the advertisement that was approved.`,
    missing[0]?.sceneNumber,
  );
}

/**
 * The lowest-numbered scene that still needs this pipeline to generate it.
 *
 * This is what the first live paid acceptance test targets. Targeting the next
 * *required missing* scene rather than an arbitrary one means the money spent
 * proving the automated path works also buys footage the finished
 * advertisement needs — the test contributes to the deliverable instead of
 * producing a throwaway.
 */
export function nextRequiredGenerationScene(
  decisions: readonly SceneSourceDecision[],
): SceneSourceDecision | null {
  return (
    [...decisions]
      .filter((decision) => decision.requiresGeneration)
      .sort((a, b) => a.sceneNumber - b.sceneNumber)[0] ?? null
  );
}

export interface SourceDecisionReportRow extends SceneSourceDecision {
  readonly ltxCalled: boolean;
  readonly requestedGenerationSeconds: number | null;
  readonly usedSeconds: number | null;
  readonly discardedSeconds: number | null;
  readonly costCents: number;
  /** The asset id the finished render manifest actually resolved for this scene. */
  readonly finalManifestSource: string | null;
  readonly finalManifestChecksumSha256: string | null;
}

export interface GenerationOutcomeForReport {
  readonly sceneNumber: number;
  readonly ltxCalled: boolean;
  readonly requestedGenerationSeconds: number | null;
  readonly usedSeconds: number | null;
  readonly costCents: number;
}

/**
 * The report a person reads to answer "why does scene 5 look like that?".
 *
 * Every row names what won, why, what lost, whether money was spent, how much
 * footage was bought against how much was used, and what the finished manifest
 * ended up resolving. A table of winners with no losers is not an explanation.
 */
export function buildSourceDecisionReport(input: {
  readonly decisions: readonly SceneSourceDecision[];
  readonly outcomes: ReadonlyMap<number, GenerationOutcomeForReport>;
  readonly finalManifestSourceByScene: ReadonlyMap<
    number,
    { readonly assetId: string; readonly checksumSha256: string | null }
  >;
}): readonly SourceDecisionReportRow[] {
  return input.decisions.map((decision) => {
    const outcome = input.outcomes.get(decision.sceneNumber);
    const final = input.finalManifestSourceByScene.get(decision.sceneNumber);
    const requested = outcome?.requestedGenerationSeconds ?? null;
    const used = outcome?.usedSeconds ?? null;
    return {
      ...decision,
      ltxCalled: outcome?.ltxCalled ?? false,
      requestedGenerationSeconds: requested,
      usedSeconds: used,
      discardedSeconds:
        requested !== null && used !== null ? Number((requested - used).toFixed(6)) : null,
      costCents: outcome?.costCents ?? 0,
      finalManifestSource: final?.assetId ?? null,
      finalManifestChecksumSha256: final?.checksumSha256 ?? null,
    };
  });
}

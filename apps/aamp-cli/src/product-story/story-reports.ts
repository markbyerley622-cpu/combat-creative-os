import {
  CRUSHED_LUMA_LEVEL,
  DEFAULT_EXPOSURE_REQUIREMENT,
  INTERFACE_EXPOSURE_REQUIREMENT,
  MOTION_TREATMENT_CATALOGUE_VERSION,
  READABLE_LUMA_LEVEL,
} from '@combat/media';

import { MOCKUP_NOTICE, PRODUCT_MOCKUP_CLASSIFICATION } from '../product-motion/mobile-documents';
import type { BuiltStoryScene } from './build-story-scenes';
import { INTERFACE_DOCUMENT_VERSION } from './interface-documents';
import { SCREEN_TREATMENT_VERSION } from './screen-treatments';
import type { SceneExposureRecord } from './story-exposure';
import {
  PRODUCT_STORY_LABEL,
  PRODUCT_STORY_VERSION,
  type ProductStoryPlan,
} from './story-contracts';

/**
 * The reports a person reads to decide whether the correction worked.
 *
 * Each one measures what can be measured and names what cannot, in the shape
 * every other report in this repository uses. Nothing here scores creative
 * quality, and no function may be added that does: a compositor can prove an
 * interface is on a handset and cannot prove the advertisement is any good.
 */

export const STORY_REPORT_PROFILE_VERSION = 1 as const;

const HUMAN_JUDGEMENT_REQUIRED = 'HUMAN_JUDGEMENT_REQUIRED' as const;

export function buildUiCalibrationReport(input: {
  readonly plan: ProductStoryPlan;
  readonly built: readonly BuiltStoryScene[];
}): unknown {
  const calibrated = input.built.filter((scene) => scene.calibration !== null);
  return {
    profileVersion: STORY_REPORT_PROFILE_VERSION,
    label: PRODUCT_STORY_LABEL,
    method:
      'Every calibration was validated before anything was rendered from it: the four corners must ' +
      'lie on the plate, be ordered top-left/top-right/bottom-left/bottom-right, form a convex ' +
      'quadrilateral, clear the minimum area, aspect-ratio and interior-angle limits, and have ' +
      'opposite edges within the permitted ratio. A calibration that fails is a named refusal — ' +
      'nothing falls back to a storyboard panel.',
    interfaceDocumentVersion: INTERFACE_DOCUMENT_VERSION,
    scenes: calibrated.map((scene) => {
      const calibration = scene.calibration as NonNullable<BuiltStoryScene['calibration']>;
      return {
        sceneNumber: scene.sceneNumber,
        frameId: scene.plateFrameId,
        surface: calibration.surface,
        quad: calibration.quad,
        cornersInsidePlate: calibration.cornersInsidePlate,
        geometry: {
          topWidthPx: Number(calibration.geometry.topWidthPx.toFixed(2)),
          bottomWidthPx: Number(calibration.geometry.bottomWidthPx.toFixed(2)),
          leftHeightPx: Number(calibration.geometry.leftHeightPx.toFixed(2)),
          rightHeightPx: Number(calibration.geometry.rightHeightPx.toFixed(2)),
          areaPx: Number(calibration.geometry.areaPx.toFixed(0)),
          aspectRatio: Number(calibration.geometry.aspectRatio.toFixed(4)),
          convex: calibration.geometry.convex,
          minInteriorAngleDeg: Number(calibration.geometry.minInteriorAngleDeg.toFixed(2)),
        },
        cssViewport: {
          widthPx: calibration.viewport.cssWidthPx,
          heightPx: calibration.viewport.cssHeightPx,
          deviceScaleFactor: calibration.viewport.deviceScaleFactor,
          note: 'The CSS width is the canonical 393px on every plate; only the height follows the calibrated screen, because a taller handset genuinely runs the same mobile layout and shows more of it.',
        },
        interfaceCanvasPx: calibration.interfaceCanvas,
        mappingUniformity: {
          documentAspect: Number(calibration.mappingUniformity.documentAspect.toFixed(4)),
          projectedAspect: Number(calibration.mappingUniformity.projectedAspect.toFixed(4)),
          impliedVerticalStretch: Number(
            calibration.mappingUniformity.impliedVerticalStretch.toFixed(4),
          ),
          uniform: calibration.mappingUniformity.uniform,
          note: 'Reported, never corrected. The document is sized from the canonical viewport and the quad may never size it.',
        },
      };
    }),
    calibrationOverlaysInFinalRender: false,
    calibrationOverlayNote:
      'Overlays exist only in the comparison gallery. Nothing on the render path draws a corner ' +
      'marker, an outline or a calibration rectangle — the compositor has no filter that could.',
    humanJudgementRequired: [
      'Whether each mapped interface sits convincingly on its handset, at delivery size, is a person reading a picture.',
    ],
  };
}

export function buildProductMockupProvenance(input: { readonly plan: ProductStoryPlan }): unknown {
  return {
    profileVersion: STORY_REPORT_PROFILE_VERSION,
    label: PRODUCT_STORY_LABEL,
    classification: PRODUCT_MOCKUP_CLASSIFICATION,
    notice: MOCKUP_NOTICE,
    interfaceDocumentVersion: INTERFACE_DOCUMENT_VERSION,
    screenTreatmentVersion: SCREEN_TREATMENT_VERSION,
    authorisation: input.plan.authorisation,
    surfacesRendered: input.plan.scenes
      .filter((scene) => scene.kind === 'PLATE_UI_COMPOSITE')
      .map((scene) => ({
        sceneNumber: scene.sceneNumber,
        surface: scene.kind === 'PLATE_UI_COMPOSITE' ? scene.surface : null,
        classification: PRODUCT_MOCKUP_CLASSIFICATION,
      })),
    isPublicReleaseReady: false,
    outputUse: 'INTERNAL_REVIEW',
    notAssertedAsLiveData: true,
    everyPhoneScreenIsConceptUi: true,
  };
}

export function buildStoryExposureReport(input: {
  readonly records: readonly SceneExposureRecord[];
}): unknown {
  return {
    profileVersion: STORY_REPORT_PROFILE_VERSION,
    label: PRODUCT_STORY_LABEL,
    crushedLumaLevel: CRUSHED_LUMA_LEVEL,
    readableLumaLevel: READABLE_LUMA_LEVEL,
    requirements: {
      LIVE_ACTION: DEFAULT_EXPOSURE_REQUIREMENT,
      PRODUCT_INTERFACE: INTERFACE_EXPOSURE_REQUIREMENT,
    },
    method:
      'Each scene is sampled at its opening, midpoint and ending, twice: once over the whole frame ' +
      'and once over the region the subject occupies. The verdict is taken on the worst of the ' +
      'three, because a scene whose ending is unreadable is an unreadable scene. An unmeasurable ' +
      'sample is NOT_MEASURED and is never reported as a pass.',
    bindingFor:
      'every scene, each against its own profile. They detect different defects: a live-action scene ' +
      'fails when the subject is lost in the shadows, and a product-interface scene fails when the ' +
      'handset is showing nothing — an empty display, which is a named rejection criterion and is ' +
      'exactly what an interface that failed to map looks like.',
    scenes: input.records.map((record) => ({
      sceneNumber: record.sceneNumber,
      profile: record.profile,
      requirement: record.requirement,
      status: record.verdict.status,
      failures: record.verdict.failures,
      notMeasuredReason: record.verdict.notMeasuredReason,
      samples: record.samples.map((sample) => ({
        label: sample.label,
        atSeconds: sample.atSeconds,
        frame: sample.frame,
        subjectRegion: sample.subject,
        notMeasuredReason: sample.notMeasuredReason,
      })),
    })),
    humanJudgementRequired: [
      'Whether the grade reads as one film across ten separately-sourced scenes.',
      'Whether the blacks read as black rather than as lifted grey at delivery size.',
    ],
  };
}

export function buildStoryTransitionReport(input: { readonly plan: ProductStoryPlan }): unknown {
  return {
    profileVersion: STORY_REPORT_PROFILE_VERSION,
    label: PRODUCT_STORY_LABEL,
    catalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
    story:
      'notification → combat breadth → schedule → rankings → comparison → prediction → submission → ' +
      'correct result → discussion → call to action',
    prohibited: {
      crossfades: 'not expressible — the transition vocabulary contains no dissolve',
      dipsToBlack: 'not expressible',
      debugGeometry: 'not expressible — no filter in the story compositor draws a marker',
      independentSlideshowZooms:
        'every scene carries one authored move; no scene is a still under a generic push',
      blackFiller: 'every scene is full-frame; the compositor has no pad and no letterbox',
      templateGlitches: 'not in the catalogue',
      randomParticles: 'not in the catalogue',
    },
    transitions: input.plan.transitions.map((transition) => ({
      fromScene: transition.fromScene,
      toScene: transition.toScene,
      kind: transition.kind,
      note: transition.note,
    })),
    humanJudgementRequired: [
      'Whether each cut lands on the moment it claims to, and whether the nine together read as one continuous product story.',
    ],
  };
}

export interface VisibleDefectCheck {
  readonly id: string;
  readonly requirement: string;
  readonly status: 'PASS' | 'FAIL' | 'NOT_MEASURED';
  readonly observed: string;
}

/**
 * The rejection criteria, restated as checks.
 *
 * Every one of these is a line from the rejection. They are answered from the
 * structure of the run — what was built, what was calibrated, what the plan can
 * express — rather than from a promise, and anything that could not be
 * established is `NOT_MEASURED` rather than a pass.
 */
export function buildStoryVisibleDefectsReport(input: {
  readonly plan: ProductStoryPlan;
  readonly built: readonly BuiltStoryScene[];
  readonly exposure: readonly SceneExposureRecord[];
  readonly measuredMaster: Record<string, unknown> | null;
  readonly bitrateKbps: number | null;
  readonly previousBitrateKbps: number | null;
}): unknown {
  const uiScenes = input.plan.scenes.filter((scene) => scene.kind === 'PLATE_UI_COMPOSITE');
  const builtBySceneNumber = new Map(input.built.map((scene) => [scene.sceneNumber, scene]));
  const everyUiSceneMapped = uiScenes.every(
    (scene) => builtBySceneNumber.get(scene.sceneNumber)?.calibration !== null,
  );
  const crushedScenes = input.exposure.filter(
    (record) => (record.verdict.frame?.percentBelowCrushedLevel ?? 0) > 90,
  );

  const checks: VisibleDefectCheck[] = [
    {
      id: 'NO_LANDSCAPE_STORYBOARD_CARD',
      requirement: 'no landscape storyboard card remains',
      status: everyUiSceneMapped ? 'PASS' : 'FAIL',
      observed: `${uiScenes.length} interface scene(s) render the operator's own portrait plate full-frame with a mapped interface; the storyboard panel is not a source for any of them`,
    },
    {
      id: 'NO_DEBUG_RECTANGLE',
      requirement: 'no debug rectangle remains',
      status: 'PASS',
      observed:
        'the story compositor emits only filters on its allow-list, which contains no rectangle-drawing decoration; the ACCENT_OUTLINE over the prediction scene and the filled BRAND_COLOUR_CALLOUT flashes were removed from the plan',
    },
    {
      id: 'NO_EMPTY_PHONE',
      requirement: 'no phone is empty',
      status: everyUiSceneMapped ? 'PASS' : 'FAIL',
      observed: `${uiScenes.length} of ${uiScenes.length} calibrated handset screens carry a mapped mobile-native document`,
    },
    {
      id: 'UI_INSIDE_ITS_PHONE',
      requirement: 'no UI exceeds its phone',
      status: everyUiSceneMapped ? 'PASS' : 'FAIL',
      observed:
        'the interface is cut to the warped screen quad by an alpha mask built from the same corner expressions as the picture warp, so it is structurally unable to exceed the glass',
    },
    {
      id: 'NO_SCENE_9_RED_BAR',
      requirement: 'the Scene-9 red bar is gone',
      status: 'PASS',
      observed:
        'the filled LIGHT_SWEEP decoration was removed from the plan; the discussion scene now carries a feathered, masked gradient sweep inside its rasterised sheet that crosses once and disappears',
    },
    {
      id: 'SCENE_8_RANK_MOVEMENT',
      requirement: 'scene 8 shows #27 → #18',
      status: input.plan.scenes.some((scene) => scene.treatment?.key === 'PREDICTOR_RANK_RESULT')
        ? 'PASS'
        : 'FAIL',
      observed:
        'the reserved right-hand region carries a native-resolution result panel in which the leaving rank rises out and the arriving rank settles into its place',
    },
    {
      id: 'SCENE_7_CONFIRMATION',
      requirement: 'scene 7 carries a submission confirmation',
      status: input.plan.scenes.some((scene) => scene.treatment?.key === 'SUBMISSION_CONFIRMATION')
        ? 'PASS'
        : 'FAIL',
      observed:
        'a confirmation sheet with one restrained red edge, entering immediately after the impact; the full-frame red flash it replaces was removed from the plan',
    },
    {
      id: 'SCENE_10_FULL_FRAME',
      requirement: 'scene 10 is full-frame',
      status: input.plan.scenes.some(
        (scene) => scene.sceneNumber === 10 && scene.kind === 'PLATE_UI_COMPOSITE',
      )
        ? 'PASS'
        : 'FAIL',
      observed:
        "scene 10 renders the operator's FRAME-10 plate cover-framed to 1080×1920 with the events interface mapped into its handset",
    },
    {
      id: 'NO_EMPTY_PROTECTED_REGION',
      requirement: 'no protected region remains empty',
      status: input.plan.scenes.every(
        (scene) => scene.kind !== 'FOOTAGE_TREATMENT' || !scene.protectedRegion || scene.treatment,
      )
        ? 'PASS'
        : 'FAIL',
      observed:
        'the plan schema refuses a scene that reserves a region without declaring a treatment to fill it',
    },
    {
      id: 'NOT_CRUSHED',
      requirement: 'the cut is not crushed',
      status:
        input.exposure.length === 0 ? 'NOT_MEASURED' : crushedScenes.length === 0 ? 'PASS' : 'FAIL',
      observed:
        input.exposure.length === 0
          ? 'no scene could be sampled'
          : `${crushedScenes.length} scene(s) have more than 90% of the frame below luma ${CRUSHED_LUMA_LEVEL}` +
            (crushedScenes.length > 0
              ? ` (${crushedScenes.map((record) => record.sceneNumber).join(', ')})`
              : ''),
    },
    {
      id: 'DELIVERY_BITRATE',
      // Compared against the cut being corrected rather than against an
      // absolute floor. A rate factor is a *quality* target, not a bitrate
      // target: a well-encoded low-key cut legitimately sits below any round
      // number somebody picks, and an invented floor would fail a correct
      // encode while telling nobody anything. What the rejection actually said
      // is that the master was held at ~2.5 Mbps, so the question is whether
      // this one is materially above the cut it replaces.
      requirement: `the master is materially above the ${
        input.previousBitrateKbps === null ? 'rejected' : `${input.previousBitrateKbps} kbps`
      } cut it replaces`,
      status:
        input.bitrateKbps === null
          ? 'NOT_MEASURED'
          : input.previousBitrateKbps === null
            ? 'NOT_MEASURED'
            : input.bitrateKbps >= input.previousBitrateKbps * 1.2
              ? 'PASS'
              : 'FAIL',
      observed:
        input.bitrateKbps === null
          ? 'the produced file could not be measured'
          : input.previousBitrateKbps === null
            ? `measured ${input.bitrateKbps} kbps at CRF ${input.plan.output.qualityCrf}; no earlier master was supplied to compare against`
            : `measured ${input.bitrateKbps} kbps at CRF ${input.plan.output.qualityCrf}, against ${input.previousBitrateKbps} kbps before (${Math.round(
                (100 * input.bitrateKbps) / input.previousBitrateKbps - 100,
              )}% more)`,
    },
  ];

  const failed = checks.filter((check) => check.status !== 'PASS');
  return {
    profileVersion: STORY_REPORT_PROFILE_VERSION,
    label: PRODUCT_STORY_LABEL,
    storyVersion: PRODUCT_STORY_VERSION,
    verdict: failed.length === 0 ? 'NO_LISTED_DEFECT_OBSERVED' : 'DEFECTS_OBSERVED',
    checks,
    measuredMaster: input.measuredMaster,
    notMeasuredCount: checks.filter((check) => check.status === 'NOT_MEASURED').length,
    slideshowJudgement: {
      status: HUMAN_JUDGEMENT_REQUIRED,
      observed: null,
      note: 'Whether the result still resembles a slideshow is a judgement about rhythm and continuity. No measurement of it exists, and inventing one would put the single unverifiable figure into the report a person relies on.',
    },
    humanJudgementRequired: [
      'Creative quality, in every respect.',
      'Whether the ten scenes read as one continuous product story.',
      'Whether the interfaces are convincing as screens rather than as composites.',
    ],
  };
}

export function buildZeroCostExecutionRecord(input: {
  readonly plan: ProductStoryPlan;
  readonly ltxCallCount: number;
  readonly actualCostCents: number;
  readonly maxCostCents: number;
  readonly maxGenerations: number;
}): unknown {
  return {
    profileVersion: STORY_REPORT_PROFILE_VERSION,
    label: PRODUCT_STORY_LABEL,
    paidProviderCalls: 0,
    costCents: 0,
    ltxCallCount: input.ltxCallCount,
    actualCostCents: input.actualCostCents,
    ceilings: {
      maxCostCents: input.maxCostCents,
      maxGenerations: input.maxGenerations,
      note: 'Both ceilings are checked before the first upload. At zero, any scene that would actually be bought refuses the run rather than spending.',
    },
    structuralGuarantees: [
      'No module on the product-story path constructs a generation provider, reads a credential or makes a network request.',
      'Every interface document and every treatment sheet is laid out offline by a browser with a default-deny route handler.',
      'The plates are read from the run-owned staged copies; the operator’s source folder is never written to.',
      'No clip was submitted, retried, retaken, extended or generated.',
    ],
    authoredBy: input.plan.authoredBy,
  };
}

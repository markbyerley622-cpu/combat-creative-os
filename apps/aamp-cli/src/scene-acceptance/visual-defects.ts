import type { SceneMotionInspection } from '../storyboard-video/motion-inspection';
import type { RawClipSurvey } from './raw-clip-inspection';

/**
 * What was looked for, what a machine could answer, and what only a person can.
 *
 * The distinction is the entire value of this file. Orientation, first-frame
 * agreement, decode integrity and the presence of an audio stream are
 * measurable, and they are measured. Whether the subject's identity survived,
 * whether a hand grew a finger, whether the phone kept its shape and whether
 * the result looks *more* real than the plate are not measurable by anything
 * in this repository, and inventing a number for them would put the one figure
 * nobody could check into the report a person relies on.
 *
 * So every observation carries one of four statuses and no score:
 *
 * - `OBSERVED` — measured, and it agrees with the brief.
 * - `DEFECT` — measured, and it does not.
 * - `NOT_MEASURED` — could not be taken, with the reason. Never a pass.
 * - `HUMAN_JUDGEMENT_REQUIRED` — no machine answer exists. Left open.
 *
 * Scene 1's composition governs which questions are even askable. The
 * authoritative plate is shot over the subject's hands with the **rear** of
 * the phone toward the viewer, so there is no display in frame: a blank-screen
 * check and an active-display corner check are `NOT_APPLICABLE` here by
 * composition, not by omission. They belong to Scenes 3, 4, 6 and 10, where
 * the screen faces the viewer. What Scene 1 asks of the phone instead is that
 * its silhouette, rear surface, rigidity and orientation survive.
 */

export const VISUAL_DEFECT_REPORT_VERSION = 1 as const;

export const VISUAL_OBSERVATION_STATUSES = [
  'OBSERVED',
  'DEFECT',
  'NOT_MEASURED',
  'NOT_APPLICABLE',
  'HUMAN_JUDGEMENT_REQUIRED',
] as const;
export type VisualObservationStatus = (typeof VISUAL_OBSERVATION_STATUSES)[number];

export interface VisualObservation {
  readonly id: string;
  readonly status: VisualObservationStatus;
  /** What the brief asked for, in the brief's own terms. */
  readonly what: string;
  /** What was found, or why nothing could be. */
  readonly finding: string;
}

export interface VisualDefectReport {
  readonly reportVersion: typeof VISUAL_DEFECT_REPORT_VERSION;
  readonly observations: readonly VisualObservation[];
  readonly measuredDefectCount: number;
  readonly openHumanJudgementCount: number;
  readonly notice: string;
}

export const VISUAL_DEFECT_NOTICE =
  'Nothing in this report is a judgement about creative quality, and no number here is a craft score. The measured rows say what a deterministic tool could establish about the file; every HUMAN_JUDGEMENT_REQUIRED row is a question only a named person can answer, and it stays open until they do.';

export interface BuildVisualDefectReportInput {
  readonly inspection: SceneMotionInspection;
  readonly survey: RawClipSurvey;
  /** The scene's declared camera motion, so the movement row says what was asked. */
  readonly declaredCameraMotion: string;
}

export function buildVisualDefectReport(input: BuildVisualDefectReportInput): VisualDefectReport {
  const { inspection, survey } = input;
  const measured = inspection.measured;
  const observations: VisualObservation[] = [];

  // --- measurable ------------------------------------------------------------
  const isPortrait =
    measured.widthPx !== null && measured.heightPx !== null && measured.heightPx > measured.widthPx;
  observations.push({
    id: 'PORTRAIT_ORIENTATION',
    status:
      measured.widthPx === null || measured.heightPx === null
        ? 'NOT_MEASURED'
        : isPortrait
          ? 'OBSERVED'
          : 'DEFECT',
    what: 'the clip is portrait — landscape is the defect the permanently-rejected legacy clips carried',
    finding:
      measured.widthPx === null || measured.heightPx === null
        ? 'the geometry could not be measured'
        : `${measured.widthPx}x${measured.heightPx}`,
  });

  observations.push({
    id: 'OPENS_ON_APPROVED_COMPOSITION',
    status:
      survey.firstFrameAgreement === null
        ? 'NOT_MEASURED'
        : survey.firstFrameAgreement >= survey.firstFrameAgreementFloor
          ? 'OBSERVED'
          : 'DEFECT',
    what: `the clip begins on FRAME-01's composition rather than inventing a different establishing frame (layout agreement at or above ${survey.firstFrameAgreementFloor})`,
    finding:
      survey.firstFrameAgreement === null
        ? (survey.firstFrameAgreementNotMeasuredReason ?? 'the comparison could not be taken')
        : survey.firstFrameAgreement.toFixed(4),
  });

  observations.push({
    id: 'NO_AUDIO_STREAM',
    status:
      measured.hasAudio === null
        ? 'NOT_MEASURED'
        : measured.hasAudio === false
          ? 'OBSERVED'
          : 'DEFECT',
    what: 'the request set generate_audio false, so the container carries no audio stream',
    finding:
      measured.hasAudio === null
        ? 'the stream list could not be read'
        : measured.hasAudio
          ? 'an audio stream is present'
          : 'no audio stream',
  });

  observations.push({
    id: 'PICTURE_ACTUALLY_MOVES',
    status:
      survey.wholeClipMotionEnergy === null
        ? 'NOT_MEASURED'
        : survey.wholeClipMotionEnergy >= inspection.motion.floor
          ? 'OBSERVED'
          : 'DEFECT',
    what: `the clip is not a held frame (energy at or above ${inspection.motion.floor} for a scene declared ${input.declaredCameraMotion}; a still measures 0.00)`,
    finding:
      survey.wholeClipMotionEnergy === null
        ? (survey.wholeClipMotionNotMeasuredReason ?? 'the measure could not be taken')
        : survey.wholeClipMotionEnergy.toFixed(4),
  });

  observations.push({
    id: 'DECODES_WITHOUT_ERRORS',
    status: inspection.decodeErrors.length === 0 ? 'OBSERVED' : 'DEFECT',
    what: 'a full decode pass reports no errors',
    finding:
      inspection.decodeErrors.length === 0
        ? 'clean decode'
        : inspection.decodeErrors.join('; ').slice(0, 300),
  });

  observations.push({
    id: 'NO_BLACK_OR_FROZEN_REGIONS',
    status:
      inspection.blackRegions.length === 0 && inspection.freezeRegions.length === 0
        ? 'OBSERVED'
        : 'DEFECT',
    what: 'no black region and no frozen region over the clip',
    finding: `${inspection.blackRegions.length} black region(s), ${inspection.freezeRegions.length} frozen region(s)`,
  });

  // --- not applicable to this composition -----------------------------------
  observations.push({
    id: 'ACTIVE_DISPLAY_BLANK_AND_NEAR_BLACK',
    status: 'NOT_APPLICABLE',
    what: 'the phone display stays clean, blank and near black',
    finding:
      'Scene 1 is shot over the subject with the rear of the phone toward the viewer, so no display is in frame. This check belongs to Scenes 3, 4, 6 and 10, where the screen faces the viewer.',
  });
  observations.push({
    id: 'FOUR_ACTIVE_DISPLAY_CORNERS_TRACKABLE',
    status: 'NOT_APPLICABLE',
    what: 'all four corners of the active display stay visible and trackable',
    finding:
      'There is no active display in this composition to track. Corner tracking is a requirement of the later screen-facing scenes, not of the Scene-1 hook.',
  });

  // --- only a person can answer these ---------------------------------------
  const humanRows: readonly (readonly [string, string])[] = [
    [
      'SUBJECT_IDENTITY_UNCHANGED',
      "the subject's face, features, skin, hair and clothing are the same person as the plate",
    ],
    ['HAND_AND_FINGER_ANATOMY', 'no duplicated, merged or deformed fingers or hands'],
    [
      'PHONE_SILHOUETTE_AND_RIGIDITY',
      "the phone's silhouette, dark rear surface, rigidity and orientation survive; no bending, warping or reshaping",
    ],
    ['SINGLE_NATURAL_BLINK', 'one natural blink, no dramatic head turn, no smile, no speech'],
    ['RESTRAINED_CAMERA_PUSH', 'a slow push of roughly three percent, with no shake and no whip'],
    [
      'RIM_LIGHT_AND_PALETTE',
      'controlled red rim-light movement inside the black and deep red palette',
    ],
    [
      'NO_HALLUCINATED_GRAPHICS',
      'no invented lettering, numbers, mark, badge, interface or particle effect anywhere in frame',
    ],
    ['REALISM_AGAINST_THE_PLATE', 'the result does not look less realistic than the source plate'],
  ];
  for (const [id, what] of humanRows) {
    observations.push({
      id,
      status: 'HUMAN_JUDGEMENT_REQUIRED',
      what,
      finding:
        'No measurement of this exists in this repository. A named reviewer answers it against the contact sheet and the comparison gallery.',
    });
  }

  return {
    reportVersion: VISUAL_DEFECT_REPORT_VERSION,
    observations,
    measuredDefectCount: observations.filter((row) => row.status === 'DEFECT').length,
    openHumanJudgementCount: observations.filter((row) => row.status === 'HUMAN_JUDGEMENT_REQUIRED')
      .length,
    notice: VISUAL_DEFECT_NOTICE,
  };
}

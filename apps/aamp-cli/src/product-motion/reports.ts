import type { ActualMediaQaReport, ScreenQuad } from '@combat/media';

import type { CalibratedScreen } from './calibration';
import { PRODUCT_MOTION_LABEL, type ProductMotionPlan } from './product-motion-contracts';

/**
 * The two reports a reviewer actually reads.
 *
 * The timing report says what was intended and when; the defects report says
 * what is wrong with the result. They are separate files because they answer
 * different questions and get read by different people at different moments —
 * and because a defect buried inside a timing table is a defect nobody sees.
 *
 * Neither report scores craft. There is no number here for "does it look
 * premium", because no measurement of that exists and inventing one would put
 * the single most quotable figure in the document beyond anyone's ability to
 * check.
 */

export interface ProductMotionReports {
  readonly timing: TimingReport;
  readonly defects: DefectsReport;
}

export interface ShotScreenPosition {
  readonly shotId: string;
  readonly atStart: ScreenQuad;
  readonly atEnd: ScreenQuad;
}

export interface TimingReport {
  readonly label: typeof PRODUCT_MOTION_LABEL;
  readonly planId: string;
  readonly authoredBy: string;
  readonly isRealCampaignRun: false;
  readonly paidProviderCalls: 0;
  readonly durationSeconds: number;
  readonly frameRate: number;
  readonly craftNotice: string;
  readonly states: readonly {
    readonly id: string;
    readonly state: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly durationSeconds: number;
    readonly documentId: string;
    readonly entrance: string;
    readonly entranceSeconds: number;
    readonly scrollFromPx: number;
    readonly scrollToPx: number;
    readonly scrollSettlesAtSeconds: number;
    readonly easing: string;
    readonly intent: string;
  }[];
  readonly accents: readonly {
    readonly id: string;
    readonly key: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly intent: string;
  }[];
  readonly shots: readonly {
    readonly id: string;
    readonly plateId: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly transitionIn: string;
    readonly transitionNote: string;
    readonly startZoom: number;
    readonly endZoom: number;
    readonly screenCentreAtStart: { readonly xPx: number; readonly yPx: number };
    readonly screenCentreAtEnd: { readonly xPx: number; readonly yPx: number };
  }[];
  readonly cuts: readonly {
    readonly atSeconds: number;
    readonly kind: string;
    readonly note: string;
    readonly outgoingShotId: string;
    readonly incomingShotId: string;
    /** How far the handset screen centre jumps across the cut, in delivery pixels. */
    readonly screenCentreDisplacementPx: number;
  }[];
  readonly measured: {
    readonly durationSeconds: number | null;
    readonly widthPx: number | null;
    readonly heightPx: number | null;
    readonly frameRate: number | null;
    readonly qaVerdict: string;
  };
}

const CRAFT_NOTICE =
  'Every figure here is a timing or a geometry. Nothing in this report scores creative quality; ' +
  'whether the sequence reads as one continuous product demonstration is a judgement a person ' +
  'has to make from the frames.';

function centreOf(quad: ScreenQuad): { xPx: number; yPx: number } {
  return {
    xPx: (quad.topLeft.xPx + quad.topRight.xPx + quad.bottomLeft.xPx + quad.bottomRight.xPx) / 4,
    yPx: (quad.topLeft.yPx + quad.topRight.yPx + quad.bottomLeft.yPx + quad.bottomRight.yPx) / 4,
  };
}

export function buildTimingReport(
  plan: ProductMotionPlan,
  screenPositions: readonly ShotScreenPosition[],
  qaReport: ActualMediaQaReport,
): TimingReport {
  const positionsById = new Map(screenPositions.map((entry) => [entry.shotId, entry]));

  const cuts = plan.shots.slice(1).flatMap((shot, index) => {
    const previous = plan.shots[index];
    if (!previous) return [];
    const outgoing = positionsById.get(previous.id);
    const incoming = positionsById.get(shot.id);
    const from = outgoing ? centreOf(outgoing.atEnd) : { xPx: 0, yPx: 0 };
    const to = incoming ? centreOf(incoming.atStart) : { xPx: 0, yPx: 0 };
    return [
      {
        atSeconds: shot.startSeconds,
        kind: shot.transitionIn as string,
        note: shot.transitionNote,
        outgoingShotId: previous.id,
        incomingShotId: shot.id,
        screenCentreDisplacementPx: Math.hypot(to.xPx - from.xPx, to.yPx - from.yPx),
      },
    ];
  });

  return {
    label: PRODUCT_MOTION_LABEL,
    planId: plan.id,
    authoredBy: plan.authoredBy,
    isRealCampaignRun: false,
    paidProviderCalls: 0,
    durationSeconds: plan.output.durationSeconds,
    frameRate: plan.output.frameRate,
    craftNotice: CRAFT_NOTICE,
    states: plan.states.map((state) => ({
      id: state.id,
      state: state.state,
      startSeconds: state.startSeconds,
      endSeconds: state.endSeconds,
      durationSeconds: state.endSeconds - state.startSeconds,
      documentId: state.documentId,
      entrance: state.entrance,
      entranceSeconds: state.entranceSeconds,
      scrollFromPx: state.scroll.fromPx,
      scrollToPx: state.scroll.toPx,
      scrollSettlesAtSeconds: state.scroll.endSeconds,
      easing: state.scroll.easing,
      intent: state.intent,
    })),
    accents: plan.accents.map((accent) => ({
      id: accent.id,
      key: accent.key,
      startSeconds: accent.startSeconds,
      endSeconds: accent.endSeconds,
      intent: accent.intent,
    })),
    shots: plan.shots.map((shot) => {
      const position = positionsById.get(shot.id);
      return {
        id: shot.id,
        plateId: shot.plateId,
        startSeconds: shot.startSeconds,
        endSeconds: shot.endSeconds,
        transitionIn: shot.transitionIn,
        transitionNote: shot.transitionNote,
        startZoom: shot.move.startZoom,
        endZoom: shot.move.endZoom,
        screenCentreAtStart: position ? centreOf(position.atStart) : { xPx: 0, yPx: 0 },
        screenCentreAtEnd: position ? centreOf(position.atEnd) : { xPx: 0, yPx: 0 },
      };
    }),
    cuts,
    measured: {
      durationSeconds: qaReport.summary.durationSeconds,
      widthPx: qaReport.summary.widthPx,
      heightPx: qaReport.summary.heightPx,
      frameRate: qaReport.summary.frameRate,
      qaVerdict: qaReport.verdict,
    },
  };
}

export interface DefectsReport {
  readonly label: typeof PRODUCT_MOTION_LABEL;
  readonly planId: string;
  readonly isRealCampaignRun: false;
  readonly paidProviderCalls: 0;
  readonly isPublicReleaseReady: false;
  readonly requiresHumanApproval: true;
  readonly craftNotice: string;
  readonly accentNotice: string;
  readonly defects: readonly Defect[];
  readonly notClaimed: readonly string[];
  readonly humanChecksRequired: readonly string[];
}

export interface Defect {
  readonly id: string;
  readonly severity: 'BLOCKING' | 'FINDING' | 'NOTE';
  readonly summary: string;
  readonly measured?: Record<string, unknown>;
  readonly whatMustChange: string;
}

/**
 * Defects are stated whether or not anything failed.
 *
 * A report that is empty when the render passes trains a reader to skip it.
 * The plate upscale and the temporary audio are true of every run of this
 * proof and are listed every time, because they are exactly the two things
 * someone would otherwise mistake for finished work.
 */
export function buildDefectsReport(options: {
  readonly plan: ProductMotionPlan;
  readonly qaReport: ActualMediaQaReport;
  readonly calibration: readonly CalibratedScreen[];
  readonly plateSourceWidthPx: number;
  readonly accentNotice: string;
}): DefectsReport {
  const { plan, qaReport } = options;
  const defects: Defect[] = [];

  const upscale = plan.output.widthPx / options.plateSourceWidthPx;
  if (upscale > 1.001) {
    defects.push({
      id: 'DEF-PLATE-UPSCALE',
      severity: 'FINDING',
      summary:
        `The photographic plates are ${options.plateSourceWidthPx}px wide and the delivery frame is ` +
        `${plan.output.widthPx}px, so every plate is upscaled by ${upscale.toFixed(3)}× before the camera move. ` +
        'The interface is unaffected — it is warped separately at delivery resolution — but the photography is softer than native.',
      measured: {
        plateWidthPx: options.plateSourceWidthPx,
        upscaleFactor: Number(upscale.toFixed(4)),
      },
      whatMustChange:
        'Re-render or re-shoot the plates at 1080×1920 or larger. Nothing in the compositor can recover detail the plate never had.',
    });
  }

  defects.push({
    id: 'DEF-TEMPORARY-AUDIO',
    severity: 'FINDING',
    summary:
      'The bed and every cue are the temporary synthetic assets from the existing work pack. This is not a mix and not licensed music.',
    measured: {
      integratedLufs: qaReport.summary.audio?.integratedLufs ?? null,
      truePeakDbtp: qaReport.summary.audio?.peakDbtp ?? null,
      clippedSampleCount: qaReport.summary.audio?.clippedSampleCount ?? null,
    },
    whatMustChange:
      'Replace with a licensed bed and a real sound-design pass before the cut is judged on audio at all.',
  });

  defects.push({
    id: 'DEF-STATIC-PLATES',
    severity: 'NOTE',
    summary:
      'The photographic layer is a still under a restrained camera move. All genuine motion in this proof is interface motion and camera motion; nothing in the photograph itself moves.',
    whatMustChange:
      'If the finished advertisement needs the hand or the fighter to move, those beats need real footage — this proof deliberately does not fake it.',
  });

  defects.push({
    id: 'DEF-LIVE-CAPTURE-UNAVAILABLE',
    severity: 'NOTE',
    summary:
      'The interface comes from the existing approved Combat Reviews captures in the work pack. The live application was not re-captured for this run.',
    whatMustChange:
      'Re-run the read-only capture path against the live application when it is reachable, and re-render, if the interface has changed since those captures were taken.',
  });

  for (const screen of options.calibration) {
    defects.push({
      id: `NOTE-SCREEN-${screen.plateId.toUpperCase()}`,
      severity: 'NOTE',
      summary:
        `Screen "${screen.plateId}" was mapped from operator-declared corners verified against the plate: ` +
        `mean interior luma ${screen.report.interiorMeanLuma.toFixed(1)}, spread ${screen.report.interiorStdDev.toFixed(1)}, ` +
        `aspect ${screen.report.geometry.aspectRatio.toFixed(3)}.`,
      measured: {
        interiorMeanLuma: Number(screen.report.interiorMeanLuma.toFixed(2)),
        interiorStdDev: Number(screen.report.interiorStdDev.toFixed(2)),
        rimContrast: Number(screen.report.rimContrast.toFixed(2)),
        aspectRatio: Number(screen.report.geometry.aspectRatio.toFixed(4)),
        areaPx: Math.round(screen.report.geometry.areaPx),
      },
      whatMustChange:
        'Verification proves the region is a blank, dark, uniform screen. It does not prove the placement is creatively right — check the gallery overlay.',
    });
  }

  if (qaReport.verdict !== 'PASS') {
    defects.unshift({
      id: 'DEF-QA-FAILED',
      severity: 'BLOCKING',
      summary: `Actual-media QA returned ${qaReport.verdict}.`,
      measured: {
        failedChecks: qaReport.measurements
          .filter((measurement) => measurement.verdict === 'FAIL')
          .map((measurement) => measurement.check),
      },
      whatMustChange: 'Fix the failing checks; the file is not usable as a proof until QA passes.',
    });
  }

  return {
    label: PRODUCT_MOTION_LABEL,
    planId: plan.id,
    isRealCampaignRun: false,
    paidProviderCalls: 0,
    isPublicReleaseReady: false,
    requiresHumanApproval: true,
    craftNotice: CRAFT_NOTICE,
    accentNotice: options.accentNotice,
    defects,
    notClaimed: [
      'This is not an approved master and not a campaign result.',
      'This is a 5–6 second visual-language proof, not the finished advertisement.',
      'No measurement here is evidence about creative quality.',
      'The photographic plates do not move; only the interface and the camera do.',
    ],
    humanChecksRequired: [
      'Does any product text visibly warp or shimmer?',
      'Does the interface stay locked to the handset across every cut?',
      'Does any transition expose an empty phone screen?',
      'Does the sequence read as one continuous demonstration rather than four screenshots?',
      'Is the red accent still an accent rather than a wash?',
    ],
  };
}

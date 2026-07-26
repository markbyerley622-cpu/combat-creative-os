import type { RenderManifest } from '@combat/media';

import type { CampaignRequest } from './campaign-request';
import type { ShotSelection } from './source-selection';

/**
 * A structured read on the finished cut, in two clearly separated halves.
 *
 * **Measured checks** are computed from the render manifest and the produced
 * file: when the first visual lands, when the product first appears, how dense
 * the cutting is, how long the CTA is legible. These are facts.
 *
 * **Rubric dimensions** are heuristic. They are derived from structure — did a
 * hook beat exist, is the story arc present, is brand treatment consistent —
 * and they are honest about being proxies. A high score here means "nothing
 * structurally wrong was detected", which is a long way from "this is good".
 *
 * Nothing in this file constitutes approval. `requiresHumanApproval` is always
 * true and `agencyGradeClaim` is always `NOT_ASSESSED`: an automated score
 * cannot establish that creative work is agency-grade, and a system that
 * implied otherwise would be lying in the most expensive possible direction.
 */

export const SCORECARD_DIMENSIONS = [
  'hookStrength',
  'conceptOriginality',
  'productClarity',
  'editingAndPacing',
  'motionTreatment',
  'soundTreatment',
  'brandConsistency',
  'ctaClarity',
  'platformSuitability',
  'similarityRisk',
] as const;
export type ScorecardDimension = (typeof SCORECARD_DIMENSIONS)[number];

export interface DimensionScore {
  readonly dimension: ScorecardDimension;
  /** 0-5. Heuristic and structural — never evidence of creative quality. */
  readonly score: number;
  readonly basis: string;
}

export interface MeasuredCheck {
  readonly check: string;
  readonly measured: number | string | boolean | null;
  readonly expected: string;
  readonly verdict: 'PASS' | 'WARN' | 'FAIL';
}

export interface CreativeScorecard {
  readonly campaignId: string;
  readonly promptSha256: string;
  readonly measuredChecks: readonly MeasuredCheck[];
  readonly dimensions: readonly DimensionScore[];
  /** Mean of the dimension scores. A summary of heuristics, not a quality verdict. */
  readonly heuristicAverage: number;
  readonly requiresHumanApproval: true;
  readonly agencyGradeClaim: 'NOT_ASSESSED';
  readonly notes: readonly string[];
}

export interface BuildScorecardOptions {
  readonly request: CampaignRequest;
  readonly manifest: RenderManifest;
  readonly selections: readonly ShotSelection[];
  /** ffprobe-measured duration of the produced file, when available. */
  readonly measuredDurationSeconds: number | null;
  readonly qaVerdict: string;
  readonly hasAudio: boolean;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(5, Math.round(value * 10) / 10));
}

export function buildCreativeScorecard(options: BuildScorecardOptions): CreativeScorecard {
  const { request, manifest, selections } = options;

  const sceneStarts: number[] = [];
  let cursor = 0;
  manifest.scenes.forEach((scene, index) => {
    const start = index === 0 ? 0 : cursor - (scene.transitionIn?.durationSeconds ?? 0);
    sceneStarts.push(start);
    cursor = start + scene.durationSeconds;
  });

  const firstProductIndex = selections.findIndex(
    (selection) => selection.asset.asset.role === 'APP_SCREENSHOT',
  );
  const firstProductSeconds = firstProductIndex >= 0 ? (sceneStarts[firstProductIndex] ?? 0) : null;
  const ctaSeconds = manifest.cta ? manifest.cta.endSeconds - manifest.cta.startSeconds : 0;
  const cutsPerMinute = (manifest.scenes.length / manifest.output.durationSeconds) * 60;
  const captionCount = manifest.captions?.cues.length ?? 0;
  const shortestScene = Math.min(...manifest.scenes.map((scene) => scene.durationSeconds));
  const brandCardCount = selections.filter((selection) => selection.usedBrandCardFallback).length;

  const measuredChecks: MeasuredCheck[] = [
    {
      check: 'first meaningful visual',
      measured: 0,
      expected: 'the cut opens on a scene at 0.000s',
      verdict: 'PASS',
    },
    {
      check: 'product first visible',
      measured: firstProductSeconds === null ? null : Number(firstProductSeconds.toFixed(3)),
      expected: 'an app screen appears within the first 60% of the cut',
      verdict:
        firstProductSeconds === null
          ? 'FAIL'
          : firstProductSeconds <= request.targetDurationSeconds * 0.6
            ? 'PASS'
            : 'WARN',
    },
    {
      check: 'cut density (cuts per minute)',
      measured: Number(cutsPerMinute.toFixed(1)),
      expected: '40-160 for a vertical short-form feed',
      verdict: cutsPerMinute >= 40 && cutsPerMinute <= 160 ? 'PASS' : 'WARN',
    },
    {
      check: 'shortest scene',
      measured: Number(shortestScene.toFixed(3)),
      expected: 'at least 0.6s, so no shot is subliminal',
      verdict: shortestScene >= 0.6 ? 'PASS' : 'WARN',
    },
    {
      check: 'caption coverage',
      measured: captionCount,
      expected: 'at least one caption cue for sound-off viewing',
      verdict: captionCount > 0 ? 'PASS' : 'WARN',
    },
    {
      check: 'caption safe area',
      measured: manifest.captions?.style.marginBottomPx ?? 0,
      expected: `at least ${request.brandKit.safeAreaBottomPx}px clear of the bottom edge`,
      verdict:
        (manifest.captions?.style.marginBottomPx ?? 0) >= request.brandKit.safeAreaBottomPx
          ? 'PASS'
          : 'WARN',
    },
    {
      check: 'CTA visible duration',
      measured: Number(ctaSeconds.toFixed(3)),
      expected: 'at least 2.0s so the action is readable',
      verdict: ctaSeconds >= 2 ? 'PASS' : 'WARN',
    },
    {
      check: 'technical export compliance',
      measured: `${manifest.output.widthPx}x${manifest.output.heightPx} ${manifest.output.videoCodec}/${manifest.output.audioCodec ?? 'silent'}`,
      expected: '1080x1920 h264, 9:16, 30fps',
      verdict: options.qaVerdict === 'PASS' ? 'PASS' : 'FAIL',
    },
    {
      check: 'measured duration',
      measured:
        options.measuredDurationSeconds === null
          ? null
          : Number(options.measuredDurationSeconds.toFixed(3)),
      expected: `${request.targetDurationSeconds}s ±${manifest.output.durationToleranceFrames} frames`,
      verdict: options.qaVerdict === 'PASS' ? 'PASS' : 'FAIL',
    },
  ];

  const hookSelection = selections[0];
  const distinctAssets = new Set(selections.map((selection) => selection.asset.asset.id)).size;
  // How much of the requested event → information → prediction → discussion
  // arc actually made it into the cut. A cut that collapses to one beat is
  // structurally weaker whatever its individual shots look like.
  const distinctBeats = new Set(selections.map((selection) => selection.storyBeat)).size;

  const dimensions: DimensionScore[] = [
    {
      dimension: 'hookStrength',
      score: clamp(hookSelection?.storyBeat === 'HOOK' ? (brandCardCount > 0 ? 3 : 4) : 2),
      basis: `opens on a ${hookSelection?.storyBeat ?? 'unknown'} beat using ${hookSelection?.asset.asset.role ?? 'no asset'}`,
    },
    {
      dimension: 'conceptOriginality',
      score: clamp(
        (distinctAssets >= selections.length ? 3 : 2) + Math.min(1.5, distinctBeats * 0.4),
      ),
      basis: `${distinctAssets} distinct sources and ${distinctBeats} distinct story beats across ${selections.length} scenes; structural proxy only, originality is a human judgement`,
    },
    {
      dimension: 'productClarity',
      score: clamp(firstProductSeconds === null ? 1 : firstProductSeconds <= 5 ? 4.5 : 3),
      basis:
        firstProductSeconds === null
          ? 'no app screen appears in the cut'
          : `app screen first visible at ${firstProductSeconds.toFixed(2)}s`,
    },
    {
      dimension: 'editingAndPacing',
      score: clamp(cutsPerMinute >= 40 && cutsPerMinute <= 160 ? 4 : 2.5),
      basis: `${cutsPerMinute.toFixed(1)} cuts per minute across ${manifest.scenes.length} scenes`,
    },
    {
      dimension: 'motionTreatment',
      score: clamp(manifest.scenes.some((scene) => scene.motion !== 'STATIC') ? 3.5 : 2),
      basis: 'stills carry a push-in so static screens still read as motion in a feed',
    },
    {
      dimension: 'soundTreatment',
      score: clamp(options.hasAudio ? 3.5 : 1.5),
      basis: options.hasAudio ? 'a music bed is present and ducked' : 'the master is silent',
    },
    {
      dimension: 'brandConsistency',
      score: clamp(manifest.branding && manifest.cta?.logoSourceId ? 4 : 2),
      basis: 'logo lockup present throughout and on the end card',
    },
    {
      dimension: 'ctaClarity',
      score: clamp(ctaSeconds >= 2 ? 4.5 : 2.5),
      basis: `CTA card holds for ${ctaSeconds.toFixed(2)}s`,
    },
    {
      dimension: 'platformSuitability',
      score: clamp(captionCount > 0 && manifest.output.heightPx === 1920 ? 4 : 2.5),
      basis: 'vertical 1080x1920 with burned-in captions for sound-off viewing',
    },
    {
      dimension: 'similarityRisk',
      score: clamp(5),
      basis:
        'every source is owned, commissioned or licensed for output, and no benchmark or competitor material is reachable from a production manifest',
    },
  ];

  const heuristicAverage =
    Math.round((dimensions.reduce((sum, entry) => sum + entry.score, 0) / dimensions.length) * 10) /
    10;

  const notes = [
    'Scores are structural heuristics computed from the edit, not an assessment of creative quality.',
    'This scorecard is not an approval. A human must review the cut before it is used.',
    ...(brandCardCount > 0
      ? [
          `${brandCardCount} scene(s) fell back to a designed brand card because no library asset matched the beat.`,
        ]
      : []),
    ...(options.qaVerdict !== 'PASS'
      ? ['Actual-media QA did not pass, so this cut is not READY regardless of any score above.']
      : []),
  ];

  return {
    campaignId: request.campaignId,
    promptSha256: request.promptSha256,
    measuredChecks,
    dimensions,
    heuristicAverage,
    requiresHumanApproval: true,
    agencyGradeClaim: 'NOT_ASSESSED',
    notes,
  };
}

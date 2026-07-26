import type { ResolvedAsset } from './asset-resolution';
import type { CampaignRequest } from './campaign-request';
import type { StoryBeat } from './production-assets';

/**
 * Chooses which real asset fills each scripted shot.
 *
 * Two properties are non-negotiable. **Determinism**: the same approved
 * request against the same asset library must always produce the same edit, or
 * a human approval means nothing — every score below is a pure function of the
 * request and the manifest, ties break on asset id, and nothing consults a
 * clock or a random source. **Explainability**: each selection carries the
 * reasons it won, so "why is this clip in my ad?" has an answer in the run's
 * source-selection report rather than in someone's memory of a heuristic.
 *
 * When nothing fits, the selector reaches for a designed brand card. It never
 * reaches for unrelated footage — an ad with a deliberate product card in it is
 * honest, while an ad padded with whatever clip happened to be nearest is not.
 */

/** The Script Director's four beats, expanded into the finer story arc this campaign wants. */
const FEATURE_BEAT_CYCLE: readonly StoryBeat[] = ['INFORMATION', 'PREDICTION', 'DISCUSSION'];

export interface ScriptedShot {
  readonly index: number;
  readonly description: string;
  readonly durationSeconds: number;
  /** `HOOK` | `PROMISE` | `FEATURE` | `CTA` from `@combat/domain`'s `ShotBeatSchema`. */
  readonly beat: string;
}

/**
 * Maps a scripted beat onto the story beat an asset should serve.
 *
 * Successive `FEATURE` shots walk INFORMATION → PREDICTION → DISCUSSION rather
 * than all competing for the same assets, which is what turns four generic
 * "feature" shots into the requested event → information → prediction →
 * discussion arc.
 */
export function storyBeatFor(beat: string, featureOrdinal: number): StoryBeat {
  switch (beat) {
    case 'HOOK':
      return 'HOOK';
    case 'PROMISE':
      return 'EVENT_DETAIL';
    case 'CTA':
      return 'CTA';
    default:
      return FEATURE_BEAT_CYCLE[featureOrdinal % FEATURE_BEAT_CYCLE.length] as StoryBeat;
  }
}

export interface ShotSelection {
  readonly shot: ScriptedShot;
  readonly storyBeat: StoryBeat;
  readonly asset: ResolvedAsset;
  readonly score: number;
  readonly reasons: readonly string[];
  /** True when no asset matched the beat and a designed brand card was used. */
  readonly usedBrandCardFallback: boolean;
}

export class MissingShotSourceError extends Error {
  constructor(
    public readonly shotIndex: number,
    public readonly storyBeat: StoryBeat,
    detail: string,
  ) {
    super(`No usable source for shot ${shotIndex} (${storyBeat}): ${detail}`);
    this.name = 'MissingShotSourceError';
  }
}

/** Lowercased, de-duplicated significant words from the request's facts and messages. */
export function relevanceVocabulary(request: CampaignRequest): readonly string[] {
  const text = [
    ...request.productFacts.flatMap((fact) => [fact.label, fact.detail]),
    ...request.eventFacts.flatMap((fact) => [fact.label, fact.detail]),
    ...request.keyMessages,
  ]
    .join(' ')
    .toLowerCase();

  return [...new Set(text.match(/[a-z][a-z0-9-]{3,}/g) ?? [])].sort();
}

interface ScoredCandidate {
  readonly candidate: ResolvedAsset;
  readonly score: number;
  readonly reasons: readonly string[];
}

function scoreCandidate(
  candidate: ResolvedAsset,
  shot: ScriptedShot,
  storyBeat: StoryBeat,
  vocabulary: readonly string[],
  alreadyUsed: ReadonlySet<string>,
): ScoredCandidate | null {
  const { asset } = candidate;

  // Only a scene-eligible role can fill a shot. A logo is a lockup and music
  // is a bed; neither is footage.
  if (
    asset.role !== 'SOURCE_CLIP' &&
    asset.role !== 'APP_SCREENSHOT' &&
    asset.role !== 'BRAND_CARD'
  ) {
    return null;
  }
  if (asset.kind === 'AUDIO') return null;

  // A video that is shorter than the shot cannot fill it. Stills hold for any
  // length, so they are never disqualified on duration.
  if (
    asset.kind === 'VIDEO' &&
    candidate.measuredDurationSeconds !== undefined &&
    candidate.measuredDurationSeconds + 1e-6 < shot.durationSeconds
  ) {
    return null;
  }

  let score = 0;
  const reasons: string[] = [];

  if (asset.beats.includes(storyBeat)) {
    score += 100;
    reasons.push(`declares the ${storyBeat} beat`);
  } else if (asset.beats.length === 0) {
    score += 20;
    reasons.push('declares no beats, so is usable anywhere');
  }

  // Footage carries the hook and the event; the product's own screens carry
  // the informational beats, because that is what the app actually does.
  const prefersFootage = storyBeat === 'HOOK' || storyBeat === 'EVENT_DETAIL';
  if (prefersFootage && asset.role === 'SOURCE_CLIP') {
    score += 40;
    reasons.push('source footage suits an opening beat');
  }
  if (!prefersFootage && asset.role === 'APP_SCREENSHOT') {
    score += 40;
    reasons.push('app screen suits an informational beat');
  }

  // Vertical delivery: portrait sources need no crop.
  if (
    candidate.measuredWidthPx !== undefined &&
    candidate.measuredHeightPx !== undefined &&
    candidate.measuredHeightPx > candidate.measuredWidthPx
  ) {
    score += 15;
    reasons.push('portrait orientation matches 9:16 delivery');
  }
  if (
    candidate.measuredWidthPx !== undefined &&
    candidate.measuredWidthPx >= 1080 &&
    candidate.measuredHeightPx !== undefined &&
    candidate.measuredHeightPx >= 1080
  ) {
    score += 10;
    reasons.push('resolution is sufficient for 1080-wide output');
  }

  // Relevance to what the campaign is actually about.
  const haystack = `${asset.description} ${asset.tags.join(' ')}`.toLowerCase();
  const hits = vocabulary.filter((word) => haystack.includes(word));
  if (hits.length > 0) {
    score += Math.min(30, hits.length * 6);
    reasons.push(`matches campaign facts on: ${hits.slice(0, 5).join(', ')}`);
  }

  // Spread the library rather than repeating one asset while others sit idle.
  if (alreadyUsed.has(asset.id)) {
    score -= 60;
    reasons.push('already used earlier in this cut');
  }

  // A brand card is the fallback, never the first choice.
  if (asset.role === 'BRAND_CARD') {
    score -= 30;
    reasons.push('brand card is a designed fallback');
  }

  return { candidate, score, reasons };
}

export interface SelectSourcesOptions {
  readonly request: CampaignRequest;
  readonly shots: readonly ScriptedShot[];
  readonly assets: readonly ResolvedAsset[];
}

export function selectSources(options: SelectSourcesOptions): readonly ShotSelection[] {
  const vocabulary = relevanceVocabulary(options.request);
  const used = new Set<string>();
  const selections: ShotSelection[] = [];
  let featureOrdinal = 0;

  for (const shot of options.shots) {
    const storyBeat = storyBeatFor(shot.beat, featureOrdinal);
    if (shot.beat !== 'HOOK' && shot.beat !== 'PROMISE' && shot.beat !== 'CTA') {
      featureOrdinal += 1;
    }

    const scored = options.assets
      .map((candidate) => scoreCandidate(candidate, shot, storyBeat, vocabulary, used))
      .filter((entry): entry is ScoredCandidate => entry !== null)
      // Descending score, then ascending asset id. The id tie-break is what
      // makes two runs of the same request byte-identical.
      .sort((a, b) =>
        b.score === a.score
          ? a.candidate.asset.id.localeCompare(b.candidate.asset.id)
          : b.score - a.score,
      );

    const winner = scored[0];
    if (!winner) {
      const brandCard = options.assets
        .filter((entry) => entry.asset.role === 'BRAND_CARD')
        .sort((a, b) => a.asset.id.localeCompare(b.asset.id))[0];
      if (!brandCard) {
        throw new MissingShotSourceError(
          shot.index,
          storyBeat,
          `no asset can fill a ${shot.durationSeconds.toFixed(2)}s shot, and the library has no BRAND_CARD fallback`,
        );
      }
      used.add(brandCard.asset.id);
      selections.push({
        shot,
        storyBeat,
        asset: brandCard,
        score: 0,
        reasons: [
          'no asset matched this beat; used the designed brand card rather than unrelated footage',
        ],
        usedBrandCardFallback: true,
      });
      continue;
    }

    used.add(winner.candidate.asset.id);
    selections.push({
      shot,
      storyBeat,
      asset: winner.candidate,
      score: winner.score,
      reasons: winner.reasons,
      usedBrandCardFallback: winner.candidate.asset.role === 'BRAND_CARD',
    });
  }

  return selections;
}

/** The rows the run's source-selection report is built from. */
export function describeSelections(
  selections: readonly ShotSelection[],
): readonly Record<string, unknown>[] {
  return selections.map((selection) => ({
    shotIndex: selection.shot.index,
    scriptedBeat: selection.shot.beat,
    storyBeat: selection.storyBeat,
    shotDescription: selection.shot.description,
    shotDurationSeconds: selection.shot.durationSeconds,
    assetId: selection.asset.asset.id,
    assetRole: selection.asset.asset.role,
    assetPath: selection.asset.absolutePath,
    assetChecksumSha256: selection.asset.checksumSha256,
    rightsClassification: selection.asset.asset.rights.classification,
    score: selection.score,
    reasons: selection.reasons,
    usedBrandCardFallback: selection.usedBrandCardFallback,
  }));
}

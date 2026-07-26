import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson } from '@combat/domain';

import { sha256Of, type BenchmarkArmKey } from './experiment';

/**
 * The controlled comparison, computed from what each arm left on disk.
 *
 * Deliberately reads `agent-outputs.json`, `render-manifest.json`,
 * `creative-memory-provenance.json`, `originality-report.json` and the QA
 * report rather than holding the arms' in-memory state. Two reasons: the
 * comparison can be re-derived from a finished run months later, and if an
 * artefact is not sufficient to compare on, that is a defect in the artefact
 * worth discovering here.
 *
 * Every field is a **measurement or a structural fact**. Nothing in this file
 * ranks the arms, and `COMPARISON_NOTICE` travels on every report, because a
 * two-column table of differences reads as a verdict and is not one.
 */

export const COMPARISON_REPORT_VERSION = 1 as const;

export const COMPARISON_NOTICE =
  'DIFFERENCE IS NOT IMPROVEMENT. Every row below is a structural measurement of what changed when governed benchmark intelligence was injected. None of it is a judgement about whether the advertisement is better, and this system never makes that claim. Creative quality is recorded only in the human scorecard, and publication still requires the three human approval gates.' as const;

/** What one arm's artefacts say, reduced to comparable facts. */
export interface ArmFacts {
  readonly arm: BenchmarkArmKey;
  readonly creativeMemoryMode: string;
  readonly available: boolean;
  readonly missingArtefacts: readonly string[];

  // --- strategy and concept ------------------------------------------------
  readonly hookStrategy: string | null;
  readonly hookLatencySeconds: number | null;
  readonly narrativeArc: string | null;
  readonly keyMessageCount: number | null;

  // --- script and beats ----------------------------------------------------
  readonly beatCount: number | null;
  readonly beatDurationsSeconds: readonly number[];
  readonly beatNames: readonly string[];

  // --- shots ---------------------------------------------------------------
  readonly shotCount: number | null;
  readonly shotDurationsSeconds: readonly number[];
  readonly cameraMovements: readonly string[];
  readonly motionIntensities: readonly string[];
  readonly transitionsIn: readonly string[];
  readonly transitionsOut: readonly string[];

  // --- manifest ------------------------------------------------------------
  readonly manifestSceneCount: number | null;
  readonly manifestSceneDurationsSeconds: readonly number[];
  readonly manifestTransitions: readonly string[];
  readonly captionCount: number | null;
  readonly captionCharactersPerSecond: number | null;
  readonly ctaStartSeconds: number | null;
  readonly ctaDurationSeconds: number | null;
  readonly manifestSha256: string | null;

  // --- creative memory -----------------------------------------------------
  readonly retrievalCount: number;
  readonly referenceRolesQueried: readonly string[];
  readonly distinctReferencesUsed: number;
  readonly contextItemsInjected: number;

  // --- governance and output ----------------------------------------------
  readonly originalityRiskLevel: string | null;
  readonly originalityBlocked: boolean;
  readonly qaVerdict: string | null;
  readonly measuredDurationSeconds: number | null;
  readonly measuredResolution: string | null;
  readonly measuredCodecs: string | null;
  readonly outputChecksumSha256: string | null;
  readonly costEstimateCents: number;
  readonly costActualCents: number;
  readonly costBasis: string;
}

type Json = Record<string, unknown>;

async function readJson(directory: string, filename: string): Promise<Json | null> {
  try {
    return JSON.parse(await readFile(join(directory, filename), 'utf8')) as Json;
  } catch {
    return null;
  }
}

function numbers(value: unknown, pick: (entry: Json) => unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => pick(entry as Json))
    .filter((entry): entry is number => typeof entry === 'number');
}

function strings(value: unknown, pick: (entry: Json) => unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => pick(entry as Json))
    .filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Hook latency: how long before the first cut.
 *
 * Taken from the plan's own first beat rather than from anything the reference
 * said, so it measures what this campaign does — which is the only thing worth
 * comparing between two arms of the same campaign.
 */
function hookLatencyFrom(shots: unknown, frameRate = 30): number | null {
  if (!Array.isArray(shots) || shots.length === 0) return null;
  const frames = (shots[0] as Json).durationFrames;
  return typeof frames === 'number' ? Number((frames / frameRate).toFixed(3)) : null;
}

export async function collectArmFacts(
  arm: BenchmarkArmKey,
  creativeMemoryMode: string,
  runDirectory: string,
): Promise<ArmFacts> {
  const [agents, manifest, memory, originality, summary, provenance] = await Promise.all([
    readJson(runDirectory, 'agent-outputs.json'),
    readJson(runDirectory, 'render-manifest.json'),
    readJson(runDirectory, 'creative-memory-provenance.json'),
    readJson(runDirectory, 'originality-report.json'),
    readJson(runDirectory, 'run-summary.json'),
    readJson(runDirectory, 'aamp-run-provenance.json'),
  ]);

  const missing = [
    agents ? null : 'agent-outputs.json',
    manifest ? null : 'render-manifest.json',
    originality ? null : 'originality-report.json',
  ].filter((entry): entry is string => entry !== null);

  const strategy = (agents?.strategy as Json | undefined)?.strategy as Json | undefined;
  const concept = agents?.concept as Json | undefined;
  const script = agents?.script as Json | undefined;
  const briefs = agents?.shotBriefs;
  const scenes = manifest?.scenes;
  const captions = manifest?.captions;
  const cta = manifest?.cta as Json | undefined;
  const output = manifest?.output as Json | undefined;

  const retrievals = (memory?.retrievals as unknown[] | undefined) ?? [];
  const injected = retrievals.filter(
    (entry) => (entry as Json).governanceDecision === 'CONTEXT_INJECTED',
  );
  const distinctReferences = new Set(
    injected.flatMap((entry) =>
      (((entry as Json).items as unknown[] | undefined) ?? []).map(
        (item) => (item as Json).referenceId as string,
      ),
    ),
  );
  const rolesQueried = new Set(
    retrievals.flatMap(
      (entry) => ((entry as Json).referenceRolesQueried as string[] | undefined) ?? [],
    ),
  );

  const captionLines: Json[] = Array.isArray(captions) ? (captions as Json[]) : [];
  const totalCaptionCharacters = captionLines.reduce<number>(
    (sum, caption) => sum + String(caption.text ?? '').length,
    0,
  );
  const totalDuration = typeof output?.durationSeconds === 'number' ? output.durationSeconds : null;

  return {
    arm,
    creativeMemoryMode,
    available: missing.length === 0,
    missingArtefacts: missing,

    hookStrategy:
      typeof strategy?.keyMessages === 'object' && Array.isArray(strategy.keyMessages)
        ? ((strategy.keyMessages as string[])[0] ?? null)
        : null,
    hookLatencySeconds: hookLatencyFrom(script?.shots),
    narrativeArc: typeof concept?.narrativeArc === 'string' ? concept.narrativeArc : null,
    keyMessageCount: Array.isArray(strategy?.keyMessages) ? strategy.keyMessages.length : null,

    beatCount: Array.isArray(script?.shots) ? script.shots.length : null,
    beatDurationsSeconds: numbers(script?.shots, (entry) => entry.durationFrames).map((frames) =>
      Number((frames / 30).toFixed(3)),
    ),
    beatNames: strings(script?.shots, (entry) => entry.beat),

    shotCount: Array.isArray(briefs) ? briefs.length : null,
    shotDurationsSeconds: numbers(script?.shots, (entry) => entry.durationFrames).map((frames) =>
      Number((frames / 30).toFixed(3)),
    ),
    cameraMovements: strings(briefs, (entry) => entry.cameraMovement),
    motionIntensities: strings(briefs, (entry) => entry.motionIntensity),
    transitionsIn: strings(briefs, (entry) => entry.transitionIn),
    transitionsOut: strings(briefs, (entry) => entry.transitionOut),

    manifestSceneCount: Array.isArray(scenes) ? scenes.length : null,
    manifestSceneDurationsSeconds: numbers(scenes, (entry) => entry.durationSeconds),
    manifestTransitions: strings(scenes, (entry) => (entry.transitionIn as Json)?.type),
    captionCount: captionLines.length,
    captionCharactersPerSecond:
      totalDuration && totalDuration > 0
        ? Number((totalCaptionCharacters / totalDuration).toFixed(2))
        : null,
    ctaStartSeconds: typeof cta?.startSeconds === 'number' ? cta.startSeconds : null,
    ctaDurationSeconds: typeof cta?.durationSeconds === 'number' ? cta.durationSeconds : null,
    manifestSha256: manifest ? sha256Of(canonicalJson(manifest)) : null,

    retrievalCount: retrievals.length,
    referenceRolesQueried: [...rolesQueried].sort(),
    distinctReferencesUsed: distinctReferences.size,
    contextItemsInjected: injected.reduce<number>(
      (sum, entry) => sum + (((entry as Json).items as unknown[] | undefined)?.length ?? 0),
      0,
    ),

    originalityRiskLevel: typeof originality?.riskLevel === 'string' ? originality.riskLevel : null,
    originalityBlocked: originality?.blocked === true,
    qaVerdict: typeof provenance?.qaVerdict === 'string' ? provenance.qaVerdict : null,
    measuredDurationSeconds:
      typeof (summary?.measured as Json | undefined)?.durationSeconds === 'number'
        ? ((summary?.measured as Json).durationSeconds as number)
        : null,
    measuredResolution:
      (summary?.measured as Json | undefined)?.widthPx !== undefined
        ? `${(summary?.measured as Json).widthPx}x${(summary?.measured as Json).heightPx}`
        : null,
    measuredCodecs:
      (summary?.measured as Json | undefined)?.videoCodec !== undefined
        ? `${(summary?.measured as Json).videoCodec} / ${(summary?.measured as Json).audioCodec}`
        : null,
    outputChecksumSha256:
      typeof provenance?.outputChecksumSha256 === 'string' ? provenance.outputChecksumSha256 : null,
    costEstimateCents:
      typeof provenance?.costEstimateCents === 'number' ? provenance.costEstimateCents : 0,
    costActualCents:
      typeof provenance?.costActualCents === 'number' ? provenance.costActualCents : 0,
    costBasis: typeof provenance?.costBasis === 'string' ? provenance.costBasis : 'UNKNOWN',
  };
}

export const COMPARISON_DIMENSIONS = [
  'hook strategy',
  'hook latency',
  'narrative arc',
  'beat count',
  'beat timing',
  'shot count',
  'shot durations',
  'camera movement',
  'motion design',
  'transitions',
  'caption density',
  'CTA timing',
  'CTA duration',
  'reference roles',
  'reference diversity',
  'originality risk',
  'manifest',
  'actual-media QA',
  'cost',
] as const;
export type ComparisonDimension = (typeof COMPARISON_DIMENSIONS)[number];

export interface DimensionComparison {
  readonly dimension: ComparisonDimension;
  readonly off: string;
  readonly required: string;
  readonly changed: boolean;
  /** `STRUCTURE` for plan/manifest facts, `MEASUREMENT` for facts read off the produced file. */
  readonly kind: 'STRUCTURE' | 'MEASUREMENT';
}

export interface ComparisonReport {
  readonly reportVersion: typeof COMPARISON_REPORT_VERSION;
  readonly experimentId: string;
  readonly campaignName: string;
  readonly comparedAt: string;
  readonly off: ArmFacts;
  readonly required: ArmFacts;
  readonly dimensions: readonly DimensionComparison[];
  readonly changedDimensions: readonly ComparisonDimension[];
  readonly unchangedDimensions: readonly ComparisonDimension[];
  readonly offPerformedNoRetrieval: boolean;
  readonly notice: string;
  readonly reportChecksumSha256: string;
}

const show = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join(', ');
  return String(value);
};

function compare(
  dimension: ComparisonDimension,
  kind: DimensionComparison['kind'],
  off: unknown,
  required: unknown,
): DimensionComparison {
  const left = show(off);
  const right = show(required);
  return { dimension, off: left, required: right, changed: left !== right, kind };
}

export function buildComparisonReport(input: {
  readonly experimentId: string;
  readonly campaignName: string;
  readonly comparedAt: Date;
  readonly off: ArmFacts;
  readonly required: ArmFacts;
}): ComparisonReport {
  const { off, required } = input;
  const dimensions: DimensionComparison[] = [
    compare('hook strategy', 'STRUCTURE', off.hookStrategy, required.hookStrategy),
    compare('hook latency', 'STRUCTURE', off.hookLatencySeconds, required.hookLatencySeconds),
    compare('narrative arc', 'STRUCTURE', off.narrativeArc, required.narrativeArc),
    compare('beat count', 'STRUCTURE', off.beatCount, required.beatCount),
    compare('beat timing', 'STRUCTURE', off.beatDurationsSeconds, required.beatDurationsSeconds),
    compare('shot count', 'STRUCTURE', off.shotCount, required.shotCount),
    compare('shot durations', 'STRUCTURE', off.shotDurationsSeconds, required.shotDurationsSeconds),
    compare('camera movement', 'STRUCTURE', off.cameraMovements, required.cameraMovements),
    compare('motion design', 'STRUCTURE', off.motionIntensities, required.motionIntensities),
    compare(
      'transitions',
      'STRUCTURE',
      [...off.transitionsIn, ...off.manifestTransitions],
      [...required.transitionsIn, ...required.manifestTransitions],
    ),
    compare(
      'caption density',
      'STRUCTURE',
      off.captionCharactersPerSecond,
      required.captionCharactersPerSecond,
    ),
    compare('CTA timing', 'STRUCTURE', off.ctaStartSeconds, required.ctaStartSeconds),
    compare('CTA duration', 'STRUCTURE', off.ctaDurationSeconds, required.ctaDurationSeconds),
    compare(
      'reference roles',
      'STRUCTURE',
      off.referenceRolesQueried,
      required.referenceRolesQueried,
    ),
    compare(
      'reference diversity',
      'STRUCTURE',
      off.distinctReferencesUsed,
      required.distinctReferencesUsed,
    ),
    compare(
      'originality risk',
      'STRUCTURE',
      off.originalityRiskLevel,
      required.originalityRiskLevel,
    ),
    compare('manifest', 'STRUCTURE', off.manifestSha256, required.manifestSha256),
    compare(
      'actual-media QA',
      'MEASUREMENT',
      `${show(off.qaVerdict)} ${show(off.measuredResolution)} ${show(off.measuredDurationSeconds)}s`,
      `${show(required.qaVerdict)} ${show(required.measuredResolution)} ${show(required.measuredDurationSeconds)}s`,
    ),
    compare(
      'cost',
      'MEASUREMENT',
      `${off.costActualCents}c (${off.costBasis})`,
      `${required.costActualCents}c (${required.costBasis})`,
    ),
  ];

  const body = {
    reportVersion: COMPARISON_REPORT_VERSION,
    experimentId: input.experimentId,
    campaignName: input.campaignName,
    comparedAt: input.comparedAt.toISOString(),
    off,
    required,
    dimensions,
    changedDimensions: dimensions.filter((entry) => entry.changed).map((entry) => entry.dimension),
    unchangedDimensions: dimensions
      .filter((entry) => !entry.changed)
      .map((entry) => entry.dimension),
    offPerformedNoRetrieval: off.retrievalCount === 0,
    notice: COMPARISON_NOTICE,
  };

  return { ...body, reportChecksumSha256: sha256Of(canonicalJson(body)) };
}

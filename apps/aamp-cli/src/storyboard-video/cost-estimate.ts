import {
  ltxCentsPerGeneratedSecond,
  ltxGenerationCostCents,
  LTX_PRICING_PROFILE_VERSION,
  smallestCoveringDuration,
  type LtxDurationSeconds,
  type LtxModel,
} from '@combat/providers';

import { StoryboardVideoError } from './failures';
import type { SceneSourceDecision } from './source-precedence';

/**
 * What this run will cost, computed and shown before anything is uploaded.
 *
 * The ordering is the whole point. The estimate is built from the resolved
 * source decisions, printed per scene and in total, written to the run
 * directory, and compared against `--max-cost-cents` **before the first
 * upload**. An operator who set a ceiling too low finds out having spent
 * nothing, which is the only useful moment to find out.
 *
 * It is a *maximum*, not a forecast. Every generative scene is priced at the
 * full duration it will request, because LTX bills the clip it produced and a
 * scene that keeps two seconds of a six-second generation still paid for six.
 * Understating that would make the ceiling protect less than it appears to.
 */

export interface SceneCostLine {
  readonly sceneNumber: number;
  readonly sceneRole: string;
  readonly willGenerate: boolean;
  /** Slot plus transition handles — what the scene needs from the clip. */
  readonly requiredSourceSeconds: number;
  /** The smallest supported duration covering it. Null when nothing is generated. */
  readonly requestedDurationSeconds: LtxDurationSeconds | null;
  readonly costCents: number;
  readonly reason: string;
}

export interface CostEstimate {
  readonly pricingProfileVersion: typeof LTX_PRICING_PROFILE_VERSION;
  readonly model: LtxModel;
  readonly resolution: string;
  readonly centsPerGeneratedSecond: number;
  readonly lines: readonly SceneCostLine[];
  readonly generatedSceneCount: number;
  readonly totalGeneratedSeconds: number;
  readonly maximumTotalCostCents: number;
  readonly ceilingCents: number;
  readonly withinCeiling: boolean;
  /** Stated explicitly rather than inferred from a zero total. */
  readonly currency: 'USD';
}

export interface BuildCostEstimateInput {
  readonly decisions: readonly SceneSourceDecision[];
  readonly model: LtxModel;
  readonly resolution: string;
  readonly ceilingCents: number;
  readonly requiredSourceSecondsForScene: (sceneNumber: number) => number;
  /**
   * Scenes a byte-verified cached generation already covers.
   *
   * The estimate exists to say what the run will *spend*, and a scene served
   * from cache spends nothing — it makes no request at all, not even a status
   * check. Counting it anyway was not a conservative over-estimate: it made
   * both ceilings describe a run that was not the one about to happen, so
   * neither could notice when a broken cache turned a free re-run into a
   * second full purchase. The set is computed from the same key the generation
   * stage uses, so the two cannot disagree.
   */
  readonly alreadyCachedScenes?: ReadonlySet<number>;
}

export function buildCostEstimate(input: BuildCostEstimateInput): CostEstimate {
  const centsPerGeneratedSecond = ltxCentsPerGeneratedSecond(input.model, input.resolution);
  const cached = input.alreadyCachedScenes ?? new Set<number>();
  const lines: SceneCostLine[] = [];

  for (const decision of [...input.decisions].sort((a, b) => a.sceneNumber - b.sceneNumber)) {
    const requiredSourceSeconds = input.requiredSourceSecondsForScene(decision.sceneNumber);
    if (decision.requiresGeneration && cached.has(decision.sceneNumber)) {
      lines.push({
        sceneNumber: decision.sceneNumber,
        sceneRole: decision.sceneRole,
        willGenerate: false,
        requiredSourceSeconds,
        requestedDurationSeconds: null,
        costCents: 0,
        reason:
          'a byte-verified cached generation already covers this scene — no upload, no request, no charge',
      });
      continue;
    }
    if (!decision.requiresGeneration) {
      lines.push({
        sceneNumber: decision.sceneNumber,
        sceneRole: decision.sceneRole,
        willGenerate: false,
        requiredSourceSeconds,
        requestedDurationSeconds: null,
        costCents: 0,
        reason: `${decision.selectedSourceType} — no paid generation`,
      });
      continue;
    }

    const requestedDurationSeconds = smallestCoveringDuration(requiredSourceSeconds);
    lines.push({
      sceneNumber: decision.sceneNumber,
      sceneRole: decision.sceneRole,
      willGenerate: true,
      requiredSourceSeconds,
      requestedDurationSeconds,
      costCents: ltxGenerationCostCents(input.model, input.resolution, requestedDurationSeconds),
      reason: `LTX ${input.model} at ${input.resolution}, ${requestedDurationSeconds}s (the smallest supported duration covering ${requiredSourceSeconds.toFixed(2)}s)`,
    });
  }

  const maximumTotalCostCents = lines.reduce((sum, line) => sum + line.costCents, 0);
  const totalGeneratedSeconds = lines.reduce(
    (sum, line) => sum + (line.requestedDurationSeconds ?? 0),
    0,
  );

  return {
    pricingProfileVersion: LTX_PRICING_PROFILE_VERSION,
    model: input.model,
    resolution: input.resolution,
    centsPerGeneratedSecond,
    lines,
    generatedSceneCount: lines.filter((line) => line.willGenerate).length,
    totalGeneratedSeconds,
    maximumTotalCostCents,
    ceilingCents: input.ceilingCents,
    withinCeiling: maximumTotalCostCents <= input.ceilingCents,
    currency: 'USD',
  };
}

/**
 * Refuses the run when the ceiling cannot cover the estimate.
 *
 * Called before the first upload, and it names the shortfall rather than
 * saying "too expensive" — an operator raising a ceiling needs to know what to
 * raise it to.
 */
export function assertWithinCostCeiling(estimate: CostEstimate): void {
  if (estimate.withinCeiling) return;
  throw new StoryboardVideoError(
    'COST_CEILING_EXCEEDED',
    `this run would cost up to ${estimate.maximumTotalCostCents}¢ (${estimate.generatedSceneCount} generated scene(s), ${estimate.totalGeneratedSeconds}s at ${estimate.centsPerGeneratedSecond}¢/s for ${estimate.model}) but --max-cost-cents is ${estimate.ceilingCents}¢. Nothing has been uploaded and nothing has been spent. Raise the ceiling to at least ${estimate.maximumTotalCostCents} or reduce the number of generated scenes.`,
  );
}

/**
 * Refuses a run that would make more billable submissions than authorised.
 *
 * A second ceiling beside the money one, and it exists because the two fail
 * differently. A routing mistake that turns four deterministic scenes into
 * generations stays under a generous cost ceiling while quadrupling the number
 * of paid requests; only a ceiling denominated in requests notices. Checked
 * before the first upload, and it names both numbers rather than saying "too
 * many".
 */
export function assertWithinGenerationCeiling(
  estimate: CostEstimate,
  maxGenerations: number | undefined,
): void {
  if (maxGenerations === undefined) return;
  if (estimate.generatedSceneCount <= maxGenerations) return;
  const scenes = estimate.lines
    .filter((line) => line.willGenerate)
    .map((line) => line.sceneNumber)
    .join(', ');
  throw new StoryboardVideoError(
    'COST_CEILING_EXCEEDED',
    `this run would make ${estimate.generatedSceneCount} billable submission(s) (scenes ${scenes}) but --max-generations is ${maxGenerations}. Nothing has been uploaded and nothing has been spent. Either the routing is wrong — check which scenes resolved to LTX_GENERATED in source-decision-report.json — or raise the ceiling deliberately.`,
  );
}

/** Human-readable, for the operator to read before authorising the spend. */
export function describeCostEstimate(estimate: CostEstimate): string {
  const rows = estimate.lines.map((line) => {
    const cost = line.willGenerate ? `${String(line.costCents).padStart(4)}¢` : '   0¢';
    const duration = line.requestedDurationSeconds ? `${line.requestedDurationSeconds}s` : '  —';
    return `  scene ${String(line.sceneNumber).padStart(2)}  ${cost}  ${duration.padStart(4)}  ${line.sceneRole.padEnd(26)} ${line.reason}`;
  });
  return [
    '',
    `cost estimate — LTX pricing profile v${estimate.pricingProfileVersion}, ${estimate.model} @ ${estimate.resolution}, ${estimate.centsPerGeneratedSecond}¢ per generated second`,
    ...rows,
    `  ${'total'.padStart(8)}  ${String(estimate.maximumTotalCostCents).padStart(4)}¢ over ${estimate.generatedSceneCount} generated scene(s), ${estimate.totalGeneratedSeconds}s bought`,
    `  ceiling   ${String(estimate.ceilingCents).padStart(4)}¢  (--max-cost-cents)`,
    `  This is a maximum, not a forecast: LTX bills the clip it produced, so footage bought and not used is still paid for.`,
    '',
  ].join('\n');
}

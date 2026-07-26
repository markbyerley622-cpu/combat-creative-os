import { createHash } from 'node:crypto';

import { canonicalJson } from '@combat/domain';

import type { CampaignRequest } from '../campaign-request';
import type { AampExecutionMode, DependencyEvidence } from '../production/aamp-execution-mode';
import { portableRequest } from '../production/campaign-run-provenance';
import type { ProviderIdentity } from '../production/provider-identity';

/**
 * A controlled Creative Memory experiment: the same campaign, planned twice.
 *
 * The point of the contract is the word *controlled*. Two runs that differ in
 * more than one thing prove nothing, so the experiment holds the immutable
 * inputs **once** and both arms are handed the same frozen object — and each
 * arm records the hash it actually received, so a difference in inputs is
 * detectable rather than assumed away.
 *
 * The contract lives here rather than in `packages/domain` because it names
 * `CampaignRequest`, `AampExecutionMode` and `DependencyEvidence`, all of which
 * are `apps/aamp-cli` concepts. Putting it in the domain package would drag
 * app-level types across a dependency edge that deliberately runs the other
 * way. If a dashboard ever needs it, that is the moment to lift the shared part
 * into a versioned domain schema — not before.
 */

export const CREATIVE_BENCHMARK_EXPERIMENT_VERSION = 1 as const;

export const BENCHMARK_ARM_KEYS = ['OFF', 'REQUIRED'] as const;
export type BenchmarkArmKey = (typeof BENCHMARK_ARM_KEYS)[number];

export const EXPERIMENT_STATUSES = [
  'PLANNED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'BLOCKED_BY_ORIGINALITY',
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const COMPARISON_STATUSES = [
  'NOT_PRODUCED',
  'STRUCTURAL_ONLY',
  'STRUCTURAL_AND_MEDIA',
] as const;
export type ComparisonStatus = (typeof COMPARISON_STATUSES)[number];

export const HUMAN_REVIEW_STATUSES = [
  'AWAITING_HUMAN_REVIEW',
  'PARTIALLY_SCORED',
  'SCORED',
] as const;
export type HumanReviewStatus = (typeof HUMAN_REVIEW_STATUSES)[number];

/**
 * Everything both arms must receive identically, hashed as one unit.
 *
 * `productionAssetsSha256` covers the manifest's bytes rather than its path:
 * two arms pointed at the same path on a machine where the file changed
 * between them are *not* controlled, and only a content hash notices.
 */
export interface ImmutableExperimentInputs {
  readonly campaignRequest: CampaignRequest;
  readonly requestHashSha256: string;
  readonly promptSha256: string;
  readonly productionAssetsPath: string;
  readonly productionAssetsSha256: string;
  readonly platform: string;
  readonly targetDurationSeconds: number;
}

/**
 * The knobs held constant across both arms, recorded so a later reader can
 * check they were held rather than take it on trust.
 */
export interface ControlledSettings {
  readonly reasoningProfile: string;
  readonly reasoningModel: string;
  readonly reasoningDeterministic: boolean;
  readonly agentPromptVersions: readonly string[];
  readonly generationProfile: string | null;
  readonly renderProvider: string;
  readonly renderSettings: {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly frameRate: number;
    readonly targetDurationSeconds: number;
  };
  readonly qaConfiguration: string;
  /**
   * The seed, when the selected provider supports one. `null` — not `0` — when
   * it does not: a fabricated seed would imply a reproducibility guarantee the
   * provider never offered.
   */
  readonly deterministicSeed: number | null;
}

export interface BenchmarkArm {
  readonly key: BenchmarkArmKey;
  readonly creativeMemoryMode: 'off' | 'required';
  readonly runDirectory: string;
  readonly workflowRunId: string;
  /** Recorded per arm and compared. Identical values are what makes this controlled. */
  readonly receivedRequestHashSha256: string;
  readonly receivedAssetsSha256: string;
  readonly exitCode: number;
  readonly outputPath: string | null;
  readonly outputChecksumSha256: string | null;
  readonly qaVerdict: string | null;
  readonly renderSkipped: boolean;
  readonly originalityRiskLevel: string | null;
  readonly originalityBlocked: boolean;
  readonly retrievalCount: number;
  readonly failure: string | null;
}

export interface CreativeBenchmarkExperiment {
  readonly experimentVersion: typeof CREATIVE_BENCHMARK_EXPERIMENT_VERSION;
  readonly experimentId: string;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly inputs: ImmutableExperimentInputs;
  readonly benchmarkProfileName: string | null;
  readonly benchmarkProfileVersions: readonly {
    readonly agentRole: string;
    readonly profileId: string;
    readonly version: number;
    readonly governingChecksumSha256: string;
  }[];
  readonly requestedExecutionMode: AampExecutionMode | null;
  readonly executionMode: AampExecutionMode;
  readonly evidence: DependencyEvidence;
  readonly providers: readonly ProviderIdentity[];
  readonly controlled: ControlledSettings;
  readonly arms: readonly BenchmarkArm[];
  readonly status: ExperimentStatus;
  readonly comparisonStatus: ComparisonStatus;
  readonly humanReviewStatus: HumanReviewStatus;
  readonly paidProvidersAuthorised: boolean;
  readonly paidProviderAuthorisation: string | null;
  readonly estimatedMaximumCostCents: number | null;
  readonly actualCostCents: number | null;
  readonly costBasis: string;
  readonly comparisonReportSha256: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  /**
   * The claim this experiment does and does not support. Written on every
   * experiment, because a two-column table of differences reads as a verdict
   * and is not one.
   */
  readonly interpretation: string;
  readonly experimentChecksumSha256: string;
}

export function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The hash both arms must agree on.
 *
 * Derived from the *portable* request — the same projection the run provenance
 * uses — so it is machine-independent and two operators comparing notes are
 * comparing the same number.
 */
export function hashExperimentRequest(request: CampaignRequest): string {
  return sha256Of(canonicalJson(portableRequest(request)));
}

export const EXPERIMENT_INTERPRETATION =
  'This experiment measures whether governed benchmark intelligence CHANGES the plan and the output, not whether it IMPROVES them. A difference is a difference. Creative quality is a human judgement and is recorded only in the human scorecard.' as const;

export function computeExperimentChecksum(
  experiment: Omit<CreativeBenchmarkExperiment, 'experimentChecksumSha256'>,
): string {
  return sha256Of(canonicalJson(experiment));
}

export function sealExperiment(
  experiment: Omit<CreativeBenchmarkExperiment, 'experimentChecksumSha256'>,
): CreativeBenchmarkExperiment {
  return { ...experiment, experimentChecksumSha256: computeExperimentChecksum(experiment) };
}

export function verifyExperiment(experiment: CreativeBenchmarkExperiment): boolean {
  const { experimentChecksumSha256, ...rest } = experiment;
  return computeExperimentChecksum(rest) === experimentChecksumSha256;
}

export class ExperimentControlViolation extends Error {
  constructor(public readonly violations: readonly string[]) {
    super(
      `The two arms did not receive identical immutable inputs, so nothing can be concluded from their difference:\n  - ${violations.join(
        '\n  - ',
      )}`,
    );
    this.name = 'ExperimentControlViolation';
  }
}

/**
 * Refuses an experiment whose arms were not actually controlled.
 *
 * Called after both arms have run, not before: the guarantee that matters is
 * what each arm *received*, and only the arms can report that. An experiment
 * that fails this check is reported as failed rather than compared — a
 * comparison of two different briefs is worse than no comparison, because it
 * looks like evidence.
 */
export function assertArmsWereControlled(
  inputs: ImmutableExperimentInputs,
  arms: readonly BenchmarkArm[],
): void {
  const violations: string[] = [];
  const keys = new Set(arms.map((arm) => arm.key));
  if (!keys.has('OFF') || !keys.has('REQUIRED')) {
    violations.push(
      `expected an OFF arm and a REQUIRED arm, got ${[...keys].join(', ') || 'none'}`,
    );
  }
  for (const arm of arms) {
    if (arm.receivedRequestHashSha256 !== inputs.requestHashSha256) {
      violations.push(
        `arm ${arm.key} received request hash ${arm.receivedRequestHashSha256.slice(0, 12)}… but the experiment declares ${inputs.requestHashSha256.slice(0, 12)}…`,
      );
    }
    if (arm.receivedAssetsSha256 !== inputs.productionAssetsSha256) {
      violations.push(
        `arm ${arm.key} received assets hash ${arm.receivedAssetsSha256.slice(0, 12)}… but the experiment declares ${inputs.productionAssetsSha256.slice(0, 12)}…`,
      );
    }
  }
  const off = arms.find((arm) => arm.key === 'OFF');
  if (off && off.creativeMemoryMode !== 'off') {
    violations.push(`the OFF arm ran with creative memory "${off.creativeMemoryMode}"`);
  }
  if (off && off.retrievalCount !== 0) {
    violations.push(
      `the OFF arm performed ${off.retrievalCount} retrieval(s); it must perform none`,
    );
  }
  const required = arms.find((arm) => arm.key === 'REQUIRED');
  if (required && required.creativeMemoryMode !== 'required') {
    violations.push(`the REQUIRED arm ran with creative memory "${required.creativeMemoryMode}"`);
  }
  if (violations.length > 0) throw new ExperimentControlViolation(violations);
}

/**
 * Deep-freezes the request so neither arm can mutate what the other will read.
 *
 * Cheap insurance against the specific bug this experiment cannot survive: a
 * planning stage that normalises a field in place would silently make arm two's
 * input different from arm one's, and every difference in the report would then
 * be unattributable.
 */
export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const member of Object.values(value as Record<string, unknown>)) freezeDeep(member);
  return Object.freeze(value);
}

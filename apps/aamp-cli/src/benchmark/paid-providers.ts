import type { AampCliEnv } from '@combat/config';

/**
 * The gate in front of anything that costs money.
 *
 * Four conditions, all required, none of them defaulted:
 *
 * 1. a real provider is actually configured;
 * 2. the operator passed `--allow-paid-providers` on this invocation;
 * 3. an estimated **maximum** cost could be computed — and it is printed
 *    before the first call, not after the last;
 * 4. the authorisation is recorded in the experiment's provenance.
 *
 * Condition 3 is the one that does the real work. Without a declared price
 * there is no ceiling to print, so the run is refused rather than authorised
 * against an unknown number. Prices are declared by the operator
 * (`BENCHMARK_INPUT_COST_CENTS_PER_MTOK` / `..._OUTPUT_...`) rather than
 * hardcoded, because a stale table in this repository would turn "no accidental
 * spend" into "no accidental spend as of whenever someone last checked".
 *
 * CI and tests are structurally incapable of a paid call: `authorisePaidProviders`
 * only ever *returns* an authorisation, and the benchmark runner constructs a
 * real reasoning provider only when it holds one. Nothing in the test suite
 * passes `allowPaidProviders`, and a test asserts the refusal path.
 */

export const PAID_PROVIDER_REFUSALS = [
  'NOT_REQUESTED',
  'NO_REAL_PROVIDER_CONFIGURED',
  'NO_DECLARED_PRICES',
  'ESTIMATE_EXCEEDS_CEILING',
] as const;
export type PaidProviderRefusal = (typeof PAID_PROVIDER_REFUSALS)[number];

/**
 * How much work the experiment will ask a model to do, at its ceiling.
 *
 * Deliberately an over-estimate: the number's job is to be a figure an operator
 * would refuse if it were wrong, and an optimistic estimate cannot do that.
 */
export interface WorkloadEstimate {
  readonly arms: number;
  readonly agentInvocationsPerArm: number;
  readonly maxTokensInPerInvocation: number;
  readonly maxTokensOutPerInvocation: number;
}

export const DEFAULT_WORKLOAD: WorkloadEstimate = {
  arms: 2,
  // Strategist, director, script/timing, plus one shot-prompt call per shot.
  // Eight beats is the script agent's ceiling, so eleven is the worst case.
  agentInvocationsPerArm: 11,
  maxTokensInPerInvocation: 24_000,
  maxTokensOutPerInvocation: 4_000,
};

export interface CostEstimate {
  readonly totalInvocations: number;
  readonly maxTokensIn: number;
  readonly maxTokensOut: number;
  readonly inputCentsPerMTok: number;
  readonly outputCentsPerMTok: number;
  readonly estimatedMaximumCostCents: number;
}

/**
 * Computes the ceiling, or explains why it cannot.
 *
 * Rounded **up** to the cent for the same reason the workload is a ceiling: an
 * estimate that rounds in the spender's favour is not a safeguard.
 */
export function estimateMaximumCost(
  env: Pick<
    AampCliEnv,
    'BENCHMARK_INPUT_COST_CENTS_PER_MTOK' | 'BENCHMARK_OUTPUT_COST_CENTS_PER_MTOK'
  >,
  workload: WorkloadEstimate = DEFAULT_WORKLOAD,
): CostEstimate | null {
  const inputCentsPerMTok = env.BENCHMARK_INPUT_COST_CENTS_PER_MTOK;
  const outputCentsPerMTok = env.BENCHMARK_OUTPUT_COST_CENTS_PER_MTOK;
  if (inputCentsPerMTok === undefined || outputCentsPerMTok === undefined) return null;

  const totalInvocations = workload.arms * workload.agentInvocationsPerArm;
  const maxTokensIn = totalInvocations * workload.maxTokensInPerInvocation;
  const maxTokensOut = totalInvocations * workload.maxTokensOutPerInvocation;
  return {
    totalInvocations,
    maxTokensIn,
    maxTokensOut,
    inputCentsPerMTok,
    outputCentsPerMTok,
    estimatedMaximumCostCents: Math.ceil(
      (maxTokensIn / 1_000_000) * inputCentsPerMTok +
        (maxTokensOut / 1_000_000) * outputCentsPerMTok,
    ),
  };
}

export interface PaidProviderAuthorisation {
  readonly authorised: true;
  readonly providerName: string;
  readonly model: string;
  readonly estimate: CostEstimate;
  /** The sentence written into the experiment record and printed to the operator. */
  readonly statement: string;
}

export interface PaidProviderRefused {
  readonly authorised: false;
  readonly refusal: PaidProviderRefusal;
  readonly explanation: string;
  readonly estimate: CostEstimate | null;
}

export type PaidProviderDecision = PaidProviderAuthorisation | PaidProviderRefused;

export interface AuthorisePaidProvidersInput {
  readonly env: AampCliEnv;
  readonly allowPaidProviders: boolean;
  readonly at: Date;
  readonly operator: string;
  readonly workload?: WorkloadEstimate;
  /** An optional hard ceiling in cents. Refuses rather than warns. */
  readonly maximumCostCents?: number;
}

export function authorisePaidProviders(input: AuthorisePaidProvidersInput): PaidProviderDecision {
  const estimate = estimateMaximumCost(input.env, input.workload);

  if (!input.allowPaidProviders) {
    return {
      authorised: false,
      refusal: 'NOT_REQUESTED',
      explanation:
        '--allow-paid-providers was not supplied, so no paid provider call will be made. The benchmark will run with the deterministic context-aware fixture instead, and every report will say so.',
      estimate,
    };
  }

  if (input.env.REASONING_PROVIDER !== 'claude' || !input.env.ANTHROPIC_API_KEY?.trim()) {
    return {
      authorised: false,
      refusal: 'NO_REAL_PROVIDER_CONFIGURED',
      explanation:
        '--allow-paid-providers was supplied but no real reasoning provider is configured. Set REASONING_PROVIDER=claude and ANTHROPIC_API_KEY.',
      estimate,
    };
  }

  if (!estimate) {
    return {
      authorised: false,
      refusal: 'NO_DECLARED_PRICES',
      explanation:
        'No maximum cost could be computed, so nothing was authorised. Set BENCHMARK_INPUT_COST_CENTS_PER_MTOK and BENCHMARK_OUTPUT_COST_CENTS_PER_MTOK to the rates you believe apply. Paid work is never authorised against an unknown number.',
      estimate: null,
    };
  }

  if (
    input.maximumCostCents !== undefined &&
    estimate.estimatedMaximumCostCents > input.maximumCostCents
  ) {
    return {
      authorised: false,
      refusal: 'ESTIMATE_EXCEEDS_CEILING',
      explanation: `the estimated maximum of ${estimate.estimatedMaximumCostCents} cents exceeds the ceiling of ${input.maximumCostCents} cents`,
      estimate,
    };
  }

  return {
    authorised: true,
    providerName: 'claude',
    model: input.env.REASONING_MODEL,
    estimate,
    statement: `Paid providers authorised by ${input.operator} at ${input.at.toISOString()} for model ${input.env.REASONING_MODEL}. Estimated MAXIMUM cost ${estimate.estimatedMaximumCostCents} cents across ${estimate.totalInvocations} invocations (ceiling: ${estimate.maxTokensIn} input and ${estimate.maxTokensOut} output tokens at ${estimate.inputCentsPerMTok}/${estimate.outputCentsPerMTok} cents per million). Actual spend is not metered by this command.`,
  };
}

/** The line printed before the first paid call, and only before it. */
export function describeCostCeiling(estimate: CostEstimate): string {
  return [
    'ESTIMATED MAXIMUM COST FOR THIS BENCHMARK',
    `  invocations:            ${estimate.totalInvocations}`,
    `  input token ceiling:    ${estimate.maxTokensIn.toLocaleString('en-GB')}`,
    `  output token ceiling:   ${estimate.maxTokensOut.toLocaleString('en-GB')}`,
    `  declared rates:         ${estimate.inputCentsPerMTok} / ${estimate.outputCentsPerMTok} cents per million (in / out)`,
    `  ESTIMATED MAXIMUM:      ${estimate.estimatedMaximumCostCents} cents`,
    '  This is a ceiling from declared rates, not a quote, and not a measurement.',
  ].join('\n');
}

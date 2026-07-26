/**
 * Whether a run is allowed to use fixture reasoning, and what it must say
 * about it.
 *
 * The previous milestone made `REASONING_PROVIDER=mock` the *default* path for
 * `aamp:generate`, because the generic mock could not satisfy the agent
 * schemas and a command that needed a paid key to run at all was useless. That
 * was a reasonable trade then. It is the wrong default now: this milestone's
 * whole claim is that the advertisement is specific to the campaign prompt,
 * and fixture reasoning ignores the prompt entirely.
 *
 * So the polarity is inverted. A normal run **requires** a real reasoning
 * provider and fails before any rendering if it does not have one. Fixture
 * reasoning is still available — it is genuinely useful for exercising the
 * pipeline with no API key — but only when the operator asks for it by name,
 * and every artefact of such a run is stamped as a demonstration.
 */

export const RUN_MODES = [
  /** The real thing. Requires a configured reasoning provider. */
  'REAL',
  /** Explicitly requested demonstration. Replays committed fixtures; never a campaign result. */
  'FIXTURE_DEMO',
] as const;
export type RunMode = (typeof RUN_MODES)[number];

export class RealReasoningUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealReasoningUnavailableError';
  }
}

export interface ReasoningPolicyInput {
  readonly runMode: RunMode;
  readonly reasoningProvider: 'mock' | 'claude';
  readonly reasoningModel: string;
  readonly anthropicApiKey?: string;
}

export interface ReasoningPolicy {
  readonly runMode: RunMode;
  readonly useFixtureReasoning: boolean;
  /** The model actually asked for, or `NONE-FIXTURE-REPLAY` in demo mode. */
  readonly reasoningModel: string;
  readonly providerName: 'claude' | 'fixture-replay';
}

const FIXTURE_MODEL = 'NONE-FIXTURE-REPLAY';

/**
 * Decides how a run may reason, or refuses it.
 *
 * The two refusals are deliberately different errors, because they have
 * different fixes: "you asked for a real run without a provider" is a
 * configuration problem, while "you configured mock and did not ask for demo
 * mode" is a request-intent problem. Both name the exact flag or variable to
 * change — a refusal that does not tell you what to do is just an obstacle.
 */
export function resolveReasoningPolicy(input: ReasoningPolicyInput): ReasoningPolicy {
  if (input.runMode === 'FIXTURE_DEMO') {
    return {
      runMode: 'FIXTURE_DEMO',
      useFixtureReasoning: true,
      reasoningModel: FIXTURE_MODEL,
      providerName: 'fixture-replay',
    };
  }

  if (input.reasoningProvider === 'mock') {
    throw new RealReasoningUnavailableError(
      [
        'This run requires genuine reasoning, but REASONING_PROVIDER=mock is configured.',
        'Mock reasoning replays committed golden fixtures and ignores the campaign prompt entirely,',
        'so it cannot produce a prompt-specific advertisement.',
        '',
        'Either:',
        '  - set REASONING_PROVIDER=claude and ANTHROPIC_API_KEY to generate for real; or',
        '  - pass --fixture-demo to run the pipeline as an explicitly-labelled demonstration.',
      ].join('\n'),
    );
  }

  if (!input.anthropicApiKey?.trim()) {
    throw new RealReasoningUnavailableError(
      [
        'REASONING_PROVIDER=claude is selected but ANTHROPIC_API_KEY is not set.',
        'Refusing to start rather than silently falling back to fixture reasoning.',
        '',
        'Either set ANTHROPIC_API_KEY, or pass --fixture-demo to run an explicitly-labelled demonstration.',
      ].join('\n'),
    );
  }

  return {
    runMode: 'REAL',
    useFixtureReasoning: false,
    reasoningModel: input.reasoningModel,
    providerName: 'claude',
  };
}

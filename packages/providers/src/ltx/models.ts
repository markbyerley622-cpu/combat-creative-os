/**
 * What the LTX hosted API is permitted to be asked for, and what it costs.
 *
 * Everything here is a closed vocabulary on purpose. A hosted generation API
 * is the one place in this repository where a typo spends money, so the model
 * name, the resolution, the frame rate and the duration are all enumerated
 * rather than passed through: an unrecognised value is refused by name before
 * a request exists, not discovered from a 400 after an upload has already
 * happened.
 *
 * The two deprecated model names are listed explicitly rather than simply
 * being absent. `ltx-2-fast` is close enough to `ltx-2-3-fast` that "unknown
 * model" would read as a typo in our own code; naming the deprecation tells
 * the operator what to write instead.
 */

/** The only models this adapter will submit. */
export const LTX_SUPPORTED_MODELS = ['ltx-2-3-fast', 'ltx-2-3-pro'] as const;
export type LtxModel = (typeof LTX_SUPPORTED_MODELS)[number];

/**
 * Superseded names, refused by name.
 *
 * Each maps to the model that replaced it so the refusal is actionable — a
 * bare "unsupported model" is the kind of error an operator works around by
 * guessing.
 */
export const LTX_DEPRECATED_MODELS: ReadonlyMap<string, LtxModel> = new Map([
  ['ltx-2-fast', 'ltx-2-3-fast'],
  ['ltx-2-pro', 'ltx-2-3-pro'],
]);

/** The only resolution this milestone generates. Vertical, full frame. */
export const LTX_SUPPORTED_RESOLUTION = '1080x1920' as const;
export const LTX_SUPPORTED_WIDTH_PX = 1080 as const;
export const LTX_SUPPORTED_HEIGHT_PX = 1920 as const;

/** The only frame rate this milestone generates. */
export const LTX_SUPPORTED_FPS = 24 as const;

/**
 * The durations LTX-2.3 accepts, ascending.
 *
 * Six seconds is a floor, not a default: every storyboard scene in this
 * campaign is shorter than that, so every generative scene buys more footage
 * than it uses. The trim policy above this records exactly how much was
 * discarded rather than hiding it.
 */
export const LTX_SUPPORTED_DURATIONS_SECONDS = [6, 8, 10] as const;
export type LtxDurationSeconds = (typeof LTX_SUPPORTED_DURATIONS_SECONDS)[number];

export const LTX_MINIMUM_DURATION_SECONDS = 6 as const;

export class LtxModelSupportError extends Error {
  constructor(
    public readonly kind:
      | 'DEPRECATED_MODEL'
      | 'UNKNOWN_MODEL'
      | 'UNSUPPORTED_RESOLUTION'
      | 'UNSUPPORTED_FPS'
      | 'UNSUPPORTED_DURATION',
    message: string,
  ) {
    super(message);
    this.name = 'LtxModelSupportError';
  }
}

export function isLtxModel(value: string): value is LtxModel {
  return (LTX_SUPPORTED_MODELS as readonly string[]).includes(value);
}

/** Refuses a deprecated or unknown model with a message that says what to use. */
export function assertSupportedLtxModel(value: string): LtxModel {
  const replacement = LTX_DEPRECATED_MODELS.get(value);
  if (replacement) {
    throw new LtxModelSupportError(
      'DEPRECATED_MODEL',
      `"${value}" is a deprecated LTX model name and is refused. Use "${replacement}".`,
    );
  }
  if (!isLtxModel(value)) {
    throw new LtxModelSupportError(
      'UNKNOWN_MODEL',
      `"${value}" is not a supported LTX model. Supported: ${LTX_SUPPORTED_MODELS.join(', ')}.`,
    );
  }
  return value;
}

export function assertSupportedLtxResolution(value: string): typeof LTX_SUPPORTED_RESOLUTION {
  if (value !== LTX_SUPPORTED_RESOLUTION) {
    throw new LtxModelSupportError(
      'UNSUPPORTED_RESOLUTION',
      `LTX generation is restricted to ${LTX_SUPPORTED_RESOLUTION} in this milestone; "${value}" is refused.`,
    );
  }
  return LTX_SUPPORTED_RESOLUTION;
}

export function assertSupportedLtxFps(value: number): typeof LTX_SUPPORTED_FPS {
  if (value !== LTX_SUPPORTED_FPS) {
    throw new LtxModelSupportError(
      'UNSUPPORTED_FPS',
      `LTX generation is restricted to ${LTX_SUPPORTED_FPS} fps in this milestone; ${value} is refused.`,
    );
  }
  return LTX_SUPPORTED_FPS;
}

export function assertSupportedLtxDuration(value: number): LtxDurationSeconds {
  const match = LTX_SUPPORTED_DURATIONS_SECONDS.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new LtxModelSupportError(
      'UNSUPPORTED_DURATION',
      `LTX-2.3 accepts ${LTX_SUPPORTED_DURATIONS_SECONDS.join(', ')} second generations; ${value} is refused. Never stretch a shorter result to fit.`,
    );
  }
  return match;
}

/**
 * The smallest supported duration that covers `requiredSeconds`.
 *
 * "Smallest that covers" rather than "closest": buying nine seconds of footage
 * to use two is wasteful, and buying six to use eight is a shortfall that
 * would have to be papered over by stretching, which this milestone forbids
 * outright. A requirement above the largest supported duration is a refusal,
 * never a truncation.
 */
export function smallestCoveringDuration(requiredSeconds: number): LtxDurationSeconds {
  const match = LTX_SUPPORTED_DURATIONS_SECONDS.find(
    (candidate) => candidate + 1e-9 >= requiredSeconds,
  );
  if (match === undefined) {
    throw new LtxModelSupportError(
      'UNSUPPORTED_DURATION',
      `${requiredSeconds.toFixed(3)}s of source material is required, but the longest supported LTX generation is ${
        LTX_SUPPORTED_DURATIONS_SECONDS[LTX_SUPPORTED_DURATIONS_SECONDS.length - 1]
      }s. Shorten the scene or split it; a short result is never stretched to fit.`,
    );
  }
  return match;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Bumped whenever a rate changes. A cost estimate that cannot say which rate
 * card produced it is a number nobody can check later, and the operator
 * authorising a ceiling is entitled to know what they were quoted against.
 */
export const LTX_PRICING_PROFILE_VERSION = 1 as const;

export interface LtxPricingEntry {
  readonly model: LtxModel;
  readonly resolution: typeof LTX_SUPPORTED_RESOLUTION;
  readonly centsPerGeneratedSecond: number;
}

/**
 * The operator-declared rate card, in cents per *generated* second — not per
 * used second. LTX bills the clip it produced, and the storyboard scene that
 * uses two seconds of a six-second generation still pays for six.
 */
export const LTX_PRICING_PROFILE: readonly LtxPricingEntry[] = [
  { model: 'ltx-2-3-fast', resolution: LTX_SUPPORTED_RESOLUTION, centsPerGeneratedSecond: 6 },
  { model: 'ltx-2-3-pro', resolution: LTX_SUPPORTED_RESOLUTION, centsPerGeneratedSecond: 8 },
];

export class LtxPricingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LtxPricingUnavailableError';
  }
}

export function ltxCentsPerGeneratedSecond(model: LtxModel, resolution: string): number {
  const entry = LTX_PRICING_PROFILE.find(
    (candidate) => candidate.model === model && candidate.resolution === resolution,
  );
  if (!entry) {
    throw new LtxPricingUnavailableError(
      `No declared rate exists for ${model} at ${resolution}. A run is refused rather than authorised against an unknown price.`,
    );
  }
  return entry.centsPerGeneratedSecond;
}

/** Whole cents for one generation. Rounded up: nobody is billed a fraction in our favour. */
export function ltxGenerationCostCents(
  model: LtxModel,
  resolution: string,
  durationSeconds: number,
): number {
  return Math.ceil(ltxCentsPerGeneratedSecond(model, resolution) * durationSeconds);
}

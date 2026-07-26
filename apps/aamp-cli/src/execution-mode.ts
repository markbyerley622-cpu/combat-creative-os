/**
 * What actually produced a result — and therefore how much it is worth.
 *
 * This command has two independent substitution points: the reasoning provider
 * behind the specialist agents, and the video-generation provider behind the
 * shots. Either can be real or a fixture, so there are four combinations, and
 * they are *not* equivalent. A run whose creative came from committed golden
 * fixtures and whose "footage" came from an FFmpeg test pattern is a plumbing
 * demonstration; a run with a real model at both ends is an advertisement.
 *
 * Every CLI result names its mode, so nothing downstream — a reviewer, a
 * report, a future milestone — can mistake one for the other. That is the
 * whole point of this module: the failure this codebase is most exposed to is
 * not a crash, it is a plausible-looking MP4 being taken for genuine
 * prompt-driven generation.
 */

export const CLI_EXECUTION_MODES = [
  /** Real reasoning model, real ComfyUI generation. The only mode that is a real advertisement. */
  'REAL_REASONING_AND_REAL_GENERATION',
  /** Real creative decisions, placeholder footage. Useful for judging copy and structure, not visuals. */
  'REAL_REASONING_AND_FIXTURE_GENERATION',
  /** Canned creative, real generated footage. Useful for judging the model, not the campaign. */
  'FIXTURE_REASONING_AND_REAL_GENERATION',
  /** Nothing real. Proves the pipeline runs end to end and nothing else. */
  'FIXTURE_REASONING_AND_FIXTURE_GENERATION',
] as const;
export type CliExecutionMode = (typeof CLI_EXECUTION_MODES)[number];

export interface ExecutionModeInputs {
  readonly reasoningProvider: 'mock' | 'claude';
  readonly videoGenerationProvider: 'mock' | 'comfyui';
}

export function resolveExecutionMode(inputs: ExecutionModeInputs): CliExecutionMode {
  const realReasoning = inputs.reasoningProvider === 'claude';
  const realGeneration = inputs.videoGenerationProvider === 'comfyui';
  if (realReasoning && realGeneration) return 'REAL_REASONING_AND_REAL_GENERATION';
  if (realReasoning) return 'REAL_REASONING_AND_FIXTURE_GENERATION';
  if (realGeneration) return 'FIXTURE_REASONING_AND_REAL_GENERATION';
  return 'FIXTURE_REASONING_AND_FIXTURE_GENERATION';
}

/** True only for the one mode whose output may be described as a real advertisement. */
export function isFullyReal(mode: CliExecutionMode): boolean {
  return mode === 'REAL_REASONING_AND_REAL_GENERATION';
}

export function usesFixtureReasoning(mode: CliExecutionMode): boolean {
  return mode.startsWith('FIXTURE_REASONING');
}

export function usesFixtureGeneration(mode: CliExecutionMode): boolean {
  return mode.endsWith('FIXTURE_GENERATION');
}

/**
 * The banner printed on every run that is not fully real.
 *
 * Deliberately specific about *which* half is fake and what that invalidates,
 * because "this is a demo" is easy to skim past and "the creative ignores your
 * prompt" is not.
 */
export function describeExecutionMode(mode: CliExecutionMode): string {
  const caveats: string[] = [];
  if (usesFixtureReasoning(mode)) {
    caveats.push(
      'the creative is replayed from committed golden fixtures and ignores this manifest’s campaign prompt entirely (set REASONING_PROVIDER=claude for real reasoning)',
    );
  }
  if (usesFixtureGeneration(mode)) {
    caveats.push(
      'the shots are synthetic FFmpeg test patterns, not AI-generated footage (set VIDEO_GENERATION_PROVIDER=comfyui with a working endpoint for real generation)',
    );
  }
  if (caveats.length === 0) {
    return `${mode}: real reasoning and real generation.`;
  }
  return `${mode}: NOT A REAL ADVERTISEMENT — ${caveats.join('; and ')}.`;
}

/** Machine-readable provenance written beside every produced MP4. */
export interface ExecutionProvenance {
  readonly executionMode: CliExecutionMode;
  readonly reasoningProvider: string;
  readonly videoGenerationProvider: string;
  readonly workflowProfile: string;
  readonly campaignId: string;
  readonly workflowRunId: string;
  /** False for every mode except REAL_REASONING_AND_REAL_GENERATION. */
  readonly isRealAdvertisement: boolean;
  readonly caveat: string;
  readonly generatedShots: readonly {
    readonly shotId: string;
    readonly localPath: string;
    readonly checksumSha256: string;
    readonly measuredDurationSeconds: number;
    readonly measuredWidthPx: number;
    readonly measuredHeightPx: number;
    readonly measuredVideoCodec: string;
    readonly synthetic: boolean;
  }[];
}

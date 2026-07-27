import { describe, expect, it } from 'vitest';

import {
  AAMP_EXECUTION_MODES,
  describeExecutionEvidence,
  executionModeFlagFor,
  executionModeRank,
  parseExecutionModeFlag,
  resolveAttainedExecutionMode,
  satisfiesExecutionFloor,
  shortfallsFor,
  type DependencyEvidence,
} from './aamp-execution-mode';

/**
 * The label is the only thing standing between a local demonstration and a
 * result somebody publishes, so these tests are about one property above all
 * others: **nothing a caller says can raise the mode**. Every case here builds
 * evidence and asks what it supports; none of them can pass a requested mode
 * in, because the function does not accept one.
 */

const FULLY_REAL: DependencyEvidence = {
  persistence: 'PRISMA_POSTGRESQL',
  vectorSearch: 'QDRANT_LIVE',
  reasoning: 'REAL_MODEL',
  videoGeneration: 'NOT_REQUIRED',
  rendering: 'FFMPEG_REAL',
  qa: 'ACTUAL_MEDIA',
};

describe('execution mode flag parsing', () => {
  it('accepts the four kebab-case spellings and nothing else', () => {
    expect(parseExecutionModeFlag('human-assisted-preview')).toBe('HUMAN_ASSISTED_PREVIEW');
    expect(parseExecutionModeFlag('fixture')).toBe('FIXTURE');
    expect(parseExecutionModeFlag('local-production')).toBe('LOCAL_PRODUCTION');
    expect(parseExecutionModeFlag('PRODUCTION')).toBe('PRODUCTION');
    expect(parseExecutionModeFlag('prod')).toBeUndefined();
    expect(parseExecutionModeFlag('LOCAL_PRODUCTION')).toBeUndefined();
    expect(parseExecutionModeFlag(undefined)).toBeUndefined();
  });

  it('round-trips every mode through its flag spelling', () => {
    for (const mode of AAMP_EXECUTION_MODES) {
      expect(parseExecutionModeFlag(executionModeFlagFor(mode))).toBe(mode);
    }
  });

  it('ranks the modes so "at least local-production" is expressible', () => {
    expect(executionModeRank('FIXTURE')).toBeLessThan(executionModeRank('LOCAL_PRODUCTION'));
    expect(executionModeRank('LOCAL_PRODUCTION')).toBeLessThan(executionModeRank('PRODUCTION'));
  });
});

describe('the attained mode is derived from dependencies alone', () => {
  it('reaches PRODUCTION only when every needed dependency was real', () => {
    expect(resolveAttainedExecutionMode(FULLY_REAL)).toBe('PRODUCTION');
  });

  it('a source-only campaign needs no generation and still reaches PRODUCTION', () => {
    expect(resolveAttainedExecutionMode({ ...FULLY_REAL, videoGeneration: 'NOT_REQUIRED' })).toBe(
      'PRODUCTION',
    );
  });

  it('caps at LOCAL_PRODUCTION when the creative was replayed from fixtures', () => {
    const evidence = { ...FULLY_REAL, reasoning: 'FIXTURE_REPLAY' } as DependencyEvidence;
    expect(resolveAttainedExecutionMode(evidence)).toBe('LOCAL_PRODUCTION');
    expect(shortfallsFor('PRODUCTION', evidence)).toEqual([
      'reasoning provider was FIXTURE_REPLAY; PRODUCTION permits only REAL_MODEL',
    ]);
  });

  it('caps at LOCAL_PRODUCTION when the shots were synthetic test patterns', () => {
    expect(
      resolveAttainedExecutionMode({ ...FULLY_REAL, videoGeneration: 'FIXTURE_TEST_PATTERN' }),
    ).toBe('LOCAL_PRODUCTION');
  });

  it('falls to FIXTURE when persistence was in memory', () => {
    expect(resolveAttainedExecutionMode({ ...FULLY_REAL, persistence: 'IN_MEMORY' })).toBe(
      'FIXTURE',
    );
  });

  it('falls to FIXTURE when the vector search was in process', () => {
    expect(resolveAttainedExecutionMode({ ...FULLY_REAL, vectorSearch: 'IN_PROCESS' })).toBe(
      'FIXTURE',
    );
  });

  it('falls to FIXTURE when no usable renderer existed', () => {
    expect(
      resolveAttainedExecutionMode({ ...FULLY_REAL, rendering: 'UNAVAILABLE', qa: 'UNAVAILABLE' }),
    ).toBe('FIXTURE');
  });

  it('falls to FIXTURE when the render was driven by an injected command runner', () => {
    // The test seam is visible in the label, so a suite can never produce an
    // artefact that claims to have been rendered for real.
    expect(
      resolveAttainedExecutionMode({ ...FULLY_REAL, rendering: 'SIMULATED', qa: 'SIMULATED' }),
    ).toBe('FIXTURE');
  });

  it('reports every shortfall at once, not just the first', () => {
    const problems = shortfallsFor('PRODUCTION', {
      persistence: 'IN_MEMORY',
      vectorSearch: 'IN_PROCESS',
      reasoning: 'FIXTURE_REPLAY',
      videoGeneration: 'FIXTURE_TEST_PATTERN',
      rendering: 'SIMULATED',
      qa: 'SIMULATED',
    });
    expect(problems).toHaveLength(6);
  });
});

describe('the label a reader actually sees', () => {
  it('calls a fully real run a real campaign run', () => {
    const label = describeExecutionEvidence(FULLY_REAL);
    expect(label).toMatchObject({
      executionMode: 'PRODUCTION',
      isRealCampaignRun: true,
      demonstrationOnly: false,
      partiallySimulated: false,
    });
    expect(label.caveat).toContain('Human approval is still required');
  });

  it('calls a fixture-reasoning run partially simulated and names which half', () => {
    const label = describeExecutionEvidence({ ...FULLY_REAL, reasoning: 'FIXTURE_REPLAY' });
    expect(label).toMatchObject({
      executionMode: 'LOCAL_PRODUCTION',
      isRealCampaignRun: false,
      demonstrationOnly: false,
      partiallySimulated: true,
    });
    expect(label.caveat).toContain('PARTIALLY SIMULATED');
    expect(label.simulatedComponents).toContain('reasoning provider: FIXTURE_REPLAY');
    expect(label.realComponents).toContain('rendering: FFMPEG_REAL');
    expect(label.caveat).toContain('not a campaign result');
  });

  it('stamps an in-memory run DEMONSTRATION ONLY', () => {
    const label = describeExecutionEvidence({
      persistence: 'IN_MEMORY',
      vectorSearch: 'IN_PROCESS',
      reasoning: 'FIXTURE_REPLAY',
      videoGeneration: 'FIXTURE_TEST_PATTERN',
      rendering: 'SIMULATED',
      qa: 'SIMULATED',
    });
    expect(label.demonstrationOnly).toBe(true);
    expect(label.isRealCampaignRun).toBe(false);
    expect(label.caveat).toContain('DEMONSTRATION ONLY');
    expect(label.realComponents).toEqual([]);
  });

  it('never reports isRealCampaignRun for anything below PRODUCTION', () => {
    const substitutions: DependencyEvidence[] = [
      { ...FULLY_REAL, persistence: 'IN_MEMORY' },
      { ...FULLY_REAL, vectorSearch: 'IN_PROCESS' },
      { ...FULLY_REAL, reasoning: 'FIXTURE_REPLAY' },
      { ...FULLY_REAL, videoGeneration: 'FIXTURE_TEST_PATTERN' },
      { ...FULLY_REAL, rendering: 'SIMULATED', qa: 'SIMULATED' },
      { ...FULLY_REAL, rendering: 'UNAVAILABLE', qa: 'UNAVAILABLE' },
    ];
    for (const evidence of substitutions) {
      expect(describeExecutionEvidence(evidence).isRealCampaignRun).toBe(false);
    }
  });
});

/**
 * `HUMAN_ASSISTED_PREVIEW` is decided by a different axis from the
 * infrastructure tiers — where the *creative* came from — so the properties
 * worth pinning are that only a human-supplied plan can reach it, that reaching
 * it forecloses every richer label, and that adding it changed nothing about
 * the modes that existed before.
 */
const HUMAN_ASSISTED: DependencyEvidence = {
  persistence: 'NOT_REQUIRED',
  vectorSearch: 'NOT_REQUIRED',
  reasoning: 'HUMAN_SUPPLIED_PLAN',
  videoGeneration: 'NOT_REQUIRED',
  rendering: 'FFMPEG_REAL',
  qa: 'ACTUAL_MEDIA',
};

describe('the human-assisted preview mode', () => {
  it('is what a human-supplied plan attains, whatever else the run stood on', () => {
    expect(resolveAttainedExecutionMode(HUMAN_ASSISTED)).toBe('HUMAN_ASSISTED_PREVIEW');
    expect(
      resolveAttainedExecutionMode({
        ...HUMAN_ASSISTED,
        persistence: 'PRISMA_POSTGRESQL',
        vectorSearch: 'QDRANT_LIVE',
      }),
    ).toBe('HUMAN_ASSISTED_PREVIEW');
    expect(
      resolveAttainedExecutionMode({ ...HUMAN_ASSISTED, rendering: 'SIMULATED', qa: 'SIMULATED' }),
    ).toBe('HUMAN_ASSISTED_PREVIEW');
  });

  it('can never be labelled PRODUCTION or LOCAL_PRODUCTION, at any infrastructure tier', () => {
    const everythingLive: DependencyEvidence = {
      persistence: 'PRISMA_POSTGRESQL',
      vectorSearch: 'QDRANT_LIVE',
      reasoning: 'HUMAN_SUPPLIED_PLAN',
      videoGeneration: 'NOT_REQUIRED',
      rendering: 'FFMPEG_REAL',
      qa: 'ACTUAL_MEDIA',
    };
    expect(resolveAttainedExecutionMode(everythingLive)).not.toBe('PRODUCTION');
    expect(resolveAttainedExecutionMode(everythingLive)).not.toBe('LOCAL_PRODUCTION');
    expect(shortfallsFor('PRODUCTION', everythingLive).join(' ')).toContain('HUMAN_SUPPLIED_PLAN');
    expect(describeExecutionEvidence(everythingLive).isRealCampaignRun).toBe(false);
  });

  it('forbids generation outright, because zero paid calls is the promise', () => {
    expect(
      resolveAttainedExecutionMode({ ...HUMAN_ASSISTED, videoGeneration: 'COMFYUI_LIVE' }),
    ).not.toBe('HUMAN_ASSISTED_PREVIEW');
    expect(
      resolveAttainedExecutionMode({ ...HUMAN_ASSISTED, videoGeneration: 'FIXTURE_TEST_PATTERN' }),
    ).not.toBe('HUMAN_ASSISTED_PREVIEW');
  });

  it('is matched exactly as a floor, never satisfied by a different kind of run', () => {
    expect(satisfiesExecutionFloor('HUMAN_ASSISTED_PREVIEW', 'HUMAN_ASSISTED_PREVIEW')).toBe(true);
    // A model-planned run is not a human-assisted preview, however much
    // infrastructure it stood on.
    expect(satisfiesExecutionFloor('HUMAN_ASSISTED_PREVIEW', 'PRODUCTION')).toBe(false);
    expect(satisfiesExecutionFloor('HUMAN_ASSISTED_PREVIEW', 'LOCAL_PRODUCTION')).toBe(false);
    // And a preview does not satisfy a request for either of those.
    expect(satisfiesExecutionFloor('PRODUCTION', 'HUMAN_ASSISTED_PREVIEW')).toBe(false);
    expect(satisfiesExecutionFloor('LOCAL_PRODUCTION', 'HUMAN_ASSISTED_PREVIEW')).toBe(false);
    expect(satisfiesExecutionFloor('FIXTURE', 'HUMAN_ASSISTED_PREVIEW')).toBe(false);
  });

  it('leaves the pre-existing modes behaving exactly as they did', () => {
    // The ladder among the original three is unchanged.
    expect(satisfiesExecutionFloor('FIXTURE', 'PRODUCTION')).toBe(true);
    expect(satisfiesExecutionFloor('LOCAL_PRODUCTION', 'PRODUCTION')).toBe(true);
    expect(satisfiesExecutionFloor('PRODUCTION', 'LOCAL_PRODUCTION')).toBe(false);
    expect(executionModeRank('FIXTURE')).toBeLessThan(executionModeRank('LOCAL_PRODUCTION'));
    expect(executionModeRank('LOCAL_PRODUCTION')).toBeLessThan(executionModeRank('PRODUCTION'));

    // And a model-planned run still resolves where it always did.
    expect(resolveAttainedExecutionMode(FULLY_REAL)).toBe('PRODUCTION');
    expect(resolveAttainedExecutionMode({ ...FULLY_REAL, reasoning: 'FIXTURE_REPLAY' })).toBe(
      'LOCAL_PRODUCTION',
    );
    expect(resolveAttainedExecutionMode({ ...FULLY_REAL, persistence: 'IN_MEMORY' })).toBe(
      'FIXTURE',
    );
  });

  it('has a kebab-case spelling that round-trips', () => {
    for (const mode of AAMP_EXECUTION_MODES) {
      expect(parseExecutionModeFlag(executionModeFlagFor(mode))).toBe(mode);
    }
  });
});

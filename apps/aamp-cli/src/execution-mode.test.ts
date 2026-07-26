import { describe, expect, it } from 'vitest';

import {
  CLI_EXECUTION_MODES,
  describeExecutionMode,
  isFullyReal,
  resolveExecutionMode,
  usesFixtureGeneration,
  usesFixtureReasoning,
} from './execution-mode';

describe('execution mode resolution', () => {
  it('names all four combinations distinctly', () => {
    const modes = new Set(
      (['mock', 'claude'] as const).flatMap((reasoningProvider) =>
        (['mock', 'comfyui'] as const).map((videoGenerationProvider) =>
          resolveExecutionMode({ reasoningProvider, videoGenerationProvider }),
        ),
      ),
    );
    expect(modes.size).toBe(4);
    expect([...modes].sort()).toEqual([...CLI_EXECUTION_MODES].sort());
  });

  it('maps each provider pair to the right mode', () => {
    expect(
      resolveExecutionMode({ reasoningProvider: 'claude', videoGenerationProvider: 'comfyui' }),
    ).toBe('REAL_REASONING_AND_REAL_GENERATION');
    expect(
      resolveExecutionMode({ reasoningProvider: 'claude', videoGenerationProvider: 'mock' }),
    ).toBe('REAL_REASONING_AND_FIXTURE_GENERATION');
    expect(
      resolveExecutionMode({ reasoningProvider: 'mock', videoGenerationProvider: 'comfyui' }),
    ).toBe('FIXTURE_REASONING_AND_REAL_GENERATION');
    expect(
      resolveExecutionMode({ reasoningProvider: 'mock', videoGenerationProvider: 'mock' }),
    ).toBe('FIXTURE_REASONING_AND_FIXTURE_GENERATION');
  });

  it('treats exactly one mode as a real advertisement', () => {
    expect(CLI_EXECUTION_MODES.filter(isFullyReal)).toEqual(['REAL_REASONING_AND_REAL_GENERATION']);
  });
});

describe('execution mode descriptions', () => {
  it('warns loudly and says which half is fake, for every non-real mode', () => {
    for (const mode of CLI_EXECUTION_MODES.filter((candidate) => !isFullyReal(candidate))) {
      const description = describeExecutionMode(mode);
      expect(description).toContain(mode);
      expect(description).toContain('NOT A REAL ADVERTISEMENT');
    }
  });

  it('states that fixture reasoning ignores the campaign prompt', () => {
    const description = describeExecutionMode('FIXTURE_REASONING_AND_REAL_GENERATION');
    expect(description).toMatch(/ignores this manifest’s campaign prompt/);
    expect(description).toContain('REASONING_PROVIDER=claude');
  });

  it('states that fixture generation is a test pattern, not AI footage', () => {
    const description = describeExecutionMode('REAL_REASONING_AND_FIXTURE_GENERATION');
    expect(description).toMatch(/not AI-generated footage/);
    expect(description).toContain('VIDEO_GENERATION_PROVIDER=comfyui');
  });

  it('names both caveats when nothing is real', () => {
    const description = describeExecutionMode('FIXTURE_REASONING_AND_FIXTURE_GENERATION');
    expect(description).toMatch(/ignores this manifest’s campaign prompt/);
    expect(description).toMatch(/not AI-generated footage/);
  });

  it('does not warn when both halves are real', () => {
    const description = describeExecutionMode('REAL_REASONING_AND_REAL_GENERATION');
    expect(description).not.toContain('NOT A REAL ADVERTISEMENT');
    expect(description).toContain('real reasoning and real generation');
  });
});

describe('mode predicates', () => {
  it('identifies fixture reasoning', () => {
    expect(CLI_EXECUTION_MODES.filter(usesFixtureReasoning)).toEqual([
      'FIXTURE_REASONING_AND_REAL_GENERATION',
      'FIXTURE_REASONING_AND_FIXTURE_GENERATION',
    ]);
  });

  it('identifies fixture generation', () => {
    expect(CLI_EXECUTION_MODES.filter(usesFixtureGeneration)).toEqual([
      'REAL_REASONING_AND_FIXTURE_GENERATION',
      'FIXTURE_REASONING_AND_FIXTURE_GENERATION',
    ]);
  });
});

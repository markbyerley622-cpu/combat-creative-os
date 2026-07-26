import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AampCliEnv } from '@combat/config';

import {
  authorisePaidProviders,
  DEFAULT_WORKLOAD,
  describeCostCeiling,
  estimateMaximumCost,
} from './paid-providers';

/**
 * Spend is the one thing here that cannot be undone by re-running a command, so
 * the gate is tested from the refusal side: every path that does **not** end in
 * an authorisation, and a structural check that the test suite itself cannot
 * reach one.
 */

const AT = new Date('2026-07-27T00:00:00.000Z');

function env(overrides: Partial<AampCliEnv> = {}): AampCliEnv {
  return {
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    REASONING_PROVIDER: 'claude',
    REASONING_MODEL: 'claude-opus-4-8',
    ANTHROPIC_API_KEY: 'sk-ant-test-value',
    VIDEO_GENERATION_PROVIDER: 'mock',
    COMFYUI_OUTPUT_TIMEOUT_MS: 900_000,
    COMFYUI_WORKFLOW_PROFILE: 'LTX_2_3_DRAFT',
    COMFYUI_CLIENT_ID: 'combat-creative-os',
    COMFYUI_OUTPUT_DIR: '.aamp-output/generated',
    CREATIVE_MEMORY_EMBEDDING_PROFILE: 'STRUCTURAL_BASELINE_V1',
    CREATIVE_MEMORY_MODEL_DOWNLOAD_POLICY: 'deny',
    CREATIVE_MEMORY_MODEL_CACHE_DIR: '.aamp-model-cache',
    CREATIVE_MEMORY_BATCH_SIZE: 16,
    CREATIVE_MEMORY_TIMEOUT_MS: 120_000,
    QDRANT_URL: 'http://127.0.0.1:6333',
    ...overrides,
  } as AampCliEnv;
}

const PRICED = {
  BENCHMARK_INPUT_COST_CENTS_PER_MTOK: 150,
  BENCHMARK_OUTPUT_COST_CENTS_PER_MTOK: 750,
};

describe('the cost ceiling', () => {
  it('cannot be computed without declared prices', () => {
    expect(estimateMaximumCost(env())).toBeNull();
    expect(estimateMaximumCost(env({ BENCHMARK_INPUT_COST_CENTS_PER_MTOK: 150 }))).toBeNull();
  });

  it('is a ceiling over both arms, rounded up', () => {
    const estimate = estimateMaximumCost(env(PRICED));
    expect(estimate).not.toBeNull();
    expect(estimate?.totalInvocations).toBe(
      DEFAULT_WORKLOAD.arms * DEFAULT_WORKLOAD.agentInvocationsPerArm,
    );
    // 22 invocations x 24k in = 528k tokens at 150c/Mtok = 79.2c;
    // 22 x 4k out = 88k at 750c/Mtok = 66c; 145.2 rounds up to 146.
    expect(estimate?.estimatedMaximumCostCents).toBe(146);
  });

  it('prints as a ceiling, not a quote', () => {
    const text = describeCostCeiling(estimateMaximumCost(env(PRICED))!);
    expect(text).toContain('ESTIMATED MAXIMUM');
    expect(text).toMatch(/not a quote, and not a measurement/);
  });
});

describe('paid providers are refused unless every condition holds', () => {
  it('refuses when the flag was not supplied, and says what will run instead', () => {
    const decision = authorisePaidProviders({
      env: env(PRICED),
      allowPaidProviders: false,
      at: AT,
      operator: 'tester',
    });
    expect(decision.authorised).toBe(false);
    expect(decision).toMatchObject({ refusal: 'NOT_REQUESTED' });
    expect((decision as { explanation: string }).explanation).toMatch(
      /deterministic context-aware fixture/,
    );
  });

  it('refuses when no real provider is configured, even with the flag', () => {
    const decision = authorisePaidProviders({
      env: env({ ...PRICED, REASONING_PROVIDER: 'mock' }),
      allowPaidProviders: true,
      at: AT,
      operator: 'tester',
    });
    expect(decision).toMatchObject({ authorised: false, refusal: 'NO_REAL_PROVIDER_CONFIGURED' });
  });

  it('refuses when the key is absent, even with the flag and a configured provider', () => {
    const decision = authorisePaidProviders({
      env: env({ ...PRICED, ANTHROPIC_API_KEY: '   ' }),
      allowPaidProviders: true,
      at: AT,
      operator: 'tester',
    });
    expect(decision).toMatchObject({ authorised: false, refusal: 'NO_REAL_PROVIDER_CONFIGURED' });
  });

  it('refuses when no maximum cost can be computed', () => {
    // The load-bearing one: paid work is never authorised against an unknown
    // number, so an operator who has not declared what a token costs cannot
    // accidentally spend.
    const decision = authorisePaidProviders({
      env: env(),
      allowPaidProviders: true,
      at: AT,
      operator: 'tester',
    });
    expect(decision).toMatchObject({ authorised: false, refusal: 'NO_DECLARED_PRICES' });
    expect((decision as { explanation: string }).explanation).toMatch(
      /never authorised against an unknown number/,
    );
  });

  it('refuses when the estimate exceeds an explicit ceiling', () => {
    const decision = authorisePaidProviders({
      env: env(PRICED),
      allowPaidProviders: true,
      at: AT,
      operator: 'tester',
      maximumCostCents: 100,
    });
    expect(decision).toMatchObject({ authorised: false, refusal: 'ESTIMATE_EXCEEDS_CEILING' });
  });

  it('authorises only when all of them hold, and records who and how much', () => {
    const decision = authorisePaidProviders({
      env: env(PRICED),
      allowPaidProviders: true,
      at: AT,
      operator: 'creative-director-1',
    });
    expect(decision.authorised).toBe(true);
    const statement = (decision as { statement: string }).statement;
    expect(statement).toContain('creative-director-1');
    expect(statement).toContain('claude-opus-4-8');
    expect(statement).toContain('146 cents');
    expect(statement).toContain('Actual spend is not metered');
  });

  it('never puts the API key in the authorisation statement', () => {
    const decision = authorisePaidProviders({
      env: env({ ...PRICED, ANTHROPIC_API_KEY: 'sk-ant-super-secret-value' }),
      allowPaidProviders: true,
      at: AT,
      operator: 'tester',
    });
    expect(JSON.stringify(decision)).not.toContain('sk-ant-super-secret-value');
  });
});

describe('the test suite is structurally incapable of a paid call', () => {
  it('no test passes --allow-paid-providers or sets allowPaidProviders true', async () => {
    // `paid-providers.test.ts` is the exception: it exercises the decision
    // function directly and never constructs a provider from it.
    const directory = resolve(__dirname, '..');
    const offenders: string[] = [];

    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
          await walk(child);
          continue;
        }
        if (!entry.name.endsWith('.test.ts')) continue;
        if (entry.name === 'paid-providers.test.ts') continue;
        const source = await readFile(child, 'utf8');
        if (/--allow-paid-providers|allowPaidProviders:\s*true/.test(source)) {
          offenders.push(entry.name);
        }
      }
    };
    await walk(directory);

    expect(offenders).toEqual([]);
  });

  it('the runner reaches a real provider only through an authorisation', async () => {
    const source = await readFile(join(__dirname, 'run-benchmark.ts'), 'utf8');
    // The only branch that uses `dependencies.reasoningProvider` is guarded by
    // `paidProviders.authorised`; every other path constructs the deterministic
    // fixture.
    expect(source).toMatch(/if \(paidProviders\.authorised\)/);
    expect(source).not.toMatch(/createClaudeReasoningProvider/);
  });
});

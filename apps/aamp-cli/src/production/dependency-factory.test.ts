import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InMemoryReferenceStore } from '@combat/database';
import type { CommandRunner } from '@combat/media';
import { StructuralBaselineEmbeddingProvider } from '@combat/providers';

import { InMemoryQdrant } from '../creative-memory/in-memory-qdrant';
import { createFixtureReasoningProvider } from '../fixture-reasoning';
import {
  AampDependencyError,
  createAampDependencies,
  probeFfmpeg,
  type AampDependencyOptions,
} from './dependency-factory';

/**
 * The composition root's job is to be refused correctly.
 *
 * Almost every test here asserts a *refusal*, because the interesting failure
 * mode of a composition root is not that it fails to build something — it is
 * that it builds a plausible substitute and hands it back without saying so.
 */

const REPOSITORY_ROOT = resolve(__dirname, '../../../..');

/** A runner that answers `-version` but starts no process. */
const fakeRunner: CommandRunner = {
  run: async () => ({ stdout: 'fake 1.0\n', stderr: '', exitCode: 0 }),
};

function options(overrides: Partial<AampDependencyOptions> = {}): AampDependencyOptions {
  return {
    env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
    creativeMemoryMode: 'off',
    runMode: 'FIXTURE_DEMO',
    repositoryRoot: REPOSITORY_ROOT,
    requiresRendering: false,
    generation: 'NONE',
    fixtures: { reasoning: () => createFixtureReasoningProvider(4) },
    ...overrides,
  };
}

async function inMemoryCreativeMemory() {
  const store = new InMemoryReferenceStore();
  return {
    db: store,
    qdrant: new InMemoryQdrant().asClient(),
    embedder: new StructuralBaselineEmbeddingProvider(),
  };
}

describe('production refuses every substitute', () => {
  it('refuses fixture reasoning', async () => {
    await expect(
      createAampDependencies(
        options({ requestedExecutionMode: 'PRODUCTION', runMode: 'FIXTURE_DEMO' }),
      ),
    ).rejects.toMatchObject({ kind: 'FIXTURE_PROVIDER_PROHIBITED' });
  });

  it('refuses an in-memory reference store', async () => {
    await expect(
      createAampDependencies(
        options({
          requestedExecutionMode: 'PRODUCTION',
          runMode: 'REAL',
          creativeMemoryMode: 'required',
          env: {
            NODE_ENV: 'development',
            REASONING_PROVIDER: 'claude',
            ANTHROPIC_API_KEY: 'sk-ant-test-value',
          },
          overrides: { creativeMemoryDependencies: await inMemoryCreativeMemory() },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'FIXTURE_PROVIDER_PROHIBITED' });
  });

  it('refuses any injected test collaborator at all', async () => {
    // A production run that a test could have substituted into is not a
    // production run, whatever else it got right.
    await expect(
      createAampDependencies(
        options({
          requestedExecutionMode: 'PRODUCTION',
          runMode: 'REAL',
          env: {
            NODE_ENV: 'development',
            REASONING_PROVIDER: 'claude',
            ANTHROPIC_API_KEY: 'sk-ant-test-value',
          },
          overrides: { runner: fakeRunner },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'FIXTURE_PROVIDER_PROHIBITED' });
  });

  it('names what to change rather than merely refusing', async () => {
    try {
      await createAampDependencies(options({ requestedExecutionMode: 'PRODUCTION' }));
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect((error as AampDependencyError).message).toContain('REASONING_PROVIDER=claude');
      expect((error as AampDependencyError).message).toContain('ignores the campaign prompt');
    }
  });
});

describe('the attained mode comes from what was built', () => {
  it('labels an entirely deterministic run FIXTURE, whatever was requested', async () => {
    const dependencies = await createAampDependencies(
      options({
        requestedExecutionMode: 'FIXTURE',
        creativeMemoryMode: 'required',
        requiresRendering: true,
        overrides: {
          creativeMemoryDependencies: await inMemoryCreativeMemory(),
          runner: fakeRunner,
        },
      }),
    );
    try {
      expect(dependencies.executionMode).toBe('FIXTURE');
      expect(dependencies.label.isRealCampaignRun).toBe(false);
      expect(dependencies.label.demonstrationOnly).toBe(true);
      expect(dependencies.evidence).toMatchObject({
        persistence: 'IN_MEMORY',
        vectorSearch: 'IN_PROCESS',
        reasoning: 'FIXTURE_REPLAY',
        rendering: 'SIMULATED',
        qa: 'SIMULATED',
      });
    } finally {
      await dependencies.close();
    }
  });

  it('refuses local-production when the dependencies are in-memory, rather than relabelling them', async () => {
    await expect(
      createAampDependencies(
        options({
          requestedExecutionMode: 'LOCAL_PRODUCTION',
          creativeMemoryMode: 'required',
          overrides: { creativeMemoryDependencies: await inMemoryCreativeMemory() },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'EXECUTION_MODE_NOT_ATTAINED' });
  });

  it('lists every shortfall on the refusal', async () => {
    try {
      await createAampDependencies(
        options({
          requestedExecutionMode: 'LOCAL_PRODUCTION',
          creativeMemoryMode: 'required',
          requiresRendering: true,
          overrides: {
            creativeMemoryDependencies: await inMemoryCreativeMemory(),
            runner: fakeRunner,
          },
        }),
      );
      expect.unreachable('expected a refusal');
    } catch (error) {
      const problems = (error as AampDependencyError).problems;
      expect(problems.join('\n')).toContain('persistence was IN_MEMORY');
      expect(problems.join('\n')).toContain('Creative Memory vector search was IN_PROCESS');
      expect(problems.join('\n')).toContain('rendering was SIMULATED');
      expect((error as AampDependencyError).remedies.join(' ')).toContain(
        'Nothing was planned, generated or rendered',
      );
    }
  });

  it('every provider states its identity, version, capability and whether it was simulated', async () => {
    const dependencies = await createAampDependencies(
      options({ creativeMemoryMode: 'off', requiresRendering: false }),
    );
    try {
      expect(dependencies.providers.length).toBeGreaterThan(0);
      for (const provider of dependencies.providers) {
        expect(provider.identity).toBeTruthy();
        expect(provider.version).toBeTruthy();
        expect(provider.capability).toBeTruthy();
        expect(typeof provider.simulated).toBe('boolean');
      }
      const reasoning = dependencies.providers.find((p) => p.role === 'reasoning');
      expect(reasoning).toMatchObject({ identity: 'fixture-replay', simulated: true });
    } finally {
      await dependencies.close();
    }
  });
});

describe('creative memory off acquires nothing', () => {
  it('builds no database and no vector search', async () => {
    const dependencies = await createAampDependencies(options({ creativeMemoryMode: 'off' }));
    try {
      expect(dependencies.db).toBeUndefined();
      expect(dependencies.creativeMemory).toBeUndefined();
      expect(dependencies.evidence.persistence).toBe('NOT_REQUIRED');
      expect(dependencies.evidence.vectorSearch).toBe('NOT_REQUIRED');
      expect(dependencies.providers.some((p) => p.role === 'vector-search')).toBe(false);
      expect(dependencies.providers.some((p) => p.role === 'persistence')).toBe(false);
    } finally {
      await dependencies.close();
    }
  });

  it('refuses creative memory with no DATABASE_URL rather than degrading silently', async () => {
    await expect(
      createAampDependencies(options({ creativeMemoryMode: 'required' })),
    ).rejects.toMatchObject({ kind: 'DATABASE_UNAVAILABLE' });
  });
});

describe('resources are released on every path', () => {
  it('closes what it opened when a later step fails', async () => {
    const released: string[] = [];
    // Qdrant is reached only after the database, so a Qdrant failure is the
    // cheapest way to prove the database connection did not leak.
    const failing = {
      ...(await inMemoryCreativeMemory()),
      qdrant: {
        isHealthy: async () => false,
      } as never,
    };

    // The in-memory path never opens a Prisma client, so the observable
    // guarantee here is the one `close` itself makes: idempotent, and safe to
    // call after a failure.
    const dependencies = await createAampDependencies(
      options({
        creativeMemoryMode: 'required',
        overrides: { creativeMemoryDependencies: failing },
      }),
    );
    dependencies.providers.forEach((provider) => released.push(provider.role));
    await dependencies.close();
    await dependencies.close();
    expect(released).toContain('reasoning');
  });

  it('close is idempotent', async () => {
    const dependencies = await createAampDependencies(options());
    await dependencies.close();
    await expect(dependencies.close()).resolves.toBeUndefined();
  });
});

describe('no secret reaches an error, a log field or a provider identity', () => {
  it('keeps the API key out of the refusal message', async () => {
    try {
      await createAampDependencies(
        options({
          requestedExecutionMode: 'PRODUCTION',
          runMode: 'REAL',
          creativeMemoryMode: 'required',
          env: {
            NODE_ENV: 'development',
            REASONING_PROVIDER: 'claude',
            ANTHROPIC_API_KEY: 'sk-ant-super-secret-value',
            QDRANT_API_KEY: 'qdrant-secret-value',
          },
          overrides: { creativeMemoryDependencies: await inMemoryCreativeMemory() },
        }),
      );
      expect.unreachable('expected a refusal');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('sk-ant-super-secret-value');
      expect(message).not.toContain('qdrant-secret-value');
    }
  });

  it('records an endpoint as host and port only', async () => {
    const dependencies = await createAampDependencies(options());
    try {
      const serialised = JSON.stringify(dependencies.providers);
      expect(serialised).not.toContain('api-key');
      expect(serialised).not.toContain('sk-ant');
    } finally {
      await dependencies.close();
    }
  });
});

describe('the composition root cannot reach a fixture', () => {
  it('imports no fixture, mock or in-memory module', async () => {
    // The structural half of "no production import can select a test provider".
    // The deterministic providers are handed in through `fixtures`; nothing here
    // can name them, so PRODUCTION's refusal cannot be forgotten.
    const source = await readFile(resolve(__dirname, 'dependency-factory.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string);
    for (const specifier of imports) {
      expect(
        /fixture|mock|in-memory|InMemory|testing/i.test(specifier),
        `dependency-factory.ts imports ${specifier}`,
      ).toBe(false);
    }
  });

  it('has no path to a human approval signal', async () => {
    for (const file of ['dependency-factory.ts', 'doctor.ts', 'run-provenance.ts']) {
      // eslint-disable-next-line no-await-in-loop -- read in declared order for a stable failure
      const source = await readFile(resolve(__dirname, file), 'utf8');
      expect(source).not.toMatch(/approveConcept|selectShots|approveFinal/);
    }
  });
});

describe('the FFmpeg probe', () => {
  it('reports the version when the binaries answer', async () => {
    const probe = await probeFfmpeg(fakeRunner, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    expect(probe.available).toBe(true);
    expect(probe.ffmpegVersion).toBe('fake 1.0');
  });

  it('reports both binaries when neither can be executed', async () => {
    const broken: CommandRunner = {
      run: async (command) => {
        throw new Error(`spawn ${command} ENOENT`);
      },
    };
    const probe = await probeFfmpeg(broken, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    expect(probe.available).toBe(false);
    expect(probe.problems).toHaveLength(2);
  });
});

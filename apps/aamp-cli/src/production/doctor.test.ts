import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryReferenceStore } from '@combat/database';
import type { CommandRunner } from '@combat/media';
import { StructuralBaselineEmbeddingProvider } from '@combat/providers';

import { seedBenchmarkWorkspace, WORKSPACE_A } from '../creative-memory/benchmark-fixture';
import { seedBenchmarkProfiles } from '../creative-memory/benchmark-profile-commands';
import { InMemoryQdrant } from '../creative-memory/in-memory-qdrant';
import { indexWorkspace } from '../creative-memory/retrieval-pipeline';
import { runDoctor, type DoctorDatabase, type DoctorOptions, type DoctorReport } from './doctor';
import { runDoctorCli, DOCTOR_EXIT_CODES } from './doctor-cli';

/**
 * The doctor's contract is that it tells the truth and changes nothing.
 *
 * "Changes nothing" is tested directly rather than assumed: the in-memory store
 * is snapshotted before and after, and the run directory is listed afterwards,
 * because a preflight that quietly creates a row or leaves a probe file behind
 * is a preflight nobody can trust to be safe to run.
 */

const REPOSITORY_ROOT = resolve(__dirname, '../../../..');
const AT = new Date('2026-07-27T00:00:00.000Z');

const workingRunner: CommandRunner = {
  run: async () => ({ stdout: 'ffmpeg version 8.1.2-test\n', stderr: '', exitCode: 0 }),
};
const brokenRunner: CommandRunner = {
  run: async (command) => {
    throw new Error(`spawn ${command} ENOENT`);
  },
};

async function seededStore(): Promise<InMemoryReferenceStore> {
  const store = new InMemoryReferenceStore();
  await seedBenchmarkWorkspace(store);
  await seedBenchmarkProfiles(store, {
    workspaceId: WORKSPACE_A,
    name: 'combat-reviews-benchmark',
    reviewerId: 'reviewer-1',
    activatedBy: 'operator-1',
    at: AT,
  });
  return store;
}

async function migrationNames(): Promise<readonly string[]> {
  const entries = await readdir(resolve(REPOSITORY_ROOT, 'packages/database/prisma/migrations'), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function doctorDatabase(store: InMemoryReferenceStore, applied: readonly string[]): DoctorDatabase {
  return {
    db: store,
    kind: 'PRISMA_POSTGRESQL',
    appliedMigrationNames: async () => applied,
    close: async () => undefined,
  };
}

async function run(overrides: Partial<DoctorOptions> = {}): Promise<DoctorReport> {
  return runDoctor({
    env: {
      NODE_ENV: 'development',
      REASONING_PROVIDER: 'claude',
      ANTHROPIC_API_KEY: 'sk-ant-super-secret-value',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/combat_creative_os',
      QDRANT_API_KEY: 'qdrant-secret-value',
    },
    repositoryRoot: REPOSITORY_ROOT,
    creativeMemoryMode: 'off',
    now: AT,
    runner: workingRunner,
    ...overrides,
  });
}

function check(report: DoctorReport, id: string) {
  const found = report.checks.find((entry) => entry.id === id);
  expect(found, `no check "${id}" in report`).toBeDefined();
  return found!;
}

describe('the doctor reports READY when everything a mode needs is present', () => {
  it('reports READY for a source-only fixture run with a working toolchain', async () => {
    const report = await run({ creativeMemoryMode: 'off' });
    expect(report.status).toBe('READY');
    expect(report.blockers).toEqual([]);
    expect(check(report, 'ffmpeg').status).toBe('READY');
    expect(check(report, 'qdrant').status).toBe('NOT_APPLICABLE');
    expect(check(report, 'benchmark-profile').status).toBe('NOT_APPLICABLE');
  });

  it('reports READY for creative memory when the library, governance and index are all in place', async () => {
    const store = await seededStore();
    const embedder = new StructuralBaselineEmbeddingProvider();
    const qdrant = new InMemoryQdrant().asClient();
    await indexWorkspace({ db: store, workspaceId: WORKSPACE_A, embedder, qdrant });

    const report = await run({
      creativeMemoryMode: 'required',
      workspaceId: WORKSPACE_A,
      benchmarkProfileName: 'combat-reviews-benchmark',
      openDatabase: async () => doctorDatabase(store, await migrationNames()),
      qdrant,
      embedder,
    });

    expect(report.status).toBe('READY');
    expect(check(report, 'postgresql').status).toBe('READY');
    expect(check(report, 'prisma-migrations').status).toBe('READY');
    expect(check(report, 'qdrant-collection').status).toBe('READY');
    expect(check(report, 'qdrant-dimension').status).toBe('READY');
    expect(check(report, 'benchmark-profile').detail).toContain('all four planning roles');
    expect(check(report, 'eligible-references').detail).toContain('3 reference(s)');
  });
});

describe('the doctor reports DEGRADED when a run would substitute something', () => {
  it('marks a missing reasoning provider DEGRADED below production', async () => {
    const report = await run({
      env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
      creativeMemoryMode: 'off',
    });
    expect(report.status).toBe('DEGRADED');
    expect(check(report, 'reasoning-provider').status).toBe('DEGRADED');
    expect(check(report, 'reasoning-provider').detail).toContain('ignores the campaign prompt');
    expect(report.blockers).toEqual([]);
    // Fixture reasoning is permitted at LOCAL_PRODUCTION, and a source-only run
    // with creative memory off genuinely needs no database — so this really is
    // the tier that is reachable. It is still not PRODUCTION.
    expect(report.attainableExecutionMode).toBe('LOCAL_PRODUCTION');
  });
});

describe('the doctor reports BLOCKED and names the blocker precisely', () => {
  it('blocks production when there is no real reasoning provider', async () => {
    const report = await run({
      env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
      requestedExecutionMode: 'PRODUCTION',
      creativeMemoryMode: 'off',
    });
    expect(report.status).toBe('BLOCKED');
    expect(check(report, 'reasoning-provider').status).toBe('BLOCKED');
    expect(report.blockers.join('\n')).toContain('reasoning-provider');
  });

  it('blocks when the FFmpeg toolchain cannot be executed', async () => {
    const report = await run({ runner: brokenRunner });
    expect(report.status).toBe('BLOCKED');
    expect(check(report, 'ffmpeg').status).toBe('BLOCKED');
    expect(check(report, 'ffmpeg').remedy).toContain('FFMPEG_PATH');
  });

  it('blocks required creative memory when nothing has been indexed', async () => {
    const store = await seededStore();
    const report = await run({
      creativeMemoryMode: 'required',
      workspaceId: WORKSPACE_A,
      openDatabase: async () => doctorDatabase(store, await migrationNames()),
      qdrant: new InMemoryQdrant().asClient(),
      embedder: new StructuralBaselineEmbeddingProvider(),
    });
    expect(report.status).toBe('BLOCKED');
    expect(check(report, 'qdrant-collection').status).toBe('BLOCKED');
    expect(check(report, 'qdrant-collection').detail).toContain('does not exist');
  });

  it('blocks required creative memory when no profile is approved for every role', async () => {
    const store = new InMemoryReferenceStore();
    await seedBenchmarkWorkspace(store);
    const report = await run({
      creativeMemoryMode: 'required',
      workspaceId: WORKSPACE_A,
      openDatabase: async () => doctorDatabase(store, await migrationNames()),
      qdrant: new InMemoryQdrant().asClient(),
      embedder: new StructuralBaselineEmbeddingProvider(),
    });
    expect(check(report, 'benchmark-profile').status).toBe('BLOCKED');
    expect(check(report, 'benchmark-profile').remedy).toContain('benchmark-seed');
    expect(report.status).toBe('BLOCKED');
  });

  it('blocks when a migration on disk has not been applied', async () => {
    const store = await seededStore();
    const report = await run({
      creativeMemoryMode: 'required',
      workspaceId: WORKSPACE_A,
      openDatabase: async () => doctorDatabase(store, []),
      qdrant: new InMemoryQdrant().asClient(),
      embedder: new StructuralBaselineEmbeddingProvider(),
    });
    expect(check(report, 'prisma-migrations').status).toBe('BLOCKED');
    expect(check(report, 'prisma-migrations').detail).toContain('not applied');
    expect(check(report, 'prisma-migrations').remedy).toContain('migrate');
  });

  it('blocks an ANALYSIS_ONLY asset before any run could reach the renderer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aamp-doctor-assets-'));
    try {
      const assets = join(directory, 'assets.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        assets,
        JSON.stringify({
          manifestVersion: 1,
          library: 'benchmark library',
          assets: [
            {
              id: 'logo',
              path: './logo.png',
              kind: 'IMAGE',
              role: 'LOGO',
              description: 'logo',
              rights: { classification: 'OWNED', owner: 'CR', permittedOutputUse: true },
            },
            {
              id: 'benchmark',
              path: './benchmark.mp4',
              kind: 'VIDEO',
              role: 'SOURCE_CLIP',
              description: 'reference advertisement',
              rights: {
                classification: 'ANALYSIS_ONLY',
                owner: 'Third party',
                permittedOutputUse: true,
              },
            },
          ],
        }),
        'utf8',
      );

      const report = await run({ assetsPath: assets });
      expect(check(report, 'production-asset-rights').status).toBe('BLOCKED');
      expect(check(report, 'production-asset-rights').detail).toContain(
        'must never enter a production asset manifest',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('blocks a requested mode the environment cannot attain, and says which one it can', async () => {
    const report = await run({
      env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
      requestedExecutionMode: 'LOCAL_PRODUCTION',
      creativeMemoryMode: 'off',
    });
    expect(check(report, 'execution-mode').status).toBe('BLOCKED');
    expect(check(report, 'execution-mode').detail).toContain('can only attain FIXTURE');
  });
});

describe('the doctor is read-only', () => {
  let outputDirectory: string;

  beforeEach(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), 'aamp-doctor-out-'));
  });

  afterEach(async () => {
    await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
  });

  it('writes no database row', async () => {
    const store = await seededStore();
    const before = ['referenceAdvertisement', 'referenceAnnotation', 'benchmarkGovernanceProfile']
      .map((table) => `${table}:${store.snapshot(table).length}`)
      .join(',');

    await run({
      creativeMemoryMode: 'required',
      workspaceId: WORKSPACE_A,
      openDatabase: async () => doctorDatabase(store, await migrationNames()),
      qdrant: new InMemoryQdrant().asClient(),
      embedder: new StructuralBaselineEmbeddingProvider(),
    });

    const after = ['referenceAdvertisement', 'referenceAnnotation', 'benchmarkGovernanceProfile']
      .map((table) => `${table}:${store.snapshot(table).length}`)
      .join(',');
    expect(after).toBe(before);
  });

  it('leaves no file behind in the directory whose writability it proved', async () => {
    const report = await run({ outputDirectory });
    expect(check(report, 'output-directory').status).toBe('READY');
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it('declares itself read-only in the report a script would read', async () => {
    const report = await run();
    expect(report.readOnly).toBe(true);
    expect(report.notice).toContain('makes no generation call, spends no money');
  });

  it('never contacts the reasoning provider, so a configured key costs nothing', async () => {
    const report = await run();
    expect(check(report, 'reasoning-provider').detail).toContain('not contacted');
  });
});

describe('the doctor prints no secret', () => {
  it('keeps configured credentials out of both output formats', async () => {
    const store = await seededStore();
    const embedder = new StructuralBaselineEmbeddingProvider();
    const qdrant = new InMemoryQdrant().asClient();
    await indexWorkspace({ db: store, workspaceId: WORKSPACE_A, embedder, qdrant });

    const out: string[] = [];
    const err: string[] = [];
    for (const json of [false, true]) {
      // eslint-disable-next-line no-await-in-loop -- both formats, in a fixed order
      await runDoctorCli(
        [
          '--creative-memory',
          'required',
          '--workspace',
          WORKSPACE_A,
          '--output-dir',
          outputRoot(),
          ...(json ? ['--json'] : []),
        ],
        {
          cwd: REPOSITORY_ROOT,
          env: {
            NODE_ENV: 'development',
            REASONING_PROVIDER: 'claude',
            ANTHROPIC_API_KEY: 'sk-ant-super-secret-value',
            DATABASE_URL: 'postgresql://postgres:hunter2@localhost:5432/combat_creative_os',
            QDRANT_API_KEY: 'qdrant-secret-value',
          },
          stdout: (text) => out.push(text),
          stderr: (text) => err.push(text),
          now: () => AT,
          openDatabase: async () => doctorDatabase(store, await migrationNames()),
          qdrant,
          embedder,
          runner: workingRunner,
        },
      );
    }

    const everything = `${out.join('')}${err.join('')}`;
    expect(everything).not.toContain('sk-ant-super-secret-value');
    expect(everything).not.toContain('qdrant-secret-value');
    expect(everything).not.toContain('hunter2');
  });
});

describe('the doctor CLI surface', () => {
  it('maps the three verdicts onto distinct exit codes', async () => {
    const io = { out: [] as string[], err: [] as string[] };
    const code = await runDoctorCli(['--execution-mode', 'production'], {
      cwd: REPOSITORY_ROOT,
      env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
      stdout: (text) => io.out.push(text),
      stderr: (text) => io.err.push(text),
      now: () => AT,
      runner: workingRunner,
    });
    expect(code).toBe(DOCTOR_EXIT_CODES.BLOCKED);
    expect(io.out.join('')).toContain('AAMP doctor — BLOCKED');
  });

  it('refuses an unknown execution mode rather than guessing', async () => {
    const io = { out: [] as string[], err: [] as string[] };
    const code = await runDoctorCli(['--execution-mode', 'prod'], {
      cwd: REPOSITORY_ROOT,
      env: { NODE_ENV: 'development' },
      stdout: (text) => io.out.push(text),
      stderr: (text) => io.err.push(text),
      runner: workingRunner,
    });
    expect(code).toBe(DOCTOR_EXIT_CODES.INVALID_ARGUMENTS);
    expect(io.err.join('')).toContain('fixture|local-production|production');
  });
});

/** A scratch output root the writability probe can use without touching the repo. */
function outputRoot(): string {
  return join(tmpdir(), `aamp-doctor-secrets-${process.pid}`);
}

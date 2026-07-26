import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InMemoryReferenceStore } from '@combat/database';
import type { CommandResult, CommandRunner } from '@combat/media';
import {
  collectionNameFor,
  pointIdFor,
  StructuralBaselineEmbeddingProvider,
} from '@combat/providers';

import {
  seedBenchmarkWorkspace,
  WORKSPACE_A,
  WORKSPACE_B,
} from '../creative-memory/benchmark-fixture';
import { seedBenchmarkProfiles } from '../creative-memory/benchmark-profile-commands';
import { InMemoryQdrant } from '../creative-memory/in-memory-qdrant';
import type { CreativeMemoryDependencies } from '../creative-memory/injection';
import { indexWorkspace } from '../creative-memory/retrieval-pipeline';
import { runGenerateCli, type GenerateCliContext } from '../generate-cli';
import { EXIT_CODES } from '../run-source-campaign';
import {
  RUN_PROVENANCE_FILENAME,
  verifyRunProvenance,
  type AampRunProvenance,
} from './run-provenance';

/**
 * `aamp:generate` driven through its real entry point, with `--execution-mode`
 * in play.
 *
 * These assert the properties that only show up once the composition root, the
 * mode floor, the injector and the provenance writer are wired together: that a
 * demanded tier refuses rather than relabels, that the artefact left on disk
 * describes what actually ran, and that turning Creative Memory off performs no
 * retrieval at all rather than a retrieval that returns nothing.
 *
 * No FFmpeg binary, no endpoint, no model, no money.
 */

const CAMPAIGN = '99999999-9999-4999-8999-999999999999';
const AT = new Date('2026-07-27T00:00:00.000Z');

let workspace: string;

const REQUEST_JSON = {
  requestVersion: 1,
  name: 'production-composition',
  workspaceId: WORKSPACE_A,
  campaignId: CAMPAIGN,
  brandName: 'Combat Reviews',
  campaignPrompt:
    'Promote this weekend’s coverage. Hook on the number of events, then details, predictions and discussion, and finish on Download Free.',
  objective: 'Drive installs before the weekend’s events',
  targetAudience: 'Fans who follow more than one promotion',
  platform: 'TIKTOK',
  targetDurationSeconds: 15,
  productFacts: [
    { id: 'coverage', label: 'Coverage', detail: 'Every promotion’s card in one place.' },
  ],
  keyMessages: ['One card, one place.'],
  cta: { headline: 'Download Free', subline: 'Combat Reviews', durationSeconds: 3 },
  brandKit: { logoAssetId: 'logo' },
  sourceAssetManifest: 'assets.json',
};

const ASSETS_JSON = {
  manifestVersion: 1,
  library: 'Combat Reviews owned library',
  assets: [
    {
      id: 'arena-clip',
      path: 'arena.mp4',
      kind: 'VIDEO',
      role: 'SOURCE_CLIP',
      description: 'Owned arena crowd footage, vertical',
      rights: { classification: 'OWNED', owner: 'Combat Reviews', permittedOutputUse: true },
      beats: ['HOOK', 'EVENT_DETAIL'],
    },
    ...['information', 'prediction', 'discussion'].map((beat) => ({
      id: `app-${beat}`,
      path: `${beat}.png`,
      kind: 'IMAGE',
      role: 'APP_SCREENSHOT',
      description: `Combat Reviews app screen for ${beat}`,
      rights: { classification: 'OWNED', owner: 'Combat Reviews', permittedOutputUse: true },
      beats: [beat.toUpperCase()],
    })),
    {
      id: 'brand-card',
      path: 'card.png',
      kind: 'IMAGE',
      role: 'BRAND_CARD',
      description: 'Designed Combat Reviews end card',
      rights: { classification: 'OWNED', owner: 'Combat Reviews', permittedOutputUse: true },
      beats: ['CTA'],
    },
    {
      id: 'logo',
      path: 'logo.png',
      kind: 'IMAGE',
      role: 'LOGO',
      description: 'Combat Reviews lockup',
      rights: { classification: 'OWNED', owner: 'Combat Reviews', permittedOutputUse: true },
    },
  ],
};

/** ffprobe answers from a table; ffmpeg refuses, so nothing here can render. */
class FakeRunner implements CommandRunner {
  readonly ffmpegInvocations: string[][] = [];

  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    if (command.includes('ffprobe')) {
      const path = args[args.length - 1] ?? '';
      const isVideo = path.endsWith('.mp4');
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: { duration: isVideo ? '12.0' : '0', format_name: isVideo ? 'mp4' : 'png' },
          streams: [
            {
              codec_type: 'video',
              width: 1080,
              height: 1920,
              codec_name: isVideo ? 'h264' : 'png',
              avg_frame_rate: isVideo ? '30/1' : '0/0',
              nb_frames: isVideo ? '360' : '1',
              pix_fmt: 'yuv420p',
            },
          ],
        }),
        stderr: '',
      };
    }
    this.ffmpegInvocations.push([command, ...args]);
    return { exitCode: 1, stdout: '', stderr: 'this test never renders' };
  }
}

async function creativeMemory(): Promise<{
  dependencies: CreativeMemoryDependencies;
  store: InMemoryReferenceStore;
  qdrant: InMemoryQdrant;
}> {
  const store = new InMemoryReferenceStore();
  await seedBenchmarkWorkspace(store);
  await seedBenchmarkProfiles(store, {
    workspaceId: WORKSPACE_A,
    name: 'combat-reviews-benchmark',
    reviewerId: 'reviewer-1',
    activatedBy: 'operator-1',
    at: AT,
  });
  const embedder = new StructuralBaselineEmbeddingProvider();
  const qdrant = new InMemoryQdrant();
  const client = qdrant.asClient();
  // Both workspaces are indexed into the same collection, so isolation is a
  // property of the filter rather than of the fixture happening to hold one
  // tenant's data.
  await indexWorkspace({ db: store, workspaceId: WORKSPACE_A, embedder, qdrant: client });
  await indexWorkspace({ db: store, workspaceId: WORKSPACE_B, embedder, qdrant: client });
  return { dependencies: { db: store, qdrant: client, embedder }, store, qdrant };
}

function cliContext(
  overrides: Partial<GenerateCliContext> = {},
): GenerateCliContext & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd: process.cwd(),
    env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    now: () => AT,
    workflowRunId: 'composition-run',
    out,
    err,
    ...overrides,
  } as GenerateCliContext & { out: string[]; err: string[] };
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aamp-composition-'));
  await writeFile(join(workspace, 'request.json'), JSON.stringify(REQUEST_JSON), 'utf8');
  await writeFile(join(workspace, 'assets.json'), JSON.stringify(ASSETS_JSON), 'utf8');
  await writeFile(join(workspace, 'arena.mp4'), 'not really a video, but it is bytes', 'utf8');
  for (const name of [
    'information.png',
    'prediction.png',
    'discussion.png',
    'card.png',
    'logo.png',
  ]) {
    await writeFile(join(workspace, name), `bytes for ${name}`, 'utf8');
  }
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

describe('--execution-mode is a floor, never a promotion', () => {
  it('refuses production before any agent runs, and produces nothing', async () => {
    const context = cliContext();
    const code = await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--execution-mode',
        'production',
        '--plan-only',
      ],
      context,
    );

    expect(code).toBe(EXIT_CODES.EXECUTION_MODE_NOT_ATTAINED);
    expect(context.err.join('')).toContain('FIXTURE_PROVIDER_PROHIBITED');
    expect(context.out.join('')).toBe('');
  });

  it('refuses local-production when the dependencies are in-memory rather than relabelling them', async () => {
    const { dependencies } = await creativeMemory();
    const context = cliContext({ creativeMemoryDependencies: dependencies });
    const code = await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--creative-memory',
        'required',
        '--execution-mode',
        'local-production',
        '--plan-only',
      ],
      context,
    );

    expect(code).toBe(EXIT_CODES.EXECUTION_MODE_NOT_ATTAINED);
    expect(context.err.join('')).toContain('persistence was IN_MEMORY');
    expect(context.err.join('')).toContain('Nothing was planned, generated or rendered');
  });

  it('runs and labels itself FIXTURE when no floor is demanded', async () => {
    const context = cliContext();
    const code = await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--plan-only',
        '--json',
        '--output-dir',
        join(workspace, 'runs-a'),
      ],
      context,
    );

    expect(code).toBe(EXIT_CODES.SUCCESS);
    const plan = JSON.parse(context.out.join('')) as {
      executionMode: string;
      isRealCampaignRun: boolean;
      caveat: string;
    };
    expect(plan.isRealCampaignRun).toBe(false);
    expect(plan.caveat).toMatch(/DEMONSTRATION ONLY|PARTIALLY SIMULATED/);
  });
});

describe('the run provenance artefact', () => {
  it('is written, sealed, and describes what actually ran', async () => {
    const { dependencies } = await creativeMemory();
    const outputDirectory = join(workspace, 'runs-provenance');
    const context = cliContext({ creativeMemoryDependencies: dependencies });

    const code = await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--creative-memory',
        'required',
        '--plan-only',
        '--json',
        '--output-dir',
        outputDirectory,
      ],
      context,
    );
    expect(code).toBe(EXIT_CODES.SUCCESS);

    const runDirectories = await readdir(outputDirectory);
    expect(runDirectories).toHaveLength(1);
    const record = JSON.parse(
      await readFile(join(outputDirectory, runDirectories[0]!, RUN_PROVENANCE_FILENAME), 'utf8'),
    ) as AampRunProvenance;

    expect(verifyRunProvenance(record)).toBe(true);
    expect(record).toMatchObject({
      workspaceId: WORKSPACE_A,
      campaignId: CAMPAIGN,
      executionMode: 'FIXTURE',
      creativeMemoryMode: 'required',
      requiresHumanApproval: true,
    });
    expect(record.label.isRealCampaignRun).toBe(false);
    expect(record.requestHashSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);

    // Retrieval evidence: profile version, query and context hashes, reference
    // and annotation ids — enough to reconstruct what governed this plan.
    expect(record.retrievals.length).toBeGreaterThan(0);
    for (const retrieval of record.retrievals) {
      expect(retrieval.benchmarkProfileName).toBe('combat-reviews-benchmark');
      expect(retrieval.benchmarkProfileVersion).toBe(1);
      expect(retrieval.governingChecksumSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(retrieval.queryHash).toMatch(/^[0-9a-f]{64}$/);
      expect(retrieval.anyReferenceOutputEligible).toBe(false);
      for (const item of retrieval.items) {
        expect(item.annotationId).toBeTruthy();
        expect(typeof item.retrievalScore).toBe('number');
      }
    }

    // Every provider that did work names itself.
    const roles = record.providers.map((provider) => provider.role);
    expect(roles).toContain('reasoning');
    expect(roles).toContain('persistence');
    expect(roles).toContain('vector-search');
  });

  it('is machine-independent: the request hash does not depend on where the files live', async () => {
    const outputs = [join(workspace, 'runs-hash-a'), join(workspace, 'runs-hash-b')];
    const hashes: string[] = [];
    for (const [index, outputDirectory] of outputs.entries()) {
      const context = cliContext({ workflowRunId: `hash-run-${index}` });
      // eslint-disable-next-line no-await-in-loop -- two runs, in order
      await runGenerateCli(
        [
          '--request',
          join(workspace, 'request.json'),
          '--fixture-demo',
          '--plan-only',
          '--output-dir',
          outputDirectory,
        ],
        context,
      );
      // eslint-disable-next-line no-await-in-loop -- same ordering rationale
      const directories = await readdir(outputDirectory);
      // eslint-disable-next-line no-await-in-loop -- same ordering rationale
      const record = JSON.parse(
        await readFile(join(outputDirectory, directories[0]!, RUN_PROVENANCE_FILENAME), 'utf8'),
      ) as AampRunProvenance;
      hashes.push(record.requestHashSha256);
    }
    expect(hashes[0]).toBe(hashes[1]);
  });

  it('carries no local path, credential or reference media reference', async () => {
    const { dependencies } = await creativeMemory();
    const outputDirectory = join(workspace, 'runs-secrets');
    const context = cliContext({
      creativeMemoryDependencies: dependencies,
      env: {
        NODE_ENV: 'development',
        REASONING_PROVIDER: 'mock',
        ANTHROPIC_API_KEY: 'sk-ant-super-secret-value',
        QDRANT_API_KEY: 'qdrant-secret-value',
      },
    });

    await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--creative-memory',
        'required',
        '--plan-only',
        '--output-dir',
        outputDirectory,
      ],
      context,
    );

    const directories = await readdir(outputDirectory);
    const raw = await readFile(
      join(outputDirectory, directories[0]!, RUN_PROVENANCE_FILENAME),
      'utf8',
    );
    expect(raw).not.toContain('sk-ant-super-secret-value');
    expect(raw).not.toContain('qdrant-secret-value');
    expect(raw).not.toContain('.aamp-reference-analysis');
    expect(raw).not.toContain('C:/analysis/');
    expect(raw).not.toContain(workspace);
  });
});

describe('creative memory off performs no retrieval at all', () => {
  it('never searches Qdrant, and records the mode', async () => {
    const { dependencies } = await creativeMemory();
    let searches = 0;
    const watched: CreativeMemoryDependencies = {
      ...dependencies,
      qdrant: new Proxy(dependencies.qdrant, {
        get(target, property, receiver) {
          if (property === 'search') searches += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    };

    const context = cliContext({ creativeMemoryDependencies: watched });
    const code = await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--creative-memory',
        'off',
        '--plan-only',
        '--json',
        '--output-dir',
        join(workspace, 'runs-off'),
      ],
      context,
    );

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(searches).toBe(0);
    const plan = JSON.parse(context.out.join('')) as {
      creativeMemoryMode: string;
      creativeMemoryRetrievals: unknown[];
      providers: { role: string }[];
    };
    expect(plan.creativeMemoryMode).toBe('off');
    expect(plan.creativeMemoryRetrievals).toEqual([]);
    // Off acquires no database and no vector search either.
    expect(plan.providers.some((provider) => provider.role === 'vector-search')).toBe(false);
    expect(plan.providers.some((provider) => provider.role === 'persistence')).toBe(false);
  });
});

describe('workspace isolation holds in both stores', () => {
  it('indexes each workspace under its own point ids in the shared collection', async () => {
    const { dependencies } = await creativeMemory();
    const collection = collectionNameFor(dependencies.embedder.getProfile());

    const inA = await dependencies.qdrant.countPoints(collection, {
      must: [{ key: 'workspaceId', match: { value: WORKSPACE_A } }],
    });
    const inB = await dependencies.qdrant.countPoints(collection, {
      must: [{ key: 'workspaceId', match: { value: WORKSPACE_B } }],
    });
    expect(inA).toBeGreaterThan(0);
    expect(inB).toBeGreaterThan(0);

    // The same scene id under two workspaces derives two different points, so
    // one tenant's re-index can never overwrite another's.
    const profile = dependencies.embedder.getProfile().profile;
    expect(pointIdFor(WORKSPACE_A, 'scene-1', profile)).not.toBe(
      pointIdFor(WORKSPACE_B, 'scene-1', profile),
    );
  });

  it('gives a campaign in workspace A only workspace A references', async () => {
    const { dependencies, store } = await creativeMemory();
    const outputDirectory = join(workspace, 'runs-isolation');
    const context = cliContext({ creativeMemoryDependencies: dependencies });

    await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--creative-memory',
        'required',
        '--plan-only',
        '--output-dir',
        outputDirectory,
      ],
      context,
    );

    const directories = await readdir(outputDirectory);
    const record = JSON.parse(
      await readFile(join(outputDirectory, directories[0]!, RUN_PROVENANCE_FILENAME), 'utf8'),
    ) as AampRunProvenance;

    const foreign = new Set(
      store
        .snapshot('referenceAdvertisement')
        .filter((row) => row.workspaceId === WORKSPACE_B)
        .map((row) => row.id as string),
    );
    expect(foreign.size).toBeGreaterThan(0);
    const used = record.retrievals.flatMap((retrieval) =>
      retrieval.items.map((item) => item.referenceId),
    );
    expect(used.length).toBeGreaterThan(0);
    for (const referenceId of used) expect(foreign.has(referenceId)).toBe(false);
  });
});

describe('the human approval gates are untouched', () => {
  it('has no path from this milestone’s code to an approval signal', async () => {
    for (const file of [
      'aamp-execution-mode.ts',
      'campaign-run-provenance.ts',
      'dependency-factory.ts',
      'doctor.ts',
      'doctor-cli.ts',
      'doctor-main.ts',
      'provider-identity.ts',
      'run-provenance.ts',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- read in declared order for a stable failure
      const source = await readFile(join(__dirname, file), 'utf8');
      expect(source, `${file} references an approval signal`).not.toMatch(
        /approveConcept|selectShots|approveFinal/,
      );
    }
  });

  it('records that human approval is still required, on every run', async () => {
    const outputDirectory = join(workspace, 'runs-approval');
    await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--plan-only',
        '--output-dir',
        outputDirectory,
      ],
      cliContext(),
    );
    const directories = await readdir(outputDirectory);
    const record = JSON.parse(
      await readFile(join(outputDirectory, directories[0]!, RUN_PROVENANCE_FILENAME), 'utf8'),
    ) as AampRunProvenance;
    expect(record.requiresHumanApproval).toBe(true);
  });
});

describe('an ANALYSIS_ONLY asset never reaches the renderer', () => {
  it('is refused when the production manifest is parsed, before any FFmpeg process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aamp-composition-rights-'));
    try {
      const assets = join(directory, 'assets.json');
      await writeFile(
        assets,
        JSON.stringify({
          ...ASSETS_JSON,
          assets: [
            ...ASSETS_JSON.assets,
            {
              id: 'benchmark',
              path: 'benchmark.mp4',
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

      const runner = new FakeRunner();
      const context = cliContext({ runner });
      const code = await runGenerateCli(
        [
          '--request',
          join(workspace, 'request.json'),
          '--assets',
          assets,
          '--fixture-demo',
          '--output-dir',
          join(workspace, 'runs-rights'),
        ],
        context,
      );

      expect(code).toBe(EXIT_CODES.INVALID_ASSET_RIGHTS);
      expect(runner.ffmpegInvocations).toEqual([]);
      expect(context.err.join('')).toContain('must never enter a production asset manifest');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InMemoryReferenceStore } from '@combat/database';
import type { CommandResult, CommandRunner } from '@combat/media';
import { StructuralBaselineEmbeddingProvider } from '@combat/providers';

import { loadCampaignRequest } from '../campaign-request';
import { seedBenchmarkWorkspace, WORKSPACE_A } from '../creative-memory/benchmark-fixture';
import { seedBenchmarkProfiles } from '../creative-memory/benchmark-profile-commands';
import { ContextAwareFixtureReasoningProvider } from '../creative-memory/context-aware-fixture-reasoning';
import { InMemoryQdrant } from '../creative-memory/in-memory-qdrant';
import type { CreativeMemoryDependencies } from '../creative-memory/injection';
import { indexWorkspace } from '../creative-memory/retrieval-pipeline';
import { createAampDependencies } from '../production/dependency-factory';
import { runBenchmarkCli, type BenchmarkCliContext } from './benchmark-cli';
import type { ComparisonReport } from './comparison';
import { verifyExperiment, type CreativeBenchmarkExperiment } from './experiment';
import { BENCHMARK_EXIT_CODES, runCreativeBenchmark } from './run-benchmark';

/**
 * The controlled benchmark, driven through its real entry point.
 *
 * **What this proves.** That the two arms receive identical immutable inputs,
 * that no state crosses between them, that OFF performs no retrieval at all,
 * that REQUIRED cannot silently degrade, that injected benchmark intelligence
 * changes hook strategy, timing, a motion/transition decision and a shot
 * specification, that both manifests stay rights-safe, that no reference id
 * becomes an output asset, that the reports are deterministic, and that no
 * human score can appear without a human.
 *
 * **What it does not prove.** Anything about creative quality. The reasoning
 * here is the deterministic context-aware fixture, which derives from measured
 * craft statistics. It demonstrates the mechanism, not judgement. No model
 * runs, no endpoint is contacted, no money is spent, and no FFmpeg binary is
 * required — the arms stop at the render manifest.
 */

const CAMPAIGN = '99999999-9999-4999-8999-999999999999';
const AT = new Date('2026-07-27T00:00:00.000Z');

let workspace: string;

const REQUEST_JSON = {
  requestVersion: 1,
  name: 'benchmark-acceptance',
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

async function creativeMemory(): Promise<CreativeMemoryDependencies> {
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
  const qdrant = new InMemoryQdrant().asClient();
  await indexWorkspace({ db: store, workspaceId: WORKSPACE_A, embedder, qdrant });
  return { db: store, qdrant, embedder };
}

interface Captured {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly directory: string;
}

async function runBenchmark(
  outputDirectory: string,
  experimentId: string,
  extraArgv: readonly string[] = [],
  contextOverrides: Partial<BenchmarkCliContext> = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runBenchmarkCli(
    [
      'run',
      '--request',
      join(workspace, 'request.json'),
      '--workspace',
      WORKSPACE_A,
      '--benchmark-profile',
      'combat-reviews-benchmark',
      '--output-dir',
      outputDirectory,
      '--skip-render',
      '--json',
      ...extraArgv,
    ],
    {
      cwd: process.cwd(),
      env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      now: () => AT,
      experimentId,
      creativeMemoryDependencies: await creativeMemory(),
      runner: new FakeRunner(),
      operator: 'tester',
      ...contextOverrides,
    },
  );
  return {
    code,
    out: out.join(''),
    err: err.join(''),
    directory: join(outputDirectory, experimentId),
  };
}

async function readExperiment(directory: string): Promise<CreativeBenchmarkExperiment> {
  return JSON.parse(await readFile(join(directory, 'experiment.json'), 'utf8')) as never;
}

async function readComparison(directory: string): Promise<ComparisonReport> {
  return JSON.parse(await readFile(join(directory, 'comparison-report.json'), 'utf8')) as never;
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aamp-benchmark-'));
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

describe('a complete controlled benchmark', () => {
  it('runs both arms, compares them and writes every artefact', async () => {
    const outputDirectory = join(workspace, 'out-complete');
    const run = await runBenchmark(outputDirectory, 'bench-complete');

    expect(run.code).toBe(BENCHMARK_EXIT_CODES.SUCCESS);
    const files = (await readdir(run.directory)).sort();
    expect(files).toEqual(
      [
        'arm-off',
        'arm-required',
        'comparison-report.json',
        'comparison-report.md',
        'experiment.json',
        'human-scorecard.off.template.json',
        'human-scorecard.required.template.json',
      ].sort(),
    );

    const experiment = await readExperiment(run.directory);
    expect(verifyExperiment(experiment)).toBe(true);
    expect(experiment.status).toBe('COMPLETED');
    expect(experiment.comparisonStatus).toBe('STRUCTURAL_ONLY');
    expect(experiment.humanReviewStatus).toBe('AWAITING_HUMAN_REVIEW');
    expect(experiment.arms.map((arm) => arm.key)).toEqual(['OFF', 'REQUIRED']);
  });
});

describe('the arms were actually controlled', () => {
  it('both arms received identical immutable inputs', async () => {
    const experiment = await readExperiment(
      (await runBenchmark(join(workspace, 'out-control'), 'bench-control')).directory,
    );
    for (const arm of experiment.arms) {
      expect(arm.receivedRequestHashSha256).toBe(experiment.inputs.requestHashSha256);
      expect(arm.receivedAssetsSha256).toBe(experiment.inputs.productionAssetsSha256);
    }
    expect(experiment.inputs.requestHashSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(experiment.inputs.productionAssetsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records what was held constant, so it can be checked rather than trusted', async () => {
    const experiment = await readExperiment(
      (await runBenchmark(join(workspace, 'out-held'), 'bench-held')).directory,
    );
    expect(experiment.controlled.reasoningProfile).toBe('deterministic-context-aware-fixture');
    expect(experiment.controlled.reasoningDeterministic).toBe(true);
    expect(experiment.controlled.agentPromptVersions.length).toBeGreaterThan(0);
    expect(experiment.controlled.renderSettings).toMatchObject({
      widthPx: 1080,
      heightPx: 1920,
      frameRate: 30,
      targetDurationSeconds: 15,
    });
    // Not fabricated: neither provider exposes a seed through this path.
    expect(experiment.controlled.deterministicSeed).toBeNull();
  });

  it('no state leaks between arms — each has its own directory, run id and audits', async () => {
    const experiment = await readExperiment(
      (await runBenchmark(join(workspace, 'out-leak'), 'bench-leak')).directory,
    );
    const [off, required] = experiment.arms;
    expect(off?.runDirectory).not.toBe(required?.runDirectory);
    expect(off?.workflowRunId).not.toBe(required?.workflowRunId);
    // The REQUIRED arm's audits are its own: one per agent invocation, not
    // accumulated across both arms.
    expect(off?.retrievalCount).toBe(0);
    expect(required?.retrievalCount).toBeGreaterThan(0);
  });

  it('gives each of the four planning agents its own governed context', async () => {
    const experiment = await readExperiment(
      (await runBenchmark(join(workspace, 'out-roles'), 'bench-roles')).directory,
    );
    expect(experiment.benchmarkProfileVersions.map((profile) => profile.agentRole).sort()).toEqual([
      'CAMPAIGN_STRATEGIST',
      'CREATIVE_DIRECTOR',
      'SCRIPT_TIMING_DIRECTOR',
      'SHOT_PROMPT_ENGINEER',
    ]);
    for (const profile of experiment.benchmarkProfileVersions) {
      expect(profile.version).toBe(1);
      expect(profile.governingChecksumSha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // Different roles queried different reference roles — the point of
    // role-scoped retrieval, visible in the arm's own provenance.
    const provenance = JSON.parse(
      await readFile(
        join(
          workspace,
          'out-roles',
          'bench-roles',
          'arm-required',
          'creative-memory-provenance.json',
        ),
        'utf8',
      ),
    ) as { retrievals: { agentRole: string; referenceRolesQueried: string[] }[] };
    const byRole = new Map(
      provenance.retrievals.map((entry) => [
        entry.agentRole,
        entry.referenceRolesQueried.join(','),
      ]),
    );
    expect(byRole.get('CAMPAIGN_STRATEGIST')).not.toBe(byRole.get('CREATIVE_DIRECTOR'));
    expect(byRole.get('SCRIPT_TIMING_DIRECTOR')).not.toBe(byRole.get('SHOT_PROMPT_ENGINEER'));
  });
});

describe('OFF performs no retrieval and REQUIRED cannot silently degrade', () => {
  it('the OFF arm performs zero retrievals', async () => {
    const run = await runBenchmark(join(workspace, 'out-off'), 'bench-off');
    const comparison = await readComparison(run.directory);
    expect(comparison.off.retrievalCount).toBe(0);
    expect(comparison.off.distinctReferencesUsed).toBe(0);
    expect(comparison.off.referenceRolesQueried).toEqual([]);
    expect(comparison.offPerformedNoRetrieval).toBe(true);
  });

  it('the REQUIRED arm fails the experiment rather than planning without context', async () => {
    // No benchmark profile approved, so `required` has nothing to govern it.
    const store = new InMemoryReferenceStore();
    await seedBenchmarkWorkspace(store);
    const embedder = new StructuralBaselineEmbeddingProvider();
    const qdrant = new InMemoryQdrant().asClient();
    await indexWorkspace({ db: store, workspaceId: WORKSPACE_A, embedder, qdrant });

    const run = await runBenchmark(join(workspace, 'out-degrade'), 'bench-degrade', [], {
      creativeMemoryDependencies: { db: store, qdrant, embedder },
    });

    expect(run.code).toBe(BENCHMARK_EXIT_CODES.ARM_FAILED);
    const experiment = await readExperiment(run.directory);
    expect(experiment.status).toBe('FAILED');
    const required = experiment.arms.find((arm) => arm.key === 'REQUIRED');
    expect(required?.exitCode).toBe(9);
    // No comparison is produced from a degraded arm — that is the point.
    expect(experiment.comparisonStatus).toBe('NOT_PRODUCED');
  });
});

describe('Creative Memory changes the plan', () => {
  it('changes hook strategy, timing, a motion/transition decision and the shot specification', async () => {
    const comparison = await readComparison(
      (await runBenchmark(join(workspace, 'out-change'), 'bench-change')).directory,
    );
    const changed = new Set(comparison.changedDimensions);

    expect(changed.has('hook strategy'), 'hook strategy did not change').toBe(true);
    expect(changed.has('hook latency'), 'hook latency did not change').toBe(true);
    expect(changed.has('beat count'), 'beat count did not change').toBe(true);
    expect(changed.has('beat timing'), 'beat timing did not change').toBe(true);
    expect(changed.has('camera movement'), 'camera movement did not change').toBe(true);
    expect(changed.has('motion design'), 'motion design did not change').toBe(true);
    expect(changed.has('manifest'), 'the render manifest did not change').toBe(true);
  });

  it('reports the difference as a difference, never as an improvement', async () => {
    const run = await runBenchmark(join(workspace, 'out-claim'), 'bench-claim');
    const comparison = await readComparison(run.directory);
    const markdown = await readFile(join(run.directory, 'comparison-report.md'), 'utf8');

    expect(comparison.notice).toMatch(/DIFFERENCE IS NOT IMPROVEMENT/);
    expect(markdown).toMatch(/DIFFERENCE IS NOT IMPROVEMENT/);
    expect(markdown).toMatch(/not of improvements/);
    // Nothing anywhere declares a winner. ("better" is deliberately excluded
    // from this list: the caveat itself uses the word, to deny the claim.)
    expect(markdown).not.toMatch(/\b(winner|recommended|superior|outperform\w*)\b/i);
    // And no field in the structured report could carry a verdict either.
    for (const key of Object.keys(comparison)) {
      expect(key).not.toMatch(/winner|better|improv|preferred|score/i);
    }
  });

  it('distinguishes structural change from measurement', async () => {
    const comparison = await readComparison(
      (await runBenchmark(join(workspace, 'out-kind'), 'bench-kind')).directory,
    );
    const kinds = new Set(comparison.dimensions.map((dimension) => dimension.kind));
    expect(kinds).toEqual(new Set(['STRUCTURE', 'MEASUREMENT']));
    expect(
      comparison.dimensions.find((dimension) => dimension.dimension === 'actual-media QA')?.kind,
    ).toBe('MEASUREMENT');
  });
});

describe('determinism', () => {
  it('two identical runs produce identical reports', async () => {
    const first = await runBenchmark(join(workspace, 'out-det-a'), 'bench-det');
    const second = await runBenchmark(join(workspace, 'out-det-b'), 'bench-det');

    const [a, b] = await Promise.all([
      readComparison(first.directory),
      readComparison(second.directory),
    ]);
    expect(a.reportChecksumSha256).toBe(b.reportChecksumSha256);

    // Two things legitimately differ between these runs and neither is a
    // determinism defect: the output roots, and the profile row ids, which the
    // in-memory fixture mints fresh each time (in a real workspace the profiles
    // are persisted once and keep their ids). The governing checksum is the
    // value that must be stable, and it is asserted rather than stripped.
    const strip = (experiment: CreativeBenchmarkExperiment): unknown => ({
      ...experiment,
      experimentChecksumSha256: '<checksum>',
      arms: experiment.arms.map((arm) => ({ ...arm, runDirectory: '<run>' })),
      benchmarkProfileVersions: experiment.benchmarkProfileVersions.map((profile) => ({
        ...profile,
        profileId: '<profile>',
      })),
    });
    const [experimentA, experimentB] = await Promise.all([
      readExperiment(first.directory),
      readExperiment(second.directory),
    ]);
    expect(strip(experimentA)).toEqual(strip(experimentB));
    // Each record still seals its own contents.
    expect(verifyExperiment(experimentA)).toBe(true);
    expect(verifyExperiment(experimentB)).toBe(true);
  });
});

describe('both arms stay rights-safe', () => {
  it('puts only output-eligible sources in either manifest', async () => {
    const run = await runBenchmark(join(workspace, 'out-rights'), 'bench-rights');
    for (const arm of ['arm-off', 'arm-required']) {
      const manifest = JSON.parse(
        await readFile(join(run.directory, arm, 'render-manifest.json'), 'utf8'),
      ) as { sources: { license: { usageClass: string } }[] };
      expect(manifest.sources.length).toBeGreaterThan(0);
      for (const source of manifest.sources) {
        expect(['OWNED', 'LICENSED_FOR_OUTPUT']).toContain(source.license.usageClass);
      }
    }
  });

  it('never lets a reference id become an output asset', async () => {
    const run = await runBenchmark(join(workspace, 'out-refids'), 'bench-refids');
    const comparison = await readComparison(run.directory);
    const provenance = JSON.parse(
      await readFile(
        join(run.directory, 'arm-required', 'creative-memory-provenance.json'),
        'utf8',
      ),
    ) as { retrievals: { items: { referenceId: string }[] }[] };
    const referenceIds = new Set(
      provenance.retrievals.flatMap((retrieval) => retrieval.items.map((item) => item.referenceId)),
    );
    expect(referenceIds.size).toBeGreaterThan(0);

    const manifest = await readFile(
      join(run.directory, 'arm-required', 'render-manifest.json'),
      'utf8',
    );
    for (const referenceId of referenceIds) expect(manifest).not.toContain(referenceId);
    expect(comparison.required.distinctReferencesUsed).toBeGreaterThan(0);
  });
});

describe('secrets and human scores', () => {
  it('no secret reaches any report', async () => {
    const run = await runBenchmark(join(workspace, 'out-secrets'), 'bench-secrets', [], {
      env: {
        NODE_ENV: 'development',
        REASONING_PROVIDER: 'mock',
        ANTHROPIC_API_KEY: 'sk-ant-super-secret-value',
        QDRANT_API_KEY: 'qdrant-secret-value',
      },
    });

    for (const file of ['experiment.json', 'comparison-report.json', 'comparison-report.md']) {
      // eslint-disable-next-line no-await-in-loop -- checked in declared order
      const contents = await readFile(join(run.directory, file), 'utf8');
      expect(contents, `${file} leaked a secret`).not.toContain('sk-ant-super-secret-value');
      expect(contents, `${file} leaked a secret`).not.toContain('qdrant-secret-value');
    }
    expect(`${run.out}${run.err}`).not.toContain('sk-ant-super-secret-value');
  });

  it('emits an empty scorecard template per arm and never a score', async () => {
    const run = await runBenchmark(join(workspace, 'out-score'), 'bench-score');
    for (const arm of ['off', 'required']) {
      // eslint-disable-next-line no-await-in-loop -- checked in declared order
      const template = JSON.parse(
        await readFile(join(run.directory, `human-scorecard.${arm}.template.json`), 'utf8'),
      ) as { scores: unknown[]; reviewerId: null; status: string };
      expect(template.scores).toEqual([]);
      expect(template.reviewerId).toBeNull();
      expect(template.status).toBe('AWAITING_HUMAN_REVIEW');
    }
    const experiment = await readExperiment(run.directory);
    expect(experiment.humanReviewStatus).toBe('AWAITING_HUMAN_REVIEW');
  });
});

describe('paid providers', () => {
  it('runs the demonstration and spends nothing when the flag is absent', async () => {
    const run = await runBenchmark(join(workspace, 'out-free'), 'bench-free');
    const experiment = await readExperiment(run.directory);
    expect(experiment.paidProvidersAuthorised).toBe(false);
    expect(experiment.paidProviderAuthorisation).toBeNull();
    expect(experiment.controlled.reasoningProfile).toBe('deterministic-context-aware-fixture');
    expect(run.err).toMatch(/DEMONSTRATION/);
  });
});

describe('a HIGH originality result stops the experiment', () => {
  /** Echoes a retrieved craft principle verbatim — exactly what the gate blocks. */
  class CopyingReasoningProvider extends ContextAwareFixtureReasoningProvider {
    override async invoke(input: Parameters<ContextAwareFixtureReasoningProvider['invoke']>[0]) {
      const response = await super.invoke(input);
      const parsed = JSON.parse(response.raw) as { result: Record<string, unknown> };
      const envelope = JSON.parse(String(input.messages[0]?.content ?? '{}')) as {
        input?: { creativeMemory?: { items?: { craftPrinciple: string }[] } };
      };
      const principle = envelope.input?.creativeMemory?.items?.[0]?.craftPrinciple;
      if (principle && parsed.result.strategy) {
        const strategy = parsed.result.strategy as { keyMessages: string[] };
        strategy.keyMessages = [principle, ...strategy.keyMessages];
      }
      return { ...response, raw: JSON.stringify(parsed) };
    }
  }

  it('blocks before any render, produces no comparison, and says so', async () => {
    const runner = new FakeRunner();
    const dependencies = await createAampDependencies({
      env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
      creativeMemoryMode: 'required',
      runMode: 'FIXTURE_DEMO',
      repositoryRoot: workspace,
      requiresRendering: false,
      generation: 'NONE',
      fixtures: { reasoning: () => new ContextAwareFixtureReasoningProvider() },
      overrides: { creativeMemoryDependencies: await creativeMemory(), runner },
    });

    try {
      const result = await runCreativeBenchmark({
        experimentId: 'bench-originality',
        request: await loadCampaignRequest(join(workspace, 'request.json')),
        dependencies,
        repositoryRoot: workspace,
        outputDirectory: join(workspace, 'out-originality'),
        benchmarkProfileName: 'combat-reviews-benchmark',
        paidProviders: {
          authorised: false,
          refusal: 'NOT_REQUESTED',
          explanation: 'test',
          estimate: null,
        },
        planOnly: false,
        skipRender: true,
        now: AT,
        reasoningProviderFactory: () => new CopyingReasoningProvider(),
      });

      expect(result.exitCode).toBe(BENCHMARK_EXIT_CODES.ORIGINALITY_BLOCKED);
      expect(result.experiment.status).toBe('BLOCKED_BY_ORIGINALITY');
      expect(result.comparison).toBeNull();
      expect(result.experiment.comparisonStatus).toBe('NOT_PRODUCED');
      expect(runner.ffmpegInvocations).toEqual([]);
      // No scorecard template either: there is nothing to review.
      expect(result.scorecardTemplatePaths).toEqual([]);

      // The gate sits before source selection, so the blocked arm has no
      // timeline at all — while the arm that was not blocked does. An absent
      // MP4 could mean many things; an absent render manifest means the run
      // stopped before anything was composed.
      const experimentDirectory = join(workspace, 'out-originality', 'bench-originality');
      await expect(
        readFile(join(experimentDirectory, 'arm-required', 'render-manifest.json'), 'utf8'),
      ).rejects.toThrow();
      await expect(
        readFile(join(experimentDirectory, 'arm-off', 'render-manifest.json'), 'utf8'),
      ).resolves.toContain('scenes');

      const report = JSON.parse(
        await readFile(
          join(experimentDirectory, 'arm-required', 'originality-report.json'),
          'utf8',
        ),
      ) as { riskLevel: string; blocked: boolean };
      expect(report).toMatchObject({ riskLevel: 'HIGH', blocked: true });
    } finally {
      await dependencies.close();
    }
  });
});

describe('the render was genuinely skipped, not silently failed', () => {
  it('invokes no FFmpeg process and says so on the arms', async () => {
    const runner = new FakeRunner();
    const run = await runBenchmark(join(workspace, 'out-skip'), 'bench-skip', [], { runner });
    const experiment = await readExperiment(run.directory);
    expect(runner.ffmpegInvocations).toEqual([]);
    for (const arm of experiment.arms) {
      expect(arm.renderSkipped).toBe(true);
      expect(arm.qaVerdict).toBeNull();
      expect(arm.outputPath).toBeNull();
    }
    expect(experiment.comparisonStatus).toBe('STRUCTURAL_ONLY');
  });
});

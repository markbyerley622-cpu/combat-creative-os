import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ReasoningInvokeInput,
  ReasoningModelMeta,
  ReasoningProvider,
} from '@combat/providers';

import { loadCampaignRequest } from '../campaign-request';
import { CreativeMemoryInjector } from '../creative-memory/injection';
import { LAUNCH_EXIT_CODES } from './launch-contracts';
import { runLaunchCli, type LaunchCliContext } from './launch-cli';
import { LaunchFixtureReasoningProvider } from './launch-fixture-reasoning';
import {
  FfprobeOnlyRunner,
  LAUNCH_FIXTURE_AT,
  LAUNCH_FIXTURE_BENCHMARK_PROFILE,
  LAUNCH_FIXTURE_CAMPAIGN_ID,
  LAUNCH_FIXTURE_REVIEWER,
  LAUNCH_FIXTURE_WORKSPACE_ID,
  captureSessionJson,
  launchCreativeMemoryDependencies,
  launchRequestJson,
  productionAssetsJson,
  writeLaunchFixtureWorkspace,
} from './launch-fixtures';
import { runLaunchPlan } from './run-launch-plan';

/**
 * Every way the launch path is supposed to fail closed.
 *
 * A refusal is a feature here, not an inconvenience: each of these is a state
 * in which producing an advertisement would be wrong, and the value of the
 * milestone is that it stops rather than producing something plausible.
 */

let workspace: string;

function contextFor(
  overrides: Partial<LaunchCliContext> = {},
): LaunchCliContext & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  let counter = 0;
  return {
    cwd: process.cwd(),
    env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => LAUNCH_FIXTURE_AT,
    workflowRunId: 'refusal-run',
    launchRunId: 'launch-refusal-000000000001',
    newConceptId: () => `concept-${(counter += 1)}`,
    runner: new FfprobeOnlyRunner(),
    out,
    err,
    ...overrides,
  } as LaunchCliContext & { out: string[]; err: string[] };
}

async function planArguments(): Promise<string[]> {
  return [
    'plan',
    '--request',
    join(workspace, 'request.json'),
    '--benchmark-profile',
    LAUNCH_FIXTURE_BENCHMARK_PROFILE,
    '--output-dir',
    join(workspace, 'runs'),
    '--fixture-demo',
    '--json',
  ];
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aamp-launch-refusal-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('a request that is not a product launch', () => {
  it('is refused by name rather than planned as an ordinary campaign', async () => {
    const { productLaunch: _launch, ...withoutLaunch } = launchRequestJson() as Record<
      string,
      unknown
    >;
    await writeLaunchFixtureWorkspace(workspace, { request: withoutLaunch });

    const context = contextFor({
      creativeMemoryDependencies: await launchCreativeMemoryDependencies(),
    });
    const code = await runLaunchCli(await planArguments(), context);

    expect(code).toBe(LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST);
    expect(context.err.join('')).toContain('declares no productLaunch brief');
  });
});

describe('asset rights and product captures', () => {
  it('refuses an analysis-only asset before any agent runs', async () => {
    const assets = productionAssetsJson();
    const list = assets.assets as Record<string, unknown>[];
    list.push({
      id: 'benchmark-reel',
      path: 'arena.mp4',
      kind: 'VIDEO',
      role: 'SOURCE_CLIP',
      description: 'A competitor advertisement held for study only',
      rights: {
        classification: 'ANALYSIS_ONLY',
        owner: 'Someone else',
        permittedOutputUse: false,
      },
    });
    await writeLaunchFixtureWorkspace(workspace, { assets });

    const context = contextFor({
      creativeMemoryDependencies: await launchCreativeMemoryDependencies(),
    });
    const code = await runLaunchCli(await planArguments(), context);

    expect(code).toBe(LAUNCH_EXIT_CODES.INVALID_ASSET_RIGHTS);
    expect(context.err.join('')).toContain('ANALYSIS_ONLY');
  });

  it('refuses when a required product capture was taken for inspection only', async () => {
    const captures = captureSessionJson();
    const assets = captures.assets as Record<string, unknown>[];
    const required = assets.find((asset) => asset.assetId === 'app-information');
    if (required) {
      required.eligibility = 'REVIEW_REQUIRED';
      required.rightsClassification = null;
      required.rightsBasis = null;
    }
    await writeLaunchFixtureWorkspace(workspace, { captures });

    const context = contextFor({
      creativeMemoryDependencies: await launchCreativeMemoryDependencies(),
    });
    const code = await runLaunchCli(await planArguments(), context);

    expect(code).toBe(LAUNCH_EXIT_CODES.MISSING_PRODUCTION_ASSETS);
    expect(context.err.join('')).toContain('inspection only');
    expect(context.err.join('')).toContain('app-information');
  });

  it('refuses when a required product capture is absent altogether', async () => {
    const captures = captureSessionJson({ assets: [] });
    await writeLaunchFixtureWorkspace(workspace, { captures });

    const context = contextFor({
      creativeMemoryDependencies: await launchCreativeMemoryDependencies(),
    });
    const code = await runLaunchCli(await planArguments(), context);

    expect(code).toBe(LAUNCH_EXIT_CODES.MISSING_PRODUCTION_ASSETS);
    expect(context.err.join('')).toContain('absent from the capture session');
  });
});

describe('benchmark governance', () => {
  it('refuses when the flag and the brief name different profiles', async () => {
    await writeLaunchFixtureWorkspace(workspace);
    const context = contextFor({
      creativeMemoryDependencies: await launchCreativeMemoryDependencies(),
    });
    const args = await planArguments();
    args[args.indexOf('--benchmark-profile') + 1] = 'some-other-profile';

    const code = await runLaunchCli(args, context);
    expect(code).toBe(LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST);
    expect(context.err.join('')).toContain('which governance applies');
  });

  it('refuses `--creative-memory off`, because a launch is always governed', async () => {
    await writeLaunchFixtureWorkspace(workspace);
    const context = contextFor();
    const code = await runLaunchCli(
      [...(await planArguments()), '--creative-memory', 'off'],
      context,
    );

    expect(code).toBe(LAUNCH_EXIT_CODES.INVALID_CAMPAIGN_REQUEST);
    expect(context.err.join('')).toContain('not available here');
  });
});

/** Enough scaffolding to drive `runLaunchPlan` directly with a chosen provider. */
async function planWith(provider: ReasoningProvider): Promise<{
  exitCode: number;
  failure?: string;
  runDirectory: string;
}> {
  const request = await loadCampaignRequest(join(workspace, 'request.json'));
  const dependencies = await launchCreativeMemoryDependencies();
  let counter = 0;

  return runLaunchPlan({
    request,
    launchBrief: request.productLaunch!,
    benchmarkProfileName: LAUNCH_FIXTURE_BENCHMARK_PROFILE,
    captureSessionPath: join(workspace, 'captures.json'),
    reasoningProvider: provider,
    injector: new CreativeMemoryInjector({
      mode: 'required',
      dependencies,
      workspaceId: LAUNCH_FIXTURE_WORKSPACE_ID,
      campaignId: LAUNCH_FIXTURE_CAMPAIGN_ID,
      platform: 'TIKTOK',
      now: LAUNCH_FIXTURE_AT,
    }),
    creativeMemoryMode: 'required',
    runDirectory: join(workspace, 'direct-run'),
    launchRunId: 'direct-run',
    workflowRunId: 'direct-run',
    label: {
      executionMode: 'FIXTURE',
      isRealCampaignRun: false,
      demonstrationOnly: true,
      caveat: 'FIXTURE — DEMONSTRATION ONLY.',
      runMode: 'FIXTURE_DEMO',
      reasoningProvider: 'fixture-replay',
      reasoningModel: 'NONE-FIXTURE-REPLAY',
    },
    costBasis: {
      budgetCeilingCents: 5000,
      estimatedMaximumCostCents: 0,
      plannedAgentInvocations: 5,
      paidProviderCallsPossible: false,
      note: 'No paid provider was constructed for this run.',
    },
    now: LAUNCH_FIXTURE_AT,
    newConceptId: () => `concept-${(counter += 1)}`,
  });
}

/**
 * Forces every candidate into the same structural slot, which is exactly what a
 * model producing superficial rewrites would do.
 */
class DuplicatingProvider implements ReasoningProvider {
  readonly name = 'duplicating-fixture';
  private readonly inner = new LaunchFixtureReasoningProvider();

  async invoke(
    input: ReasoningInvokeInput,
  ): Promise<{ raw: string; modelMeta: ReasoningModelMeta }> {
    const first = input.messages[0];
    const raw = typeof first?.content === 'string' ? first.content : '{}';
    const envelope = JSON.parse(raw) as { input?: Record<string, unknown> };
    if (envelope.input && 'launchDirective' in envelope.input) {
      envelope.input.launchDirective = {
        candidateIndex: 1,
        candidateCount: 4,
        occupiedStructuralPositions: [],
        occupiedTitles: [],
      };
    }
    return this.inner.invoke({
      ...input,
      messages: [
        { ...first, content: JSON.stringify(envelope) } as (typeof input.messages)[number],
      ],
    });
  }
}

/** Returns a well-formed Creative Director result that carries no structured concept. */
class ConceptlessProvider implements ReasoningProvider {
  readonly name = 'conceptless-fixture';
  private readonly inner = new LaunchFixtureReasoningProvider();

  async invoke(
    input: ReasoningInvokeInput,
  ): Promise<{ raw: string; modelMeta: ReasoningModelMeta }> {
    const response = await this.inner.invoke(input);
    const parsed = JSON.parse(response.raw) as { result: Record<string, unknown> };
    if ('launchConcept' in parsed.result) delete parsed.result.launchConcept;
    return { ...response, raw: JSON.stringify(parsed) };
  }
}

describe('the concept set itself', () => {
  it('refuses a set whose candidates are the same idea rewritten', async () => {
    await writeLaunchFixtureWorkspace(workspace);
    const result = await planWith(new DuplicatingProvider());

    expect(result.exitCode).toBe(LAUNCH_EXIT_CODES.CONCEPTS_NOT_DISTINCT);
    expect(result.failure).toContain('not a competition');

    const report = JSON.parse(
      await readFile(join(result.runDirectory, 'distinctness-report.json'), 'utf8'),
    ) as { verdict: string; pairs: { superficiallyDuplicated: boolean }[] };
    expect(report.verdict).toBe('INSUFFICIENTLY_DISTINCT');
    expect(report.pairs.every((pair) => pair.superficiallyDuplicated)).toBe(true);
  });

  it('refuses a run that could not produce three valid concepts', async () => {
    await writeLaunchFixtureWorkspace(workspace);
    const result = await planWith(new ConceptlessProvider());

    expect(result.exitCode).toBe(LAUNCH_EXIT_CODES.INSUFFICIENT_CONCEPTS);
    expect(result.failure).toContain('no launchConcept');

    const rejected = JSON.parse(
      await readFile(join(result.runDirectory, 'rejected-candidates.json'), 'utf8'),
    ) as { candidateIndex: number }[];
    expect(rejected.length).toBeGreaterThanOrEqual(3);
  });
});

describe('a brief that changed after planning', () => {
  it('refuses the selection as stale rather than approving a concept for another brief', async () => {
    await writeLaunchFixtureWorkspace(workspace);
    const planContext = contextFor({
      creativeMemoryDependencies: await launchCreativeMemoryDependencies(),
    });
    const planCode = await runLaunchCli(await planArguments(), planContext);
    expect(planCode, planContext.err.join('')).toBe(LAUNCH_EXIT_CODES.SUCCESS);
    const runDirectory = (JSON.parse(planContext.out.join('')) as { runDirectory: string })
      .runDirectory;

    // The requester edits the brief after the concepts were written.
    await writeFile(
      join(workspace, 'request.json'),
      JSON.stringify(
        launchRequestJson({ campaignPrompt: 'A completely different brief, written later.' }),
        null,
        2,
      ),
      'utf8',
    );

    const selectContext = contextFor();
    const code = await runLaunchCli(
      [
        'select',
        '--run',
        runDirectory,
        '--concept',
        'concept-1',
        '--reviewer',
        LAUNCH_FIXTURE_REVIEWER,
      ],
      selectContext,
    );

    expect(code).toBe(LAUNCH_EXIT_CODES.CONCEPT_STALE_OR_SUPERSEDED);
    expect(selectContext.err.join('')).toContain('STALE_CAMPAIGN_PROMPT');
  });
});

describe('a set the reviewer rejected outright', () => {
  it('closes the run: no concept from it may be selected afterwards', async () => {
    await writeLaunchFixtureWorkspace(workspace);
    const planContext = contextFor({
      creativeMemoryDependencies: await launchCreativeMemoryDependencies(),
    });
    expect(await runLaunchCli(await planArguments(), planContext)).toBe(LAUNCH_EXIT_CODES.SUCCESS);
    const runDirectory = (JSON.parse(planContext.out.join('')) as { runDirectory: string })
      .runDirectory;

    const feedbackPath = join(workspace, 'reject.txt');
    await writeFile(feedbackPath, 'None of these answer the brief. Start again.', 'utf8');

    const rejectContext = contextFor();
    expect(
      await runLaunchCli(
        [
          'reject',
          '--run',
          runDirectory,
          '--reviewer',
          LAUNCH_FIXTURE_REVIEWER,
          '--feedback',
          feedbackPath,
        ],
        rejectContext,
      ),
    ).toBe(LAUNCH_EXIT_CODES.SUCCESS);

    const selectContext = contextFor();
    const code = await runLaunchCli(
      [
        'select',
        '--run',
        runDirectory,
        '--concept',
        'concept-1',
        '--reviewer',
        LAUNCH_FIXTURE_REVIEWER,
      ],
      selectContext,
    );
    expect(code).toBe(LAUNCH_EXIT_CODES.SELECTION_REFUSED);
    expect(selectContext.err.join('')).toContain('rejected this whole concept set');
  });
});

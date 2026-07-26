import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InMemoryReferenceStore } from '@combat/database';
import type { CommandResult, CommandRunner } from '@combat/media';
import { StructuralBaselineEmbeddingProvider } from '@combat/providers';

import { loadCampaignRequest } from '../campaign-request';
import { runGenerateCli, type GenerateCliContext } from '../generate-cli';
import { EXIT_CODES, runSourceCampaign } from '../run-source-campaign';
import { seedBenchmarkProfiles } from './benchmark-profile-commands';
import { seedBenchmarkWorkspace, WORKSPACE_A } from './benchmark-fixture';
import { ContextAwareFixtureReasoningProvider } from './context-aware-fixture-reasoning';
import { InMemoryQdrant } from './in-memory-qdrant';
import { CreativeMemoryInjector, type CreativeMemoryDependencies } from './injection';
import { indexWorkspace } from './retrieval-pipeline';

/**
 * `--creative-memory required|optional|off`, and the originality gate that sits
 * behind them.
 *
 * The property under test throughout is that **no mode ever substitutes**. A
 * required run that cannot get governed context stops with its own exit code
 * and produces nothing; an optional run says so and continues with no context;
 * an off run behaves exactly as it did before this milestone. None of them
 * quietly reach for fixture creative or generic benchmark text.
 *
 * No FFmpeg binary, no endpoint, no model, no money.
 */

const CAMPAIGN = '99999999-9999-4999-8999-999999999999';
const AT = new Date('2026-07-27T00:00:00.000Z');

let workspace: string;

const REQUEST_JSON = {
  requestVersion: 1,
  name: 'creative-memory-modes',
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
      tags: ['coverage'],
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

/**
 * A runner that answers ffprobe from a table and refuses ffmpeg.
 *
 * Refusing ffmpeg is the point in the blocking test: if the originality gate
 * works, the renderer is never reached, and `ffmpegInvocations` proves it
 * rather than an absence of output implying it.
 */
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

async function dependencies(options: { profiles: boolean }): Promise<CreativeMemoryDependencies> {
  const store = new InMemoryReferenceStore();
  await seedBenchmarkWorkspace(store);
  if (options.profiles) {
    await seedBenchmarkProfiles(store, {
      workspaceId: WORKSPACE_A,
      name: 'combat-reviews-benchmark',
      reviewerId: 'reviewer-1',
      activatedBy: 'operator-1',
      at: AT,
    });
  }
  const embedder = new StructuralBaselineEmbeddingProvider();
  const qdrant = new InMemoryQdrant().asClient();
  await indexWorkspace({ db: store, workspaceId: WORKSPACE_A, embedder, qdrant });
  return { db: store, qdrant, embedder };
}

function cliContext(
  overrides: Partial<GenerateCliContext> = {},
): GenerateCliContext & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd: process.cwd(),
    env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => AT,
    workflowRunId: 'modes-run',
    out,
    err,
    ...overrides,
  } as GenerateCliContext & { out: string[]; err: string[] };
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aamp-creative-memory-'));
  await writeFile(join(workspace, 'request.json'), JSON.stringify(REQUEST_JSON), 'utf8');
  await writeFile(join(workspace, 'assets.json'), JSON.stringify(ASSETS_JSON), 'utf8');
  // Real files, so containment, size and checksum checks are exercised for
  // real; only the decode is faked, because decoding needs FFmpeg.
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
  await rm(workspace, { recursive: true, force: true });
});

describe('--creative-memory off preserves the baseline', () => {
  it('plans with no retrieval and reports the mode', async () => {
    const context = cliContext();
    const code = await runGenerateCli(
      ['--request', join(workspace, 'request.json'), '--fixture-demo', '--plan-only', '--json'],
      context,
    );

    expect(code).toBe(EXIT_CODES.SUCCESS);
    const payload = JSON.parse(context.out.join('')) as Record<string, unknown>;
    expect(payload.creativeMemoryMode).toBe('off');
    expect(payload.creativeMemoryRetrievals).toEqual([]);
  });

  it('needs no database, no Qdrant and no benchmark profile', async () => {
    const context = cliContext();
    const code = await runGenerateCli(
      ['--request', join(workspace, 'request.json'), '--fixture-demo', '--plan-only'],
      context,
    );
    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(context.err.join('')).not.toMatch(/DATABASE_URL|Qdrant/);
  });
});

describe('--creative-memory required', () => {
  it('injects governed context into every planning agent', async () => {
    const context = cliContext({
      creativeMemoryDependencies: await dependencies({ profiles: true }),
    });
    const code = await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--plan-only',
        '--json',
        '--creative-memory',
        'required',
      ],
      context,
    );

    expect(code).toBe(EXIT_CODES.SUCCESS);
    const payload = JSON.parse(context.out.join('')) as {
      creativeMemoryMode: string;
      creativeMemoryRetrievals: { agentRole: string; governanceDecision: string }[];
    };
    expect(payload.creativeMemoryMode).toBe('required');
    expect(payload.creativeMemoryRetrievals.length).toBeGreaterThanOrEqual(4);
    expect(
      payload.creativeMemoryRetrievals.every(
        (audit) => audit.governanceDecision === 'CONTEXT_INJECTED',
      ),
    ).toBe(true);
  });

  it('exits with its own code, before any agent runs, when no profile is approved', async () => {
    const context = cliContext({
      creativeMemoryDependencies: await dependencies({ profiles: false }),
    });
    const code = await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--plan-only',
        '--creative-memory',
        'required',
      ],
      context,
    );

    expect(code).toBe(EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE);
    expect(context.err.join('')).toMatch(/MISSING_APPROVED_PROFILE/);
    // Nothing was produced, and nothing was substituted.
    expect(context.out.join('')).toBe('');
  });

  it('refuses when there is no database to read the library from', async () => {
    const context = cliContext();
    const code = await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--plan-only',
        '--creative-memory',
        'required',
      ],
      context,
    );

    expect(code).toBe(EXIT_CODES.CREATIVE_MEMORY_UNAVAILABLE);
    expect(context.err.join('')).toMatch(/DATABASE_URL is not set/);
    expect(context.err.join('')).toMatch(/Refusing to continue/);
  });
});

describe('--creative-memory optional', () => {
  it('uses context when it is available', async () => {
    const context = cliContext({
      creativeMemoryDependencies: await dependencies({ profiles: true }),
    });
    const code = await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--plan-only',
        '--json',
        '--creative-memory',
        'optional',
      ],
      context,
    );

    expect(code).toBe(EXIT_CODES.SUCCESS);
    const payload = JSON.parse(context.out.join('')) as {
      creativeMemoryRetrievals: { governanceDecision: string }[];
    };
    expect(payload.creativeMemoryRetrievals[0]?.governanceDecision).toBe('CONTEXT_INJECTED');
  });

  it('continues with an explicit reason when it is not', async () => {
    const context = cliContext({
      creativeMemoryDependencies: await dependencies({ profiles: false }),
    });
    const code = await runGenerateCli(
      [
        '--request',
        join(workspace, 'request.json'),
        '--fixture-demo',
        '--plan-only',
        '--json',
        '--creative-memory',
        'optional',
      ],
      context,
    );

    expect(code).toBe(EXIT_CODES.SUCCESS);
    const payload = JSON.parse(context.out.join('')) as {
      creativeMemoryRetrievals: { governanceDecision: string; notUsedReason: string }[];
    };
    expect(payload.creativeMemoryRetrievals[0]).toMatchObject({
      governanceDecision: 'NOT_USED',
      notUsedReason: 'NO_APPROVED_PROFILE',
    });
  });
});

describe('the mode itself is validated', () => {
  it('refuses an unknown mode rather than guessing', async () => {
    const context = cliContext();
    const code = await runGenerateCli(
      ['--request', join(workspace, 'request.json'), '--creative-memory', 'sometimes'],
      context,
    );
    expect(code).toBe(2);
    expect(context.err.join('')).toMatch(/required\|optional\|off/);
  });
});

describe('the originality gate', () => {
  async function run(options: { copying: boolean }) {
    const runDirectory = join(workspace, options.copying ? 'run-high' : 'run-medium');
    const deps = await dependencies({ profiles: true });
    const injector = new CreativeMemoryInjector({
      mode: 'required',
      dependencies: deps,
      workspaceId: WORKSPACE_A,
      campaignId: CAMPAIGN,
      platform: 'TIKTOK',
      now: AT,
    });
    const runner = new FakeRunner();

    const result = await runSourceCampaign({
      request: await loadCampaignRequest(join(workspace, 'request.json')),
      reasoningProvider: options.copying
        ? new CopyingReasoningProvider()
        : new ContextAwareFixtureReasoningProvider(),
      reasoningPolicy: {
        runMode: 'FIXTURE_DEMO',
        providerName: 'fixture-replay',
        reasoningModel: 'fixture',
        useFixtureReasoning: true,
      },
      runDirectory,
      repositoryRoot: workspace,
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      workflowRunId: 'gate-run',
      now: AT,
      creativeMemoryMode: 'required',
      injector,
      runner,
    });

    return { result, runner, runDirectory };
  }

  it('blocks a HIGH-risk plan before anything is rendered', async () => {
    const { result, runner, runDirectory } = await run({ copying: true });

    expect(result.exitCode).toBe(EXIT_CODES.ORIGINALITY_RISK_BLOCKED);
    // The gate is upstream of the renderer, and this is the proof: FFmpeg was
    // never invoked, and no timeline was ever written.
    expect(runner.ffmpegInvocations).toEqual([]);
    await expect(readFile(join(runDirectory, 'render-manifest.json'), 'utf8')).rejects.toThrow();

    const report = JSON.parse(
      await readFile(join(runDirectory, 'originality-report.json'), 'utf8'),
    ) as { riskLevel: string; blocked: boolean; signals: { code: string }[] };
    expect(report.riskLevel).toBe('HIGH');
    expect(report.blocked).toBe(true);
    expect(report.signals.map((signal) => signal.code)).toContain('COPIED_REFERENCE_PHRASE');
  });

  it('records a MEDIUM-risk plan for human review and lets it continue', async () => {
    const { result, runDirectory } = await run({ copying: false });

    // The gate passed. The run then stops at the renderer, which this test
    // deliberately does not provide — the subject here is the gate.
    expect(result.exitCode).not.toBe(EXIT_CODES.ORIGINALITY_RISK_BLOCKED);

    const report = JSON.parse(
      await readFile(join(runDirectory, 'originality-report.json'), 'utf8'),
    ) as { riskLevel: string; blocked: boolean; requiresHumanReview: boolean };
    expect(report.blocked).toBe(false);

    const provenance = JSON.parse(
      await readFile(join(runDirectory, 'creative-memory-provenance.json'), 'utf8'),
    ) as {
      mode: string;
      retrievals: unknown[];
      anyReferenceOutputEligible: boolean;
      notice: string;
      divergence: { agentRole: string; contextInjected: boolean }[];
    };
    expect(provenance.mode).toBe('required');
    expect(provenance.retrievals.length).toBeGreaterThanOrEqual(4);
    expect(provenance.anyReferenceOutputEligible).toBe(false);
    expect(provenance.notice).toMatch(/analysis-only/);
    expect(provenance.divergence.every((entry) => entry.contextInjected)).toBe(true);
  });
});

/**
 * A reasoning provider that lifts a reference's craft note verbatim.
 *
 * It exists to prove the block fires on real output rather than on a
 * hand-written report, which is the only version of that assertion worth
 * having.
 */
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

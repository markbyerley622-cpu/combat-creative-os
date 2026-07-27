import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NodeCommandRunner, probeMedia, resolveFfmpegBinaries } from '@combat/media';

import { LAUNCH_EXIT_CODES } from './launch-contracts';
import { runLaunchCli, type LaunchCliContext } from './launch-cli';
import {
  LAUNCH_FIXTURE_AT,
  LAUNCH_FIXTURE_BENCHMARK_PROFILE,
  LAUNCH_FIXTURE_REVIEWER,
  captureSessionJson,
  launchCreativeMemoryDependencies,
  launchRequestJson,
  productionAssetsJson,
  writeLaunchFixtureWorkspace,
} from './launch-fixtures';

/**
 * The acceptance demonstration: a selected concept rendered through the
 * existing FFmpeg path, from synthetic media generated here.
 *
 * **What this proves:** that the selected-concept handoff reaches the real
 * renderer and produces a measured, QA-checked 1080×1920 MP4 — the existing
 * render path, unchanged, driven by an agent-authored and human-approved
 * concept.
 *
 * **What it does not prove:** creative quality. The concepts come from the
 * deterministic launch fixture, the footage is `lavfi` test media, and every
 * artefact of the run says DEMONSTRATION ONLY.
 *
 * Skips loudly when FFmpeg is unavailable, which is the normal outcome under
 * `pnpm test`: Turbo's strict env mode hides `FFMPEG_PATH`/`FFPROBE_PATH`, and
 * CLAUDE.md's rule is that CI never invokes real FFmpeg. To run it:
 *
 *   $env:FFMPEG_PATH = '…\ffmpeg.exe'; $env:FFPROBE_PATH = '…\ffprobe.exe'
 *   pnpm --filter aamp-cli test
 */

const binaries = resolveFfmpegBinaries(process.env);

/** Synchronous: `describe.skip` has to be chosen while the module is evaluated. */
function ffmpegAvailable(): boolean {
  return (
    spawnSync(binaries.ffprobe, ['-version'], { timeout: 15_000 }).status === 0 &&
    spawnSync(binaries.ffmpeg, ['-version'], { timeout: 15_000 }).status === 0
  );
}

const available = ffmpegAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  // eslint-disable-next-line no-console -- a silently skipped acceptance test is worse than a noisy one
  console.warn(
    `[launch acceptance] SKIPPED: FFmpeg not runnable at "${binaries.ffmpeg}". Set FFMPEG_PATH/FFPROBE_PATH to render the launch acceptance demonstration.`,
  );
}

function ffmpeg(args: readonly string[]): void {
  const result = spawnSync(binaries.ffmpeg, ['-y', ...args], { timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed: ${args.join(' ')}\n${result.stderr?.toString() ?? 'no stderr'}`,
    );
  }
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * Synthetic sources with detail but no type.
 *
 * Two QA checks constrain what a fixture source may look like, and both are
 * right to. The renderer animates a still, so a flat colour produces identical
 * frames and is refused as frozen — hence the blocks. And the safe-area check
 * measures outlined type inside the bottom margin, so a source carrying its own
 * text (as `testsrc2` does) fails it — hence the empty lower third.
 */
const STILL_BLOCKS = [
  'drawbox=x=80:y=200:w=920:h=320:color=0x2A303D:t=fill',
  'drawbox=x=120:y=620:w=840:h=240:color=0x3A4150:t=fill',
  'drawbox=x=120:y=920:w=600:h=140:color=0xFF3B30:t=fill',
].join(',');

const STILL_SOURCES = [
  'information.png',
  'prediction.png',
  'discussion.png',
  'card.png',
  'app-information.png',
  'app-prediction.png',
  'app-discussion.png',
] as const;

/** Every source the fixture manifests declare, as real `lavfi` media. */
function generateMedia(directory: string): void {
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x101418:s=1080x1920:r=30:d=12',
    '-vf',
    "drawbox=x='120+420*abs(sin(t))':y=420:w=320:h=320:color=0xFF3B30:t=fill,drawbox=x=120:y=980:w=760:h=180:color=0x2A303D:t=fill",
    '-pix_fmt',
    'yuv420p',
    join(directory, 'arena.mp4'),
  ]);
  for (const name of STILL_SOURCES) {
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=0x101418:s=1080x1920',
      '-vf',
      STILL_BLOCKS,
      '-frames:v',
      '1',
      join(directory, name),
    ]);
  }
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x101418:s=600x200',
    '-vf',
    'drawbox=x=40:y=40:w=200:h=120:color=0xFF3B30:t=fill',
    '-frames:v',
    '1',
    join(directory, 'logo.png'),
  ]);
}

suite('a selected launch concept renders through the existing path', () => {
  let workspace: string;
  let runDirectory: string;
  let outputPath: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'aamp-launch-live-'));

    // Synthetic media, generated here rather than committed — CLAUDE.md forbids
    // committing generated video, and `lavfi` gives every run the same frames.
    generateMedia(workspace);

    // The capture session pins the exact bytes it photographed, so the
    // checksums are taken from the files that were just produced.
    const captures = captureSessionJson();
    for (const asset of captures.assets as Record<string, unknown>[]) {
      asset.checksumSha256 = await sha256(join(workspace, `${String(asset.assetId)}.png`));
    }

    await writeLaunchFixtureWorkspace(workspace, {
      request: launchRequestJson(),
      assets: productionAssetsJson(),
      captures,
      // The real media above must survive: the fixture writer would otherwise
      // replace every declared path with placeholder text.
      writeMedia: false,
    });

    const dependencies = await launchCreativeMemoryDependencies();
    let counter = 0;
    const base = (): LaunchCliContext & { out: string[]; err: string[] } => {
      const out: string[] = [];
      const err: string[] = [];
      return {
        cwd: process.cwd(),
        env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock', ...process.env },
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        now: () => LAUNCH_FIXTURE_AT,
        workflowRunId: 'launch-live-run',
        launchRunId: 'launch-live-000000000001',
        newConceptId: () => `concept-${(counter += 1)}`,
        creativeMemoryDependencies: dependencies,
        out,
        err,
      } as LaunchCliContext & { out: string[]; err: string[] };
    };

    const planContext = base();
    const planCode = await runLaunchCli(
      [
        'plan',
        '--request',
        join(workspace, 'request.json'),
        '--benchmark-profile',
        LAUNCH_FIXTURE_BENCHMARK_PROFILE,
        '--output-dir',
        join(workspace, 'runs'),
        '--fixture-demo',
        '--json',
      ],
      planContext,
    );
    expect(planCode, planContext.err.join('')).toBe(LAUNCH_EXIT_CODES.SUCCESS);
    runDirectory = (JSON.parse(planContext.out.join('')) as { runDirectory: string }).runDirectory;

    const selectContext = base();
    expect(
      await runLaunchCli(
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
      ),
      selectContext.err.join(''),
    ).toBe(LAUNCH_EXIT_CODES.SUCCESS);

    const renderContext = base();
    const renderCode = await runLaunchCli(
      ['render', '--run', runDirectory, '--fixture-demo', '--json'],
      renderContext,
    );
    const rendered = JSON.parse(renderContext.out.join('')) as {
      campaign?: { outputPath?: string };
    };
    if (renderCode !== LAUNCH_EXIT_CODES.SUCCESS) {
      // eslint-disable-next-line no-console -- the QA detail is the whole point of a failure here
      console.error(renderContext.err.join(''));
    }
    expect(renderCode, renderContext.err.join('')).toBe(LAUNCH_EXIT_CODES.SUCCESS);
    outputPath = rendered.campaign?.outputPath ?? '';
  }, 600_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('produces a measured 1080x1920 MP4 at the requested duration', async () => {
    expect(outputPath).toBeTruthy();
    const measured = await probeMedia(new NodeCommandRunner(), outputPath, {
      ffprobePath: binaries.ffprobe,
    });
    expect(measured.mediaType).toBe('VIDEO');
    if (measured.mediaType !== 'VIDEO') return;
    expect(measured.widthPx).toBe(1080);
    expect(measured.heightPx).toBe(1920);
    expect(measured.videoCodec).toBe('h264');
    expect(measured.durationSeconds).toBeCloseTo(15, 1);
  });

  it('passes actual-media QA and still demands human approval', async () => {
    const summary = JSON.parse(
      await readFile(join(runDirectory, 'render', 'run-summary.json'), 'utf8'),
    ) as { qaVerdict: string; requiresHumanApproval: boolean; status: string };
    expect(summary.qaVerdict).toBe('PASS');
    expect(summary.requiresHumanApproval).toBe(true);
    expect(summary.status).toBe('RENDERED_PENDING_HUMAN_APPROVAL');
  });

  it('records the approving reviewer and the concept beside the deliverable', async () => {
    const handoff = JSON.parse(await readFile(join(runDirectory, 'handoff.json'), 'utf8')) as {
      reviewerId: string;
      conceptId: string;
      conceptVersion: number;
    };
    expect(handoff.reviewerId).toBe(LAUNCH_FIXTURE_REVIEWER);
    expect(handoff.conceptId).toBe('concept-1');
    expect(handoff.conceptVersion).toBe(1);
  });

  it('never claims the demonstration was a real campaign', async () => {
    const manifest = JSON.parse(await readFile(join(runDirectory, 'launch-run.json'), 'utf8')) as {
      isRealCampaignRun: boolean;
      caveat: string;
    };
    expect(manifest.isRealCampaignRun).toBe(false);
    expect(manifest.caveat).toMatch(/DEMONSTRATION ONLY/);
  });
});

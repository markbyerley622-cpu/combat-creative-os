import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NodeCommandRunner, probeMedia, resolveFfmpegBinaries } from '@combat/media';

import { runGenerateCli } from '../generate-cli';
import { EXIT_CODES } from '../run-source-campaign';

/**
 * The zero-cost footage-first preview, end to end.
 *
 * The environment is deliberately hostile to the claim being tested:
 * `REASONING_PROVIDER=claude` is set with **no API key**. A normal run refuses
 * outright in that configuration (exit 3, `REAL_REASONING_UNAVAILABLE`). This
 * one must succeed — which is only possible if no reasoning provider is
 * constructed at all. That is a stronger proof than counting calls on a spy:
 * a spy proves nothing was called, this proves there was nothing to call.
 *
 * Requires the generated preview asset root (`pnpm aamp:fixtures`) and a real
 * FFmpeg. Skips loudly rather than pretending to pass, which is the normal
 * outcome under `pnpm test`.
 */

const EXAMPLES = resolve(__dirname, '..', '..', 'examples');
const REPOSITORY_ROOT = resolve(__dirname, '..', '..', '..', '..');
const REQUEST = join(EXAMPLES, 'combat-reviews-preview.request.json');
const PLAN = join(EXAMPLES, 'combat-reviews-preview.plan.json');
const ASSET_ROOT = resolve(REPOSITORY_ROOT, 'packages', 'media', 'fixtures', 'preview-asset-root');

const binaries = resolveFfmpegBinaries(process.env);

function ffmpegAvailable(): boolean {
  return spawnSync(binaries.ffprobe, ['-version'], { timeout: 15_000 }).status === 0;
}

function assetRootPresent(): boolean {
  return (
    spawnSync(process.execPath, [
      '-e',
      `require('fs').statSync(${JSON.stringify(join(ASSET_ROOT, 'combat-clips', 'gym-session.mp4'))})`,
    ]).status === 0
  );
}

const available = ffmpegAvailable() && assetRootPresent();
const suite = available ? describe : describe.skip;

if (!available) {
  // eslint-disable-next-line no-console -- a silently skipped acceptance test is worse than a noisy one
  console.warn(
    `[preview-acceptance] SKIPPED: needs a runnable ffprobe at "${binaries.ffprobe}" and the generated preview asset root at ${ASSET_ROOT}. Run "pnpm aamp:fixtures" and set FFMPEG_PATH/FFPROBE_PATH.`,
  );
}

/**
 * The environment a normal run would refuse. Nothing here can pay for
 * anything: there is no key, and the preview never asks for one.
 */
const HOSTILE_ENV = {
  NODE_ENV: 'development',
  REASONING_PROVIDER: 'claude',
  VIDEO_GENERATION_PROVIDER: 'comfyui',
  ...(process.env.FFMPEG_PATH ? { FFMPEG_PATH: process.env.FFMPEG_PATH } : {}),
  ...(process.env.FFPROBE_PATH ? { FFPROBE_PATH: process.env.FFPROBE_PATH } : {}),
} as const;

suite('zero-cost footage-first preview', () => {
  let outputDirectory: string;
  let runDirectory: string;
  let exitCode: number;
  let stdout = '';
  let stderr = '';

  beforeAll(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), 'aamp-preview-'));
    exitCode = await runGenerateCli(
      [
        '--request',
        REQUEST,
        '--plan-file',
        PLAN,
        '--asset-root',
        ASSET_ROOT,
        '--output-dir',
        outputDirectory,
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: HOSTILE_ENV,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    const entries = await readdir(outputDirectory);
    runDirectory = join(outputDirectory, entries[0] ?? '');
  }, 600_000);

  afterAll(async () => {
    await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
  });

  const artefact = async <T>(name: string): Promise<T> =>
    JSON.parse(await readFile(join(runDirectory, name), 'utf8')) as T;

  it('succeeds where a run needing a reasoning model would be refused', () => {
    // REASONING_PROVIDER=claude with no ANTHROPIC_API_KEY. A campaign run exits
    // REAL_REASONING_UNAVAILABLE here; a preview constructs no provider at all.
    expect(exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(exitCode).not.toBe(EXIT_CODES.REAL_REASONING_UNAVAILABLE);
  });

  it('prints the required declaration before doing any work', () => {
    expect(stderr).toContain('PAID PROVIDER CALLS DISABLED');
    expect(stderr).toContain('AUTONOMOUS REASONING NOT USED');
    expect(stderr).toContain('OUTPUT IS A HUMAN-ASSISTED PREVIEW');
    // And the operational facts an operator needs beforehand.
    expect(stderr).toContain('asset root:');
    expect(stderr).toContain('output directory:');
    expect(stderr).toContain('analysis-only refs:');
    expect(stderr).toContain('expected artefacts:');
  });

  it('states the mode, the planning source and the paid-call count on stdout', () => {
    expect(stdout).toContain('execution mode:    HUMAN_ASSISTED_PREVIEW');
    expect(stdout).toContain('real campaign run: NO');
    expect(stdout).toContain('paid calls:        0');
    expect(stdout).toContain('planning source:   HUMAN_SUPPLIED_STRUCTURED_PLAN');
    // The measured facts, not the requested ones.
    expect(stdout).toContain('LUFS (measured from the file)');
    expect(stdout).toContain('non-zero in-points:');
    expect(stdout).toContain('RENDERED — REQUIRES HUMAN APPROVAL');
  });

  it('records zero paid, reasoning and generation provider calls', async () => {
    const summary = await artefact<{
      paidProviderCalls: number;
      reasoningProviderCalls: number;
      videoGenerationProviderCalls: number;
      planningSource: string;
      executionMode: string;
      isRealCampaignRun: boolean;
    }>('render-summary.json');

    expect(summary.paidProviderCalls).toBe(0);
    expect(summary.reasoningProviderCalls).toBe(0);
    expect(summary.videoGenerationProviderCalls).toBe(0);
    expect(summary.planningSource).toBe('HUMAN_SUPPLIED_STRUCTURED_PLAN');
    expect(summary.executionMode).toBe('HUMAN_ASSISTED_PREVIEW');
    expect(summary.isRealCampaignRun).toBe(false);
  });

  it('never labels itself a production or campaign result', async () => {
    const summary = await artefact<Record<string, unknown>>('render-summary.json');
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain('"executionMode":"PRODUCTION"');
    expect(serialised).not.toContain('"executionMode":"LOCAL_PRODUCTION"');
    expect(summary.requiresHumanApproval).toBe(true);
    expect(String(summary.caveat)).toContain('not an autonomous campaign result');
    expect(stderr).toContain('WARNING: HUMAN_ASSISTED_PREVIEW');
  });

  it('preserves the campaign-prompt hash from the request into the run', async () => {
    const request = await artefact<{ promptSha256: string }>('campaign-request.json');
    const plan = await artefact<{ campaignPromptSha256: string }>('creative-plan.json');
    const summary = await artefact<{ promptSha256: string }>('render-summary.json');

    expect(request.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.campaignPromptSha256).toBe(request.promptSha256);
    expect(summary.promptSha256).toBe(request.promptSha256);
  });

  it('writes every artefact the mode promises', async () => {
    const files = await readdir(runDirectory);
    for (const required of [
      'storyboard.json',
      'storyboard.html',
      'contact-sheet.png',
      'source-selection-report.json',
      'audio-plan.json',
      'render-summary.json',
      'render-manifest.json',
      'asset-preflight.json',
      'asset-provenance.json',
      'creative-plan.json',
      'agent-outputs.json',
      'originality-report.json',
      'creative-scorecard.json',
    ]) {
      expect(files, `missing ${required}`).toContain(required);
    }
    expect(files.some((file) => file.endsWith('.mp4'))).toBe(true);
    expect(files.some((file) => file.endsWith('.qa.json'))).toBe(true);
    expect(files).toContain('storyboard-frames');
  });

  it('produces a real 1080x1920 H.264/AAC MP4 at exactly the requested duration', async () => {
    const summary = await artefact<{ outputPath: string; qaVerdict: string }>(
      'render-summary.json',
    );
    await access(summary.outputPath);

    const probe = await probeMedia(new NodeCommandRunner(), summary.outputPath, {
      ffprobePath: binaries.ffprobe,
    });
    expect(probe.mediaType).toBe('VIDEO');
    if (probe.mediaType !== 'VIDEO') return;

    expect(probe.widthPx).toBe(1080);
    expect(probe.heightPx).toBe(1920);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioCodec).toBe('aac');
    expect(probe.durationSeconds).toBeGreaterThan(14.9);
    expect(probe.durationSeconds).toBeLessThan(15.1);
    expect(summary.qaVerdict).toBe('PASS');
  }, 180_000);

  it('measures loudness, peak, clipping and layout from the produced file', async () => {
    const summary = await artefact<{
      measured: {
        faststart: boolean | null;
        audio: {
          integratedLufs: number | null;
          peakDbtp: number | null;
          peakBasis: string;
          clippedSampleCount: number | null;
          channelCount: number | null;
          sampleRateHz: number | null;
          unavailable: string[];
        } | null;
      };
    }>('render-summary.json');

    const audio = summary.measured.audio;
    expect(audio).not.toBeNull();
    expect(audio?.integratedLufs).not.toBeNull();
    // The plan asks for -14 LUFS; the measurement comes from the master.
    expect(Math.abs((audio?.integratedLufs as number) - -14)).toBeLessThan(2.5);
    expect(audio?.clippedSampleCount).toBe(0);
    expect(audio?.channelCount).toBe(2);
    expect(audio?.sampleRateHz).toBe(48_000);
    expect(audio?.peakBasis).toBe('TRUE_PEAK');
    expect(summary.measured.faststart).toBe(true);
  });

  it('runs every expanded binding check, and every one passes', async () => {
    const files = await readdir(runDirectory);
    const reportName = files.find((file) => file.endsWith('.qa.json')) as string;
    const report = await artefact<{
      verdict: string;
      measurements: { check: string; verdict: string; instrument: string }[];
    }>(reportName);

    expect(report.verdict).toBe('PASS');
    for (const check of [
      'video.duration',
      'video.widthPx',
      'video.heightPx',
      'video.displayAspectRatio',
      'video.codecIsH264',
      'audio.codecIsAac',
      'video.frameRate',
      'video.pixelFormatCompatible',
      'container.faststart',
      'captions.present',
      'cta.presentInFinalInterval',
      'cta.holdDuration',
      'safeArea.captionsInsideBottomMargin',
      'frame.noBlackFrames',
      'frame.noFrozenFrames',
      'audio.streamPresence',
      'audio.integratedLoudness',
      'audio.noClipping',
      'audio.channelLayout',
      'audio.sampleRate',
      'rights.everySourceOutputEligible',
      'provenance.everySourceChecksummed',
      'provenance.sourcesAccountedFor',
      'storyboard.beatCountMatchesRender',
      'storyboard.durationMatchesRender',
      'storyboard.noAnalysisOnlyMaterial',
      'output.checksumRecorded',
    ]) {
      const measurement = report.measurements.find((entry) => entry.check === check);
      expect(measurement, `no measurement for ${check}`).toBeDefined();
      expect(measurement?.verdict, `${check} did not pass`).toBe('PASS');
    }
  });

  it('selects a non-zero, boundary-aware in-point rather than starting every clip at zero', async () => {
    const report = await artefact<{
      deterministic: boolean;
      requiresNoModelOrNetwork: boolean;
      nonZeroInPointCount: number;
      totalVideoSegments: number;
      clipAnalysis: { assetId: string; sceneBoundaries: number[]; blackRegions: unknown[] }[];
      selections: {
        beatId: string;
        inSeconds: number;
        outSeconds: number;
        startsAtNonZeroInPoint: boolean;
        reasons: string[];
        rejectedAlternatives: unknown[];
      }[];
    }>('source-selection-report.json');

    expect(report.deterministic).toBe(true);
    expect(report.requiresNoModelOrNetwork).toBe(true);
    expect(report.nonZeroInPointCount).toBeGreaterThan(0);
    // Real detection found the structure the fixture clip was built with.
    const gym = report.clipAnalysis.find((entry) => entry.assetId === 'clip-gym-session');
    expect(gym?.sceneBoundaries.length).toBeGreaterThan(1);
    expect(gym?.blackRegions.length).toBeGreaterThan(0);
    // Every selection explains itself.
    for (const selection of report.selections) {
      expect(selection.reasons.length).toBeGreaterThan(0);
      expect(selection.outSeconds).toBeGreaterThan(selection.inSeconds);
    }
  });

  it('never lands a chosen window on measured black picture', async () => {
    const report = await artefact<{
      clipAnalysis: {
        assetId: string;
        blackRegions: { startSeconds: number; endSeconds: number }[];
      }[];
      selections: { assetId: string; inSeconds: number; outSeconds: number }[];
    }>('source-selection-report.json');

    for (const selection of report.selections) {
      const analysis = report.clipAnalysis.find((entry) => entry.assetId === selection.assetId);
      for (const region of analysis?.blackRegions ?? []) {
        const overlaps =
          selection.inSeconds < region.endSeconds && selection.outSeconds > region.startSeconds;
        expect(overlaps, `${selection.assetId} was cut over black`).toBe(false);
      }
    }
  });

  it('used only output-eligible material, and no reference contributed a byte', async () => {
    const preflight = await artefact<{
      status: string;
      analysisOnlyReferenceCount: number;
      assets: { assetId: string; directory: string; rightsClassification: string }[];
    }>('asset-preflight.json');

    expect(preflight.status).toBe('ACCEPTED');
    expect(preflight.analysisOnlyReferenceCount).toBeGreaterThan(0);
    for (const asset of preflight.assets) {
      expect(asset.directory, `${asset.assetId} came from references/`).not.toBe('references');
      expect(['OWNED', 'COMMISSIONED', 'LICENSED_FOR_OUTPUT']).toContain(
        asset.rightsClassification,
      );
    }

    const manifest = await artefact<{
      sources: { id: string; license: { usageClass: string }; expectedChecksum?: string }[];
    }>('render-manifest.json');
    for (const source of manifest.sources) {
      expect(['OWNED', 'LICENSED_FOR_OUTPUT']).toContain(source.license.usageClass);
      // Complete provenance: every byte in the output is accounted for.
      expect(source.expectedChecksum).toMatch(/^[0-9a-f]{64}$/);
    }

    const summary = await artefact<{ anyReferenceOutputEligible: boolean }>('render-summary.json');
    expect(summary.anyReferenceOutputEligible).toBe(false);
  });

  it('writes a storyboard that agrees with the render and opens without a server', async () => {
    const storyboard = await artefact<{
      beats: { beatId: string; sourceRelativePath: string; motionTreatment: string }[];
      totalDurationSeconds: number;
      executionMode: string;
      motionCatalogueVersion: number;
    }>('storyboard.json');
    const manifest = await artefact<{
      scenes: { id: string }[];
      output: { durationSeconds: number };
    }>('render-manifest.json');

    expect(storyboard.beats).toHaveLength(manifest.scenes.length);
    expect(storyboard.totalDurationSeconds).toBe(manifest.output.durationSeconds);
    expect(storyboard.executionMode).toBe('HUMAN_ASSISTED_PREVIEW');
    expect(storyboard.motionCatalogueVersion).toBeGreaterThan(0);

    const html = await readFile(join(runDirectory, 'storyboard.html'), 'utf8');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).toContain('contact-sheet.png');
  });

  it('leaks no credential, environment value or absolute library path into any artefact', async () => {
    const files = (await readdir(runDirectory)).filter(
      (file) => file.endsWith('.json') || file.endsWith('.html'),
    );
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      const contents = await readFile(join(runDirectory, file), 'utf8');
      expect(contents, `${file} carries a connection string`).not.toMatch(/postgres(?:ql)?:\/\//i);
      expect(contents, `${file} carries an Anthropic key`).not.toMatch(/sk-ant-/);
      expect(contents, `${file} carries a private key`).not.toContain('BEGIN PRIVATE KEY');
      expect(contents, `${file} references derived reference analysis`).not.toContain(
        '.aamp-reference-analysis',
      );
    }

    // The storyboard in particular is the artefact most likely to be shared.
    const storyboard = await readFile(join(runDirectory, 'storyboard.html'), 'utf8');
    expect(storyboard).not.toMatch(/[A-Za-z]:\\Users/);
  });

  it('is deterministic: the same plan and library render the same bytes', async () => {
    const first = await artefact<{ measured: { checksumSha256: string } }>('render-summary.json');

    const second = await mkdtemp(join(tmpdir(), 'aamp-preview-2-'));
    const noop = (): void => undefined;
    const code = await runGenerateCli(
      [
        '--request',
        REQUEST,
        '--plan-file',
        PLAN,
        '--asset-root',
        ASSET_ROOT,
        '--output-dir',
        second,
      ],
      { cwd: REPOSITORY_ROOT, env: HOSTILE_ENV, stdout: noop, stderr: noop },
    );
    expect(code).toBe(EXIT_CODES.SUCCESS);

    const entries = await readdir(second);
    const summary = JSON.parse(
      await readFile(join(second, entries[0] ?? '', 'render-summary.json'), 'utf8'),
    ) as { measured: { checksumSha256: string } };
    expect(summary.measured.checksumSha256).toBe(first.measured.checksumSha256);
    await rm(second, { recursive: true, force: true }).catch(() => undefined);
  }, 600_000);

  it('fails closed on a malformed plan, before touching the library', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'aamp-preview-bad-'));
    const planPath = join(broken, 'plan.json');
    const plan = JSON.parse(await readFile(PLAN, 'utf8')) as Record<string, any>;
    plan.beats[0].durationSeconds = 99;
    await writeFile(planPath, JSON.stringify(plan), 'utf8');

    let message = '';
    const code = await runGenerateCli(
      [
        '--request',
        REQUEST,
        '--plan-file',
        planPath,
        '--asset-root',
        ASSET_ROOT,
        '--output-dir',
        broken,
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: HOSTILE_ENV,
        stdout: () => undefined,
        stderr: (text) => {
          message += text;
        },
      },
    );

    expect(code).toBe(EXIT_CODES.INVALID_CAMPAIGN_REQUEST);
    expect(message).toContain('targetDurationSeconds');
    const entries = await readdir(broken);
    const runDirectories = entries.filter((entry) => entry !== 'plan.json');
    for (const directory of runDirectories) {
      const produced = await readdir(join(broken, directory));
      expect(
        produced.some((file) => file.endsWith('.mp4')),
        'a rejected plan rendered',
      ).toBe(false);
    }
    await rm(broken, { recursive: true, force: true }).catch(() => undefined);
  }, 180_000);

  it('fails the run and withholds READY when a binding QA check fails', async () => {
    // A cut with no music bed and one very short cue is almost entirely
    // silent, which `audio.noLongSilence` measures from the produced file and
    // fails. The point is not the silence — it is that a failed binding check
    // sends the master to `rejected/`, returns a non-zero exit code, and never
    // reports READY.
    const directory = await mkdtemp(join(tmpdir(), 'aamp-preview-qa-'));
    const planPath = join(directory, 'plan.json');
    const plan = JSON.parse(await readFile(PLAN, 'utf8')) as Record<string, any>;
    delete plan.audio.musicAssetId;
    for (const beat of plan.beats as Record<string, any>[]) {
      beat.audioCues = beat.id === 'hook-count' ? [beat.audioCues[0]] : [];
    }
    plan.beats[0].audioCues[0].role = 'UI_CLICK';
    await writeFile(planPath, JSON.stringify(plan), 'utf8');

    const noop = (): void => undefined;
    const code = await runGenerateCli(
      [
        '--request',
        REQUEST,
        '--plan-file',
        planPath,
        '--asset-root',
        ASSET_ROOT,
        '--output-dir',
        directory,
      ],
      { cwd: REPOSITORY_ROOT, env: HOSTILE_ENV, stdout: noop, stderr: noop },
    );

    expect(code).toBe(EXIT_CODES.QA_FAILURE);
    const runDirectories = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(runDirectories.length).toBe(1);
    const failedRun = join(directory, runDirectories[0] as string);

    const summary = JSON.parse(await readFile(join(failedRun, 'render-summary.json'), 'utf8')) as {
      status: string;
      qaVerdict: string;
      qaFailedChecks: string[];
      outputPath: string;
    };
    expect(summary.qaVerdict).toBe('FAIL');
    expect(summary.status).toBe('REJECTED_BY_QA');
    expect(summary.qaFailedChecks.length).toBeGreaterThan(0);
    // The deliverable path is reachable only through a passing report.
    expect(summary.outputPath).toContain('rejected');

    const files = await readdir(failedRun);
    expect(
      files.some((file) => file.endsWith('.mp4')),
      'a rejected master sat in the run root',
    ).toBe(false);

    const asset = JSON.parse(await readFile(`${summary.outputPath}.asset.json`, 'utf8')) as {
      ingestionStatus: string;
    };
    expect(asset.ingestionStatus).toBe('FAILED');

    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }, 300_000);

  it('refuses to claim a mode a human-authored plan cannot reach', async () => {
    let message = '';
    const code = await runGenerateCli(
      [
        '--request',
        REQUEST,
        '--plan-file',
        PLAN,
        '--asset-root',
        ASSET_ROOT,
        '--execution-mode',
        'production',
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: HOSTILE_ENV,
        stdout: () => undefined,
        stderr: (text) => {
          message += text;
        },
      },
    );
    expect(code).toBe(EXIT_CODES.EXECUTION_MODE_NOT_ATTAINED);
    expect(message).toContain('the creative did not come from a model');
  }, 60_000);
});

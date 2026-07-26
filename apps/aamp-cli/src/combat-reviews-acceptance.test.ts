import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NodeCommandRunner, probeMedia, resolveFfmpegBinaries } from '@combat/media';

import { runGenerateCli } from './generate-cli';
import { EXIT_CODES } from './run-source-campaign';

/**
 * The Combat Reviews acceptance fixture.
 *
 * Runs the committed request — "promote this weekend's coverage; hook on the
 * number of events, then details, predictions and discussion, finish on
 * Download Free" — all the way to a real MP4, and checks the things that
 * actually matter: that the prompt reached the plan, that every source was
 * permitted for output, that the story arc is present, that the exported file
 * is what it claims to be, and that nothing is labelled as something it is not.
 *
 * It runs in `FIXTURE_DEMO` mode, because a real run costs money and CI must
 * not spend it. That has a consequence this file is explicit about: the
 * *creative* is replayed, so this test proves the **pipeline**, not the
 * prompt-specificity of the copy. The prompt-propagation assertions that do
 * prove specificity live in `prompt-propagation.test.ts`, which needs no model.
 *
 * Skips loudly when FFmpeg is unavailable rather than pretending to pass. That
 * is the normal outcome under `pnpm test`: Turbo runs strict env mode, so
 * `FFMPEG_PATH`/`FFPROBE_PATH` are not visible to the task, which matches
 * CLAUDE.md's rule that CI never invokes real FFmpeg. To actually run it:
 *
 *   $env:FFMPEG_PATH = '…\ffmpeg.exe'; $env:FFPROBE_PATH = '…\ffprobe.exe'
 *   pnpm --filter aamp-cli test
 */

const REQUEST = 'apps/aamp-cli/examples/combat-reviews-weekend.request.json';

const binaries = resolveFfmpegBinaries(process.env);

/**
 * Synchronous on purpose: `describe.skip` has to be chosen while the module is
 * being evaluated, and this package compiles to CommonJS where top-level
 * `await` is not available.
 */
function ffmpegAvailable(): boolean {
  const probe = spawnSync(binaries.ffprobe, ['-version'], { timeout: 15_000 });
  return probe.status === 0;
}

const available = ffmpegAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  // eslint-disable-next-line no-console -- a silently skipped acceptance test is worse than a noisy one
  console.warn(
    `[acceptance] SKIPPED: ffprobe not runnable at "${binaries.ffprobe}". Set FFMPEG_PATH/FFPROBE_PATH to run the Combat Reviews acceptance fixture.`,
  );
}

suite('Combat Reviews acceptance fixture', () => {
  let outputDirectory: string;
  let runDirectory: string;
  let exitCode: number;

  beforeAll(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), 'aamp-acceptance-'));
    const noop = (): void => undefined;
    exitCode = await runGenerateCli(
      ['--request', REQUEST, '--fixture-demo', '--output-dir', outputDirectory],
      {
        cwd: process.cwd(),
        env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock', ...process.env },
        stdout: noop,
        stderr: noop,
      },
    );
    const entries = await readdir(outputDirectory);
    runDirectory = join(outputDirectory, entries[0] ?? '');
  }, 300_000);

  afterAll(async () => {
    await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
  });

  const artefact = async <T>(name: string): Promise<T> =>
    JSON.parse(await readFile(join(runDirectory, name), 'utf8')) as T;

  it('completes successfully', () => {
    expect(exitCode).toBe(EXIT_CODES.SUCCESS);
  });

  it('writes every required run artefact', async () => {
    const files = await readdir(runDirectory);
    for (const required of [
      'campaign-request.json',
      'agent-outputs.json',
      'render-manifest.json',
      'source-selection.json',
      'asset-provenance.json',
      'creative-scorecard.json',
      'execution-mode.json',
      'run-summary.json',
    ]) {
      expect(files, `missing ${required}`).toContain(required);
    }
    expect(files.some((file) => file.endsWith('.mp4'))).toBe(true);
    expect(files.some((file) => file.endsWith('.qa.json'))).toBe(true);
  });

  it('carries the campaign prompt into the run, hashed and verbatim', async () => {
    const request = await artefact<{ campaignPrompt: string; promptSha256: string }>(
      'campaign-request.json',
    );
    expect(request.campaignPrompt).toContain('number of events');
    expect(request.campaignPrompt).toContain('Download Free');
    expect(request.promptSha256).toMatch(/^[0-9a-f]{64}$/);

    const summary = await artefact<{ promptSha256: string }>('run-summary.json');
    expect(summary.promptSha256).toBe(request.promptSha256);
  });

  it('used only sources permitted for output', async () => {
    const provenance = await artefact<{
      status: string;
      assets: { assetId: string; rightsClassification: string; checksumSha256: string }[];
    }>('asset-provenance.json');

    expect(provenance.status).toBe('ACCEPTED');
    expect(provenance.assets.length).toBeGreaterThan(0);
    for (const asset of provenance.assets) {
      expect(
        ['OWNED', 'COMMISSIONED', 'LICENSED_FOR_OUTPUT'],
        `${asset.assetId} was not output-permitted`,
      ).toContain(asset.rightsClassification);
      expect(asset.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('covers every visual and audio source in the render manifest with provenance', async () => {
    const manifest = await artefact<{ sources: { id: string; expectedChecksum?: string }[] }>(
      'render-manifest.json',
    );
    const provenance = await artefact<{ assets: { assetId: string; checksumSha256: string }[] }>(
      'asset-provenance.json',
    );
    const known = new Map(provenance.assets.map((asset) => [asset.assetId, asset.checksumSha256]));

    for (const source of manifest.sources) {
      expect(known.has(source.id), `source ${source.id} has no provenance record`).toBe(true);
      expect(source.expectedChecksum).toBe(known.get(source.id));
    }
  });

  it('reflects the requested event → information → prediction → discussion story', async () => {
    const selection = await artefact<{ selections: { storyBeat: string }[] }>(
      'source-selection.json',
    );
    const beats = selection.selections.map((entry) => entry.storyBeat);

    expect(beats[0]).toBe('HOOK');
    expect(beats.at(-1)).toBe('CTA');
    for (const required of ['EVENT_DETAIL', 'INFORMATION', 'PREDICTION', 'DISCUSSION']) {
      expect(beats, `story arc is missing ${required}`).toContain(required);
    }
    // The arc must be in order, not merely present.
    expect(beats.indexOf('EVENT_DETAIL')).toBeLessThan(beats.indexOf('PREDICTION'));
    expect(beats.indexOf('PREDICTION')).toBeLessThan(beats.lastIndexOf('DISCUSSION'));
  });

  it('produces a real 1080x1920 H.264/AAC MP4, verified with ffprobe', async () => {
    const summary = await artefact<{ outputPath: string; qaVerdict: string }>('run-summary.json');
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
  }, 120_000);

  it('is labelled a fixture demonstration, and never as AI-generated footage', async () => {
    const mode = await artefact<{
      runMode: string;
      isRealCampaignRun: boolean;
      fixtureReasoning: boolean;
      generationProvider: string;
      renderingProvider: string;
      caveat: string;
    }>('execution-mode.json');

    expect(mode.runMode).toBe('FIXTURE_DEMO');
    expect(mode.isRealCampaignRun).toBe(false);
    expect(mode.fixtureReasoning).toBe(true);
    expect(mode.caveat).toContain('DEMONSTRATION ONLY');

    // Nothing here was generated by a video model, and the report says so.
    expect(mode.generationProvider).toBe('source-library');
    expect(mode.renderingProvider).toBe('ffmpeg-deterministic');
    expect(JSON.stringify(mode)).not.toMatch(/comfyui|ai-generated/i);
  });

  it('requires human approval and never claims agency-grade quality', async () => {
    const scorecard = await artefact<{
      requiresHumanApproval: boolean;
      agencyGradeClaim: string;
      measuredChecks: { check: string; verdict: string }[];
      notes: string[];
    }>('creative-scorecard.json');

    expect(scorecard.requiresHumanApproval).toBe(true);
    expect(scorecard.agencyGradeClaim).toBe('NOT_ASSESSED');
    expect(scorecard.notes.join(' ')).toContain('not an approval');
    expect(
      scorecard.measuredChecks.find((check) => check.check === 'technical export compliance')
        ?.verdict,
    ).toBe('PASS');

    const summary = await artefact<{ status: string; requiresHumanApproval: boolean }>(
      'run-summary.json',
    );
    expect(summary.status).toBe('RENDERED_PENDING_HUMAN_APPROVAL');
    expect(summary.requiresHumanApproval).toBe(true);
  });
});

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveFfmpegBinaries, type FfmpegBinaries } from '../binaries';
import { NodeCommandRunner } from '../command-runner';
import { probeRaw } from '../ffprobe';
import { runRenderCli } from '../cli/render-cli';
import { measureRegion, sampleFrame, wholeFrame } from '../qa/frame-sampling';
import { parseRenderManifest, type RenderManifest } from './manifest';
import { renderAdvertisement } from './renderer';
import { sha256File } from './source-resolution';

/**
 * The live proof. Everything else in this package is asserted against
 * argument arrays and canned probe output; this test runs the real FFmpeg
 * and the real ffprobe, produces a real MP4, and reads its properties back
 * out of the file that was written.
 *
 * It builds its own small fixtures rather than depending on the checked-in
 * 15-second manifest, so it stays fast enough to sit in the normal suite:
 * a three-second cut still exercises image and video scenes, a transition,
 * controlled motion, an image overlay, burned-in captions, a CTA end card
 * and a mixed, loudness-normalised audio bus.
 *
 * Per docs/aamp-architecture.md §9's "what remains mocked", CI never invokes
 * real FFmpeg. When the binary is absent the suite says so loudly and skips
 * rather than passing quietly.
 */

const NOW = new Date('2026-07-26T12:00:00.000Z');
const runner = new NodeCommandRunner();

let binaries: FfmpegBinaries;
let ffmpegAvailable = false;
let workRoot: string;
let assetsDir: string;
let outputRoot: string;

async function binaryPresent(command: string): Promise<boolean> {
  try {
    const result = await runner.run(command, ['-version'], { timeoutMs: 20_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function integrationManifest(): RenderManifest {
  return parseRenderManifest({
    manifestVersion: 1,
    name: 'integration-3s',
    campaignId: '6f1c2b40-8f8e-4a5d-9a1f-2c7d5e0b3a11',
    workspaceId: '0b2f9d51-7a4e-4c6b-9d33-1e8a4f7c2b90',
    campaignPrompt: 'Three-second live-render proof for Combat Reviews.',
    output: {
      durationSeconds: 3,
      aspectRatio: '9:16',
      widthPx: 1080,
      heightPx: 1920,
      frameRate: 30,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      durationToleranceFrames: 2,
    },
    sources: [
      {
        id: 'clip',
        kind: 'VIDEO',
        path: 'clip.mp4',
        description: 'Licensed clip (synthetic)',
        license: {
          usageClass: 'LICENSED_FOR_OUTPUT',
          rightsHolder: 'Synthetic fixture',
          licenseType: 'ROYALTY_FREE',
          expiresAt: '2099-01-01T00:00:00.000Z',
          attribution: 'Generated fixture',
        },
      },
      {
        id: 'screenshot',
        kind: 'IMAGE',
        path: 'screenshot.png',
        description: 'App screenshot',
        license: {
          usageClass: 'OWNED',
          rightsHolder: 'Combat Reviews',
          licenseType: 'FULL_RIGHTS',
        },
      },
      {
        id: 'logo',
        kind: 'IMAGE',
        path: 'logo.png',
        description: 'Combat Reviews logo',
        license: {
          usageClass: 'OWNED',
          rightsHolder: 'Combat Reviews',
          licenseType: 'FULL_RIGHTS',
        },
      },
      {
        id: 'music',
        kind: 'AUDIO',
        path: 'music.wav',
        description: 'Music bed',
        license: {
          usageClass: 'OWNED',
          rightsHolder: 'Combat Reviews',
          licenseType: 'FULL_RIGHTS',
        },
      },
    ],
    scenes: [
      {
        id: 'open',
        sourceId: 'clip',
        durationSeconds: 1.6,
        trim: { inSeconds: 0.2, outSeconds: 2.2 },
        motion: 'PUSH_IN',
        motionIntensity: 0.8,
      },
      {
        id: 'app',
        sourceId: 'screenshot',
        durationSeconds: 1.6,
        motion: 'PARALLAX',
        motionIntensity: 0.6,
        transitionIn: { kind: 'MASKED_UI_REVEAL', durationSeconds: 0.2 },
      },
    ],
    overlays: [
      {
        id: 'hook',
        kind: 'TEXT',
        text: 'Every card. Every call.',
        startSeconds: 0.2,
        endSeconds: 1.4,
        anchor: 'CENTER',
        offsetYPx: -500,
        fontSizePx: 72,
        animation: 'POP',
      },
    ],
    captions: {
      style: { marginBottomPx: 420 },
      cues: [{ startSeconds: 0.2, endSeconds: 1.4, text: 'Real fights. Real reviews.' }],
    },
    branding: {
      logoSourceId: 'logo',
      anchor: 'TOP_CENTER',
      offsetYPx: 96,
      widthPx: 320,
      windows: [{ startSeconds: 0, endSeconds: 2 }],
    },
    cta: {
      headline: 'Settle the debate',
      subline: 'Free on iOS and Android',
      startSeconds: 2,
      endSeconds: 3,
      backgroundHex: '#0B0B0F',
      logoSourceId: 'logo',
    },
    audio: {
      tracks: [
        {
          id: 'music',
          sourceId: 'music',
          role: 'MUSIC',
          gainDb: -6,
          fadeInSeconds: 0.3,
          fadeOutSeconds: 0.4,
        },
      ],
    },
  });
}

async function buildFixtures(): Promise<void> {
  await mkdir(assetsDir, { recursive: true });
  const jobs: readonly (readonly string[])[] = [
    [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=3:sample_rate=48000',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '32',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-y',
      join(assetsDir, 'clip.mp4'),
    ],
    [
      '-f',
      'lavfi',
      '-i',
      'color=c=0x0E1016:s=1080x1920:d=1',
      '-vf',
      'drawbox=x=0:y=0:w=1080:h=232:color=0xFF3B30:t=fill,drawbox=x=64:y=320:w=952:h=260:color=0x1A1E27:t=fill,drawbox=x=96:y=380:w=520:h=34:color=white:t=fill',
      '-frames:v',
      '1',
      '-y',
      join(assetsDir, 'screenshot.png'),
    ],
    [
      '-f',
      'lavfi',
      '-i',
      'color=c=0xFF3B30:s=560x168:d=1',
      '-vf',
      'drawbox=x=32:y=40:w=120:h=88:color=white:t=fill,drawbox=x=190:y=52:w=330:h=22:color=white:t=fill',
      '-frames:v',
      '1',
      '-y',
      join(assetsDir, 'logo.png'),
    ],
    [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=110:duration=4:sample_rate=48000',
      '-af',
      'aformat=channel_layouts=stereo',
      '-c:a',
      'pcm_s16le',
      '-y',
      join(assetsDir, 'music.wav'),
    ],
  ];
  for (const args of jobs) {
    const result = await runner.run(
      binaries.ffmpeg,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args],
      { timeoutMs: 120_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`fixture generation failed: ${result.stderr}`);
    }
  }
}

beforeAll(async () => {
  binaries = resolveFfmpegBinaries(process.env);
  ffmpegAvailable =
    (await binaryPresent(binaries.ffmpeg)) && (await binaryPresent(binaries.ffprobe));
  if (!ffmpegAvailable) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n[render-integration] SKIPPED — "${binaries.ffmpeg}"/"${binaries.ffprobe}" not found.\n` +
        '  This is the only test that proves a real MP4 is produced. Install FFmpeg, or set\n' +
        '  FFMPEG_PATH / FFPROBE_PATH, and re-run to exercise it.\n',
    );
    return;
  }
  workRoot = await mkdtemp(join(tmpdir(), 'combat-live-render-'));
  assetsDir = join(workRoot, 'assets');
  outputRoot = join(workRoot, 'out');
  await buildFixtures();
}, 300_000);

afterAll(async () => {
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

describe.runIf(process.env.SKIP_FFMPEG_INTEGRATION !== '1')('live FFmpeg render', () => {
  it('produces a real, playable MP4 whose measured properties match the delivery contract', async () => {
    if (!ffmpegAvailable) return;
    const manifest = integrationManifest();

    const result = await renderAdvertisement(runner, {
      manifest,
      manifestDir: assetsDir,
      allowedSourceRoots: [assetsDir],
      outputRoot,
      binaries,
      now: NOW,
    });

    expect(result.status).toBe('READY');
    expect(result.qaReport.verdict).toBe('PASS');

    // Every assertion below is read back out of the produced file, not out
    // of the manifest that requested it.
    const probe = await probeRaw(runner, result.outputPath, { ffprobePath: binaries.ffprobe });
    const video = probe.streams?.find((s) => s.codec_type === 'video');
    const audio = probe.streams?.find((s) => s.codec_type === 'audio');

    expect(probe.format?.format_name).toContain('mp4');
    expect(video?.codec_name).toBe('h264');
    expect(video?.width).toBe(1080);
    expect(video?.height).toBe(1920);
    expect(video?.pix_fmt).toBe('yuv420p');
    expect(audio?.codec_name).toBe('aac');
    expect(Number(probe.format?.duration)).toBeCloseTo(3, 1);

    const size = (await stat(result.outputPath)).size;
    expect(size).toBeGreaterThan(10_000);
    expect(result.asset.checksum).toBe(await sha256File(result.outputPath));
    expect(result.asset.ingestionStatus).toBe('READY');
    expect(result.asset.provenance.derivedFromSources).toHaveLength(4);
  }, 300_000);

  it('burns in the CTA end card and leaves neither the first nor the last frame blank', async () => {
    if (!ffmpegAvailable) return;
    const manifest = integrationManifest();
    const result = await renderAdvertisement(runner, {
      manifest,
      manifestDir: assetsDir,
      allowedSourceRoots: [assetsDir],
      outputRoot,
      binaries,
      now: NOW,
    });

    const sampleOptions = { ffmpegPath: binaries.ffmpeg, workDir: outputRoot };
    const first = await sampleFrame(runner, result.outputPath, 0.1, sampleOptions);
    const cta = await sampleFrame(runner, result.outputPath, 2.6, sampleOptions);

    const firstStats = measureRegion(first, wholeFrame(first));
    expect(firstStats.stdDevLuma).toBeGreaterThan(5);

    // The CTA card's top band is the requested near-black, and the copy
    // band below it is not, because there is type on it.
    const topBand = measureRegion(cta, { x: 0, y: 0, width: cta.widthPx, height: 40 });
    expect(topBand.meanR).toBeLessThan(40);
    expect(topBand.meanG).toBeLessThan(40);
    expect(topBand.meanB).toBeLessThan(50);

    const copyBand = measureRegion(cta, {
      x: 0,
      y: Math.round(cta.heightPx * 0.46),
      width: cta.widthPx,
      height: Math.round(cta.heightPx * 0.24),
    });
    expect(copyBand.stdDevLuma).toBeGreaterThan(5);

    // Every QA check that reads pixels agreed.
    for (const check of [
      'frame.firstNotBlank',
      'frame.finalNotBlank',
      'cta.presentInFinalInterval',
      'captions.present',
    ]) {
      expect(result.qaReport.measurements.find((m) => m.check === check)?.verdict).toBe('PASS');
    }
  }, 300_000);

  it('produces byte-identical output for an identical manifest, and re-uses it on retry', async () => {
    if (!ffmpegAvailable) return;
    const manifest = integrationManifest();
    const request = {
      manifest,
      manifestDir: assetsDir,
      allowedSourceRoots: [assetsDir],
      outputRoot,
      binaries,
      now: NOW,
    };

    const first = await renderAdvertisement(runner, { ...request, reuseExisting: false });
    const firstChecksum = await sha256File(first.outputPath);

    // Re-encode into a separate root, so this compares bytes rather than
    // observing the reuse short-circuit.
    const secondRoot = join(workRoot, 'out-2');
    const second = await renderAdvertisement(runner, {
      ...request,
      outputRoot: secondRoot,
      reuseExisting: false,
    });
    expect(await sha256File(second.outputPath)).toBe(firstChecksum);
    expect(second.renderKey).toBe(first.renderKey);

    // And a retry against the original root does not re-encode at all.
    const retry = await renderAdvertisement(runner, request);
    expect(retry.reused).toBe(true);
    expect(retry.outputPath).toBe(first.outputPath);
  }, 600_000);

  it('renders a silent variant with no audio stream at all', async () => {
    if (!ffmpegAvailable) return;
    const base = integrationManifest();
    const silent = parseRenderManifest({
      ...JSON.parse(JSON.stringify(base)),
      name: 'integration-3s-silent',
      output: { ...JSON.parse(JSON.stringify(base.output)), audioCodec: null },
      audio: undefined,
    });

    const result = await renderAdvertisement(runner, {
      manifest: silent,
      manifestDir: assetsDir,
      allowedSourceRoots: [assetsDir],
      outputRoot,
      binaries,
      now: NOW,
    });

    expect(result.status).toBe('READY');
    const probe = await probeRaw(runner, result.outputPath, { ffprobePath: binaries.ffprobe });
    expect(probe.streams?.some((s) => s.codec_type === 'audio')).toBe(false);
    expect(probe.streams?.some((s) => s.codec_type === 'video')).toBe(true);
    expect(
      result.qaReport.measurements.find((m) => m.check === 'audio.streamPresence')?.verdict,
    ).toBe('PASS');
  }, 300_000);

  it('runs end to end through the CLI entry point and prints the measured facts', async () => {
    if (!ffmpegAvailable) return;
    const manifestPath = join(assetsDir, 'integration.manifest.json');
    const manifest = integrationManifest();
    await writeFile(
      manifestPath,
      JSON.stringify({ ...JSON.parse(JSON.stringify(manifest)), name: 'integration-cli' }, null, 2),
    );

    const out: string[] = [];
    const err: string[] = [];
    const code = await runRenderCli(['--manifest', manifestPath, '--output-root', 'cli-out'], {
      cwd: workRoot,
      env: process.env,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      now: () => NOW,
    });

    expect(err.join('')).toBe('');
    expect(code).toBe(0);

    const printed = out.join('');
    expect(printed).toMatch(/^output path: {2}.+integration-cli-[0-9a-f]{16}\.mp4$/m);
    expect(printed).toMatch(/^duration: {5}3\.0\d{2}s$/m);
    expect(printed).toMatch(/^resolution: {3}1080x1920$/m);
    expect(printed).toMatch(/^codecs: {7}h264 \/ aac$/m);
    expect(printed).toMatch(/^QA status: {4}PASS$/m);
    expect(printed).toMatch(/^QA report: {4}.+\.qa\.json$/m);
    // Six lines and nothing else.
    expect(printed.trim().split('\n')).toHaveLength(6);

    const reportPath = /^QA report: {4}(.+)$/m.exec(printed)?.[1]?.trim();
    expect(reportPath).toBeTruthy();
    const report = JSON.parse(await readFile(reportPath as string, 'utf8'));
    expect(report.verdict).toBe('PASS');
    expect(report.measurements.every((m: { verdict: string }) => m.verdict === 'PASS')).toBe(true);
  }, 600_000);
});

#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { NodeCommandRunner, resolveFfmpegBinaries, type CommandRunner } from '@combat/media';

import { findRepositoryRoot } from '../generate-cli';

/**
 * Synthesises the three reference advertisements the acceptance fixture
 * ingests.
 *
 * They are built from FFmpeg `lavfi` sources — solid colours and test
 * patterns — so the repository never contains, and never needs to obtain, a
 * third-party advertisement in order to test Creative Memory. That is the
 * point: a system for studying other people's work must be testable without
 * holding any of it.
 *
 * The three differ deliberately, so a test can tell them apart on measured
 * properties alone: pacing, scene count, aspect ratio, and where the CTA sits.
 */
export const REFERENCE_FIXTURE_DIRECTORY = join(
  'packages',
  'media',
  'fixtures',
  'reference-generated',
);

export interface ReferenceFixtureSpec {
  readonly filename: string;
  /** Scene durations, in seconds. Their count and spread is what makes each distinct. */
  readonly sceneSeconds: readonly number[];
  readonly widthPx: number;
  readonly heightPx: number;
  readonly colours: readonly string[];
}

/**
 * Fast-cut vertical, slow-cut vertical, and a landscape two-shot. Colours are
 * fully saturated and adjacent scenes are far apart in hue so a content-aware
 * detector sees an unambiguous cut — the fixture exists to test the pipeline's
 * arithmetic, not the detector's sensitivity floor.
 */
export const REFERENCE_FIXTURES: readonly ReferenceFixtureSpec[] = [
  {
    filename: 'ref-fast-cut-vertical.mp4',
    sceneSeconds: [1, 1, 1, 1, 1, 1],
    widthPx: 360,
    heightPx: 640,
    colours: ['red', 'blue', 'green', 'yellow', 'magenta', 'cyan'],
  },
  {
    filename: 'ref-slow-cut-vertical.mp4',
    sceneSeconds: [3, 3, 2],
    widthPx: 360,
    heightPx: 640,
    colours: ['navy', 'orange', 'white'],
  },
  {
    filename: 'ref-landscape-two-shot.mp4',
    sceneSeconds: [2.5, 2.5],
    widthPx: 640,
    heightPx: 360,
    colours: ['purple', 'lime'],
  },
];

export async function generateReferenceFixtures(
  outputDirectory: string,
  binaries: { ffmpeg: string },
  runner: CommandRunner = new NodeCommandRunner(),
): Promise<string[]> {
  await mkdir(outputDirectory, { recursive: true });
  const written: string[] = [];

  for (const fixture of REFERENCE_FIXTURES) {
    const target = join(outputDirectory, fixture.filename);
    const inputs = fixture.sceneSeconds.flatMap((seconds, index) => [
      '-f',
      'lavfi',
      '-i',
      `color=c=${fixture.colours[index] ?? 'gray'}:s=${fixture.widthPx}x${fixture.heightPx}:d=${seconds}:r=30`,
    ]);
    const concat = `${fixture.sceneSeconds.map((_, index) => `[${index}:v]`).join('')}concat=n=${fixture.sceneSeconds.length}:v=1:a=0[v]`;

    const args = [
      '-hide_banner',
      '-nostdin',
      '-y',
      ...inputs,
      '-filter_complex',
      concat,
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      target,
    ];

    // eslint-disable-next-line no-await-in-loop -- fixtures are generated in declaration order
    await runner.run(binaries.ffmpeg, args, { timeoutMs: 120_000 });
    written.push(target);
  }

  return written;
}

if (require.main === module) {
  void (async () => {
    const repositoryRoot = await findRepositoryRoot(process.cwd());
    const outputDirectory = resolve(repositoryRoot, REFERENCE_FIXTURE_DIRECTORY);
    const written = await generateReferenceFixtures(
      outputDirectory,
      resolveFfmpegBinaries(process.env),
    );
    process.stdout.write(
      `${written.length} synthetic reference fixtures written to ${outputDirectory}\n`,
    );
  })().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { resolveFfmpegBinaries } from '../binaries';
import { NodeCommandRunner, type CommandRunner } from '../command-runner';

/**
 * Generates the synthetic media the checked-in fixture manifest refers to.
 *
 * Every asset is produced from FFmpeg's own `lavfi` sources — no downloaded
 * footage, no licensed clip, no copyrighted material of any kind enters the
 * repository, which is what lets the fixture render be re-run by anyone
 * without a rights question. The output directory is git-ignored: generated
 * video does not belong in version control, and regenerating is one command.
 *
 * Deterministic by construction: fixed durations, fixed seeds, fixed encoder
 * settings, no clock.
 */

export const FIXTURE_DIRECTORY = join('packages', 'media', 'fixtures', 'generated');

const CLIP_SECONDS = 6;
const MUSIC_SECONDS = 20;
const VOICEOVER_SECONDS = 5;

interface FixtureJob {
  readonly name: string;
  readonly args: readonly string[];
}

/** A synthetic app screenshot: header band, content cards, a primary action. */
function screenshotJob(
  name: string,
  accentHex: string,
  cardTops: readonly number[],
  highlightIndex: number,
): FixtureJob {
  const boxes = [
    `drawbox=x=0:y=0:w=1080:h=232:color=${accentHex}:t=fill`,
    `drawbox=x=64:y=96:w=420:h=40:color=white:t=fill`,
    `drawbox=x=64:y=156:w=250:h=22:color=white@0.7:t=fill`,
    ...cardTops.map(
      (top, index) =>
        `drawbox=x=56:y=${top}:w=968:h=260:color=${index === highlightIndex ? '0x2A303D' : '0x1A1E27'}:t=fill`,
    ),
    ...cardTops.map((top) => `drawbox=x=96:y=${top + 48}:w=520:h=34:color=white@0.92:t=fill`),
    ...cardTops.map((top) => `drawbox=x=96:y=${top + 108}:w=760:h=22:color=white@0.45:t=fill`),
    ...cardTops.map((top) => `drawbox=x=96:y=${top + 164}:w=180:h=44:color=${accentHex}:t=fill`),
    `drawbox=x=56:y=1740:w=968:h=112:color=${accentHex}:t=fill`,
  ];
  return {
    name,
    args: [
      '-f',
      'lavfi',
      '-i',
      'color=c=0x0E1016:s=1080x1920:d=1',
      '-vf',
      boxes.join(','),
      '-frames:v',
      '1',
    ],
  };
}

export function fixtureJobs(): readonly FixtureJob[] {
  return [
    {
      name: 'logo.png',
      args: [
        '-f',
        'lavfi',
        '-i',
        'color=c=0xFF3B30:s=560x168:d=1',
        '-vf',
        [
          'drawbox=x=32:y=40:w=120:h=88:color=white:t=fill',
          'drawbox=x=56:y=64:w=72:h=40:color=0xFF3B30:t=fill',
          'drawbox=x=190:y=52:w=330:h=22:color=white:t=fill',
          'drawbox=x=190:y=92:w=232:h=22:color=white:t=fill',
        ].join(','),
        '-frames:v',
        '1',
      ],
    },
    screenshotJob('screenshot-fight-card.png', '0xFF3B30', [300, 600, 900, 1200], 1),
    screenshotJob('screenshot-reviews.png', '0x1F6FEB', [320, 640, 960, 1280], 0),
    screenshotJob('screenshot-rankings.png', '0xE0A106', [280, 580, 880, 1180], 2),
    {
      // Landscape, so the vertical cut genuinely exercises COVER cropping.
      name: 'clip-training.mp4',
      args: [
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=1920x1080:rate=30:duration=${CLIP_SECONDS}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=220:duration=${CLIP_SECONDS}:sample_rate=48000`,
        '-filter_complex',
        '[0:v]eq=saturation=0.55:contrast=1.15[v];[1:a]aformat=channel_layouts=stereo[a]',
        '-map',
        '[v]',
        '-map',
        '[a]',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
      ],
    },
    {
      name: 'clip-sparring.mp4',
      args: [
        '-f',
        'lavfi',
        '-i',
        `life=size=480x270:rate=30:ratio=0.12:random_seed=42:death_color=0x0A0A0F:life_color=0xFF3B30:mold=8`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=330:duration=${CLIP_SECONDS}:sample_rate=48000`,
        '-filter_complex',
        '[0:v]scale=1920:1080:flags=neighbor,gblur=sigma=1.2[v];[1:a]aformat=channel_layouts=stereo[a]',
        '-map',
        '[v]',
        '-map',
        '[a]',
        '-t',
        String(CLIP_SECONDS),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
      ],
    },
    {
      name: 'music-bed.wav',
      args: [
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=110:duration=${MUSIC_SECONDS}:sample_rate=48000`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=164.81:duration=${MUSIC_SECONDS}:sample_rate=48000`,
        '-filter_complex',
        '[0:a][1:a]amix=inputs=2:normalize=0,tremolo=f=2:d=0.3,aformat=channel_layouts=stereo[a]',
        '-map',
        '[a]',
        '-c:a',
        'pcm_s16le',
      ],
    },
    {
      // Amplitude-modulated so it has a speech-like envelope; that is what
      // the music-ducking sidechain keys off.
      name: 'voiceover.wav',
      args: [
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=300:duration=${VOICEOVER_SECONDS}:sample_rate=48000`,
        '-af',
        'tremolo=f=6:d=0.85,aformat=channel_layouts=stereo',
        '-c:a',
        'pcm_s16le',
      ],
    },
  ];
}

export async function generateFixtures(
  runner: CommandRunner,
  outputDirectory: string,
  ffmpegPath: string,
): Promise<readonly string[]> {
  await mkdir(outputDirectory, { recursive: true });
  const written: string[] = [];
  for (const job of fixtureJobs()) {
    const target = join(outputDirectory, job.name);
    const result = await runner.run(
      ffmpegPath,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', ...job.args, '-y', target],
      { timeoutMs: 180_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not generate ${job.name}:\n${result.stderr.trim()}`);
    }
    written.push(target);
  }
  return written;
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(__dirname, '..', '..', '..', '..');
  const outputDirectory = resolve(repositoryRoot, FIXTURE_DIRECTORY);
  await mkdir(dirname(outputDirectory), { recursive: true });
  const written = await generateFixtures(
    new NodeCommandRunner(),
    outputDirectory,
    resolveFfmpegBinaries(process.env).ffmpeg,
  );
  process.stdout.write(`${written.length} fixture assets written to ${outputDirectory}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

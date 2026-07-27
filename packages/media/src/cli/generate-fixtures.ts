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
    // --- sound-design cues -------------------------------------------------
    // One synthetic file per audio cue role, so the deterministic mix can be
    // exercised end to end with nothing downloaded and nothing licensed. Each
    // is shaped like the thing it stands in for — a bell rings and decays, an
    // impact is a short transient, a click is shorter still — because the mix
    // rules trim and duck on exactly those envelopes.
    {
      name: 'sfx-fight-bell.wav',
      args: [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:duration=1.6:sample_rate=48000',
        '-af',
        'afade=t=out:st=0.05:d=1.5:curve=exp,aformat=channel_layouts=stereo',
        '-c:a',
        'pcm_s16le',
      ],
    },
    {
      name: 'sfx-crowd.wav',
      args: [
        '-f',
        'lavfi',
        '-i',
        'anoisesrc=d=8:c=pink:r=48000:a=0.35:seed=7',
        '-af',
        'lowpass=f=2200,tremolo=f=0.7:d=0.25,aformat=channel_layouts=stereo',
        '-c:a',
        'pcm_s16le',
      ],
    },
    {
      name: 'sfx-impact.wav',
      args: [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=70:duration=0.7:sample_rate=48000',
        '-af',
        'afade=t=out:st=0:d=0.7:curve=exp,aformat=channel_layouts=stereo',
        '-c:a',
        'pcm_s16le',
      ],
    },
    {
      name: 'sfx-ui-click.wav',
      args: [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=2000:duration=0.12:sample_rate=48000',
        '-af',
        'afade=t=out:st=0:d=0.12:curve=exp,aformat=channel_layouts=stereo',
        '-c:a',
        'pcm_s16le',
      ],
    },
    {
      name: 'sfx-confirmation-pulse.wav',
      args: [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=520:duration=0.9:sample_rate=48000',
        '-af',
        'tremolo=f=9:d=0.5,afade=t=out:st=0.2:d=0.7,aformat=channel_layouts=stereo',
        '-c:a',
        'pcm_s16le',
      ],
    },
    {
      name: 'sfx-cta-emphasis.wav',
      args: [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:duration=2:sample_rate=48000',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2:sample_rate=48000',
        '-filter_complex',
        '[0:a][1:a]amix=inputs=2:normalize=0,afade=t=in:st=0:d=0.15,afade=t=out:st=1.2:d=0.8,aformat=channel_layouts=stereo[a]',
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

export const PREVIEW_ASSET_ROOT_DIRECTORY = join(
  'packages',
  'media',
  'fixtures',
  'preview-asset-root',
);

/**
 * A synthetic stand-in for an operator's real external asset library.
 *
 * The layout is the one the preflight expects — `brand/`, `app-ui/`,
 * `combat-clips/`, `audio/`, `references/` — so the whole external-root path
 * can be exercised without anyone's actual footage. Everything is generated
 * from `lavfi`, so no licensed or copyrighted material enters the repository,
 * and the directory is git-ignored: the manifest that describes it is
 * committed, the media is not.
 *
 * The clips are deliberately **multi-shot and long**. A single-shot six-second
 * clip cannot demonstrate non-zero in-point selection at all — there is only
 * one place to start. These carry several distinct visual sections and a
 * deliberate black stretch, so scene detection has boundaries to find and the
 * black-region rejection has something to reject.
 */
export function previewAssetRootJobs(): readonly FixtureJob[] {
  const section = (pattern: string, seconds: number): string =>
    `${pattern}=size=1920x1080:rate=30:duration=${seconds}`;

  return [
    {
      name: join('brand', 'logo.png'),
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
    {
      name: join('brand', 'brand-card.png'),
      args: [
        '-f',
        'lavfi',
        '-i',
        'color=c=0x0B0B0F:s=1080x1920:d=1',
        '-vf',
        [
          'drawbox=x=0:y=760:w=1080:h=400:color=0x14161D:t=fill',
          'drawbox=x=140:y=880:w=800:h=48:color=white@0.9:t=fill',
          'drawbox=x=140:y=968:w=560:h=32:color=0xFF3B30:t=fill',
        ].join(','),
        '-frames:v',
        '1',
      ],
    },
    screenshotJob(join('app-ui', 'fight-card.png'), '0xFF3B30', [300, 600, 900, 1200], 1),
    screenshotJob(join('app-ui', 'predictions.png'), '0xE0A106', [280, 580, 880, 1180], 2),
    screenshotJob(join('app-ui', 'scorecards.png'), '0x1F6FEB', [320, 640, 960, 1280], 0),
    {
      // Four visually distinct sections with a black stretch in the middle:
      // scene detection finds the joins, and the black region is exactly the
      // kind of stretch an in-point must never land on.
      name: join('combat-clips', 'gym-session.mp4'),
      args: [
        '-f',
        'lavfi',
        '-i',
        section('testsrc2', 5),
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=1920x1080:r=30:d=2',
        '-f',
        'lavfi',
        '-i',
        section('smptebars', 5),
        '-f',
        'lavfi',
        '-i',
        'life=size=480x270:rate=30:ratio=0.12:random_seed=11:death_color=0x0A0A0F:life_color=0xFF3B30:mold=8',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=210:duration=20:sample_rate=48000',
        '-filter_complex',
        [
          '[0:v]eq=saturation=0.6:contrast=1.15,setsar=1[a]',
          '[1:v]setsar=1[b]',
          '[2:v]eq=saturation=0.8,setsar=1[c]',
          '[3:v]scale=1920:1080:flags=neighbor,gblur=sigma=1.2,trim=duration=8,setpts=PTS-STARTPTS,setsar=1[d]',
          '[a][b][c][d]concat=n=4:v=1:a=0[v]',
          '[4:a]aformat=channel_layouts=stereo[out]',
        ].join(';'),
        '-map',
        '[v]',
        '-map',
        '[out]',
        '-shortest',
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
      name: join('combat-clips', 'ring-walk.mp4'),
      args: [
        '-f',
        'lavfi',
        '-i',
        section('smptehdbars', 6),
        '-f',
        'lavfi',
        '-i',
        section('testsrc', 6),
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=290:duration=12:sample_rate=48000',
        '-filter_complex',
        [
          '[0:v]eq=saturation=0.5:contrast=1.2,setsar=1[a]',
          '[1:v]hue=h=200,setsar=1[b]',
          '[a][b]concat=n=2:v=1:a=0[v]',
          '[2:a]aformat=channel_layouts=stereo[out]',
        ].join(';'),
        '-map',
        '[v]',
        '-map',
        '[out]',
        '-shortest',
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
      name: join('audio', 'music-bed.wav'),
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
    ...(
      [
        [
          'fight-bell',
          'sine=frequency=880:duration=1.6:sample_rate=48000',
          'afade=t=out:st=0.05:d=1.5:curve=exp',
        ],
        [
          'crowd',
          'anoisesrc=d=8:c=pink:r=48000:a=0.35:seed=7',
          'lowpass=f=2200,tremolo=f=0.7:d=0.25',
        ],
        [
          'impact',
          'sine=frequency=70:duration=0.7:sample_rate=48000',
          'afade=t=out:st=0:d=0.7:curve=exp',
        ],
        [
          'ui-click',
          'sine=frequency=2000:duration=0.12:sample_rate=48000',
          'afade=t=out:st=0:d=0.12:curve=exp',
        ],
        [
          'confirmation-pulse',
          'sine=frequency=520:duration=0.9:sample_rate=48000',
          'tremolo=f=9:d=0.5,afade=t=out:st=0.2:d=0.7',
        ],
        [
          'cta-emphasis',
          'sine=frequency=392:duration=2:sample_rate=48000',
          'afade=t=in:st=0:d=0.15,afade=t=out:st=1.2:d=0.8',
        ],
      ] as const
    ).map(([name, source, filter]) => ({
      name: join('audio', `sfx-${name}.wav`),
      args: [
        '-f',
        'lavfi',
        '-i',
        source,
        '-af',
        `${filter},aformat=channel_layouts=stereo`,
        '-c:a',
        'pcm_s16le',
      ],
    })),
    {
      // Analysis-only by construction: it exists so the preflight has
      // something to count and refuse. Nothing here may ever reach an output,
      // and the manifest that describes the library does not list it.
      name: join('references', 'benchmark-placeholder.mp4'),
      args: [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=30:duration=3',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '32',
        '-pix_fmt',
        'yuv420p',
      ],
    },
  ];
}

export async function generateFixtures(
  runner: CommandRunner,
  outputDirectory: string,
  ffmpegPath: string,
  jobs: readonly FixtureJob[] = fixtureJobs(),
): Promise<readonly string[]> {
  await mkdir(outputDirectory, { recursive: true });
  const written: string[] = [];
  for (const job of jobs) {
    const target = join(outputDirectory, job.name);
    await mkdir(dirname(target), { recursive: true });
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
  const runner = new NodeCommandRunner();
  const ffmpeg = resolveFfmpegBinaries(process.env).ffmpeg;

  const outputDirectory = resolve(repositoryRoot, FIXTURE_DIRECTORY);
  await mkdir(dirname(outputDirectory), { recursive: true });
  const written = await generateFixtures(runner, outputDirectory, ffmpeg);
  process.stdout.write(`${written.length} fixture assets written to ${outputDirectory}\n`);

  const previewRoot = resolve(repositoryRoot, PREVIEW_ASSET_ROOT_DIRECTORY);
  const previewWritten = await generateFixtures(
    runner,
    previewRoot,
    ffmpeg,
    previewAssetRootJobs(),
  );
  process.stdout.write(
    `${previewWritten.length} preview asset-root files written to ${previewRoot}\n`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

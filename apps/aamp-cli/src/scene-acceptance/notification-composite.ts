import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';
import {
  LTX_SUPPORTED_FPS,
  LTX_SUPPORTED_HEIGHT_PX,
  LTX_SUPPORTED_WIDTH_PX,
} from '@combat/providers';

import { StoryboardVideoError } from '../storyboard-video/failures';
import type { NotificationBrief } from './acceptance-brief';
import {
  buildNotificationTimeline,
  NOTIFICATION_TREATMENT_VERSION,
  type CardRect,
  type NotificationTimeline,
} from './notification-timeline';
import {
  renderNotificationSurfaces,
  type RenderedNotificationSurfaces,
} from './notification-surface';

/**
 * The Combat Reviews notification, composited **after** generation.
 *
 * That ordering is the whole point of this module. A generative model asked to
 * draw a notification draws a plausible one: invented lettering, an invented
 * mark, an invented count of things happening this weekend. Every one of those
 * would be a factual claim nobody made. So the model is asked for a clean,
 * unlit product plate and the card is built here, deterministically, from the
 * real owned mark and copy a person wrote.
 *
 * What changed from the first treatment is *how* the card is built. It used to
 * be a `drawbox` rectangle with a subtitle line over it. Two constraints made
 * that treatment what it was, and only one of them is still binding:
 *
 * - **`drawbox` cannot animate.** Its `t` in an expression is the box
 *   *thickness*, not the timestamp, and it has no per-frame evaluation mode.
 *   Still true, and still the reason the entrance is a series of complete
 *   states on disjoint `enable` windows rather than an interpolation.
 * - **Copy must never become filter grammar.** Also still true — and now
 *   satisfied more completely than the subtitle route ever did. The copy is
 *   rasterised into a transparent sheet before FFmpeg is invoked, so no
 *   authored string reaches this process at all: not as a filter argument, and
 *   not as a subtitle file named from one. Only integers, validated positions
 *   and timestamps are interpolated below.
 *
 * The card is screen-space, and the brief has to say so and say why. It is not
 * seated inside the handset for this scene because the authoritative plate is
 * shot over the subject's hands with the **rear** of the phone toward the
 * viewer: there is no display in frame to seat anything in. Tracked in-screen
 * treatment belongs to the later scenes whose plates face the viewer.
 */

export const NOTIFICATION_COMPOSITE_VERSION = 2 as const;
export const SURFACE_DIRECTORY = 'notification-surface';

export interface NotificationCompositeResult {
  readonly compositeVersion: typeof NOTIFICATION_COMPOSITE_VERSION;
  readonly treatmentVersion: typeof NOTIFICATION_TREATMENT_VERSION;
  readonly outputPath: string;
  readonly checksumSha256: string;
  readonly treatment: NotificationBrief['treatment'];
  readonly headline: string;
  readonly logoAssetPath: string;
  readonly logoChecksumSha256: string;
  /** The card's resting rectangle, in delivery pixels. */
  readonly cardRect: CardRect;
  /** Everything the treatment can mark across every state, shadow included. */
  readonly occupiedRect: CardRect;
  readonly withinSafeBounds: boolean;
  readonly timeline: NotificationTimeline;
  readonly surfaces: RenderedNotificationSurfaces;
  readonly notes: readonly string[];
}

export interface CompositeNotificationOptions {
  readonly sourceClipPath: string;
  readonly outputPath: string;
  readonly notification: NotificationBrief;
  readonly logoPath: string;
  /** How much of the source is kept. The Scene-1 slot, not the whole generation. */
  readonly outputDurationSeconds: number;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

export async function compositeNotification(
  options: CompositeNotificationOptions,
): Promise<NotificationCompositeResult> {
  const brief = options.notification;
  if (brief.treatment !== 'LAYERED_SURFACE_COMPOSITE') {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `notification treatment ${brief.treatment} is declared in the brief but only LAYERED_SURFACE_COMPOSITE is implemented. A treatment the code cannot execute is refused by name rather than approximated with the one that exists.`,
    );
  }

  const frame = { widthPx: LTX_SUPPORTED_WIDTH_PX, heightPx: LTX_SUPPORTED_HEIGHT_PX };
  const timeline = buildNotificationTimeline(brief, frame);
  if (!timeline.withinSafeBounds) {
    const rect = timeline.occupiedRect;
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `the notification (${rect.xPx},${rect.yPx} ${rect.widthPx}x${rect.heightPx}, shadow and accent glow included) leaves the ${brief.safeMarginPx}px mobile-safe margin of the ${frame.widthPx}x${frame.heightPx} frame.`,
    );
  }
  if (brief.readableUntilSeconds > options.outputDurationSeconds + 1e-6) {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `the notification is required to stay readable to ${brief.readableUntilSeconds}s but only ${options.outputDurationSeconds}s of picture is being produced.`,
    );
  }

  const outputDirectory = dirnameOf(options.outputPath);
  await mkdir(outputDirectory, { recursive: true });

  options.onProgress?.(
    `laying out the notification surface: ${timeline.states.length} complete states, ${brief.entranceSteps}-step entrance from ${brief.entranceStartSeconds}s settling at ${brief.entranceSettleSeconds}s, one accent pulse ${brief.pulseStartSeconds}s–${brief.pulseEndSeconds}s`,
  );

  const surfaces = await renderNotificationSurfaces({
    brief,
    frame,
    states: timeline.states,
    assetRect: timeline.occupiedRect,
    logoPath: options.logoPath,
    outputDirectory: join(outputDirectory, SURFACE_DIRECTORY),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  const filterComplex = buildFilterComplex({ frame, timeline });

  // Every surface is referenced relative to the job directory. A Windows
  // `C:\…` path is not the problem here that it is inside a filter argument,
  // but keeping one convention means a future filter-side reference cannot
  // reintroduce the `:` collision the render path documents.
  const surfaceArguments = surfaces.states.flatMap((state) => [
    '-i',
    toPosix(relative(outputDirectory, state.absolutePath)),
  ]);

  options.onProgress?.('compositing the notification over the Scene-1 picture');
  const result = await options.runner.run(
    options.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      toPosix(relative(outputDirectory, options.sourceClipPath)),
      ...surfaceArguments,
      '-filter_complex',
      filterComplex,
      '-map',
      '[out]',
      '-t',
      num(options.outputDurationSeconds),
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '17',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(LTX_SUPPORTED_FPS),
      '-movflags',
      '+faststart',
      '-y',
      basename(options.outputPath),
    ],
    { timeoutMs: 600_000, cwd: outputDirectory },
  );
  if (result.exitCode !== 0) {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `the notification composite failed: ${result.stderr.trim().slice(-500)}`,
    );
  }

  const bytes = await readFile(options.outputPath);
  return {
    compositeVersion: NOTIFICATION_COMPOSITE_VERSION,
    treatmentVersion: NOTIFICATION_TREATMENT_VERSION,
    outputPath: options.outputPath,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    treatment: brief.treatment,
    headline: brief.headline,
    logoAssetPath: options.logoPath,
    logoChecksumSha256: surfaces.markChecksumSha256,
    cardRect: timeline.restRect,
    occupiedRect: timeline.occupiedRect,
    withinSafeBounds: timeline.withinSafeBounds,
    timeline,
    surfaces,
    notes: [
      'The notification was composited after generation. LTX never saw a card, a mark, lettering or a product interface, and could not have drawn one.',
      'The mark is the owned Combat Reviews asset, inlined from its own bytes. No mark is redrawn by this pipeline.',
      'No authored string reaches FFmpeg. The copy is rasterised into transparent surfaces before the compositor is invoked, so it is never filter grammar and never a subtitle file named from one.',
      'Every state is a complete, assembled card. The entrance scales and lifts a finished surface; there is no frame on which the rectangle exists and its contents do not.',
      'The accent fires once and then holds at its resting opacity to the cut. There is no fade-out.',
      'The card is screen-space motion graphics, not tracked into the handset. The brief records why.',
      'No count of events is stated. The copy is what a person authored and carries no number.',
    ],
  };
}

/**
 * The overlay chain: one complete surface per state, on disjoint windows.
 *
 * Compositing happens in RGB rather than in the delivery's subsampled chroma,
 * because the accent edge is a saturated red five pixels tall against a
 * near-white surface — exactly the case where 4:2:0 blending smears the edge
 * that the whole treatment is built around. The conversion to `yuv420p` happens
 * once, at the end.
 *
 * Only integers and timestamps are interpolated. Nothing authored appears here.
 */
export function buildFilterComplex(input: {
  frame: { widthPx: number; heightPx: number };
  timeline: NotificationTimeline;
}): string {
  const { frame, timeline } = input;
  const chain: string[] = [
    `[0:v]scale=${num(frame.widthPx)}:${num(frame.heightPx)}:flags=lanczos,setsar=1,format=rgba[base0]`,
  ];
  timeline.states.forEach((state, index) => {
    const from = `[base${index}]`;
    const to = index === timeline.states.length - 1 ? '[composited]' : `[base${index + 1}]`;
    chain.push(
      // `eof_action=repeat` holds the single-frame surface for the whole window;
      // without it the overlay ends at the surface's one frame.
      `${from}[${index + 1}:v]overlay=x=0:y=0:format=auto:eof_action=repeat:enable='between(t,${num(state.fromSeconds)},${num(state.toSeconds)})'${to}`,
    );
  });
  chain.push('[composited]format=yuv420p[out]');
  return chain.join(';');
}

/** Every number reaching filter text goes through here. */
function num(value: number): string {
  if (!Number.isFinite(value)) {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      'a non-finite number reached the notification filter graph',
    );
  }
  return Number(value.toFixed(6)).toString();
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index <= 0 ? '.' : path.slice(0, index);
}

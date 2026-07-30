import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { escapeAssText, toAssColor, toAssTimestamp } from '@combat/media';
import type { CommandRunner, FfmpegBinaries } from '@combat/media';
import {
  LTX_SUPPORTED_FPS,
  LTX_SUPPORTED_HEIGHT_PX,
  LTX_SUPPORTED_WIDTH_PX,
} from '@combat/providers';

import { StoryboardVideoError } from '../storyboard-video/failures';
import type { NotificationBrief } from './acceptance-brief';

/**
 * The Combat Reviews notification, composited **after** LTX.
 *
 * That ordering is the whole point of this module. A generative model asked to
 * draw a notification draws a plausible one: invented lettering, an invented
 * mark, an invented count of things happening this weekend. Every one of those
 * would be a factual claim nobody made. So the model is asked for a clean,
 * unlit product plate and the card is drawn here, deterministically, from the
 * real owned mark and copy a person wrote.
 *
 * Four constraints carried over from the existing motion work, all learned the
 * hard way and all still true:
 *
 * - **`drawbox` cannot animate.** Its `t` in an expression is the box
 *   *thickness*, not the timestamp, and it has no per-frame evaluation mode.
 *   Movement is a series of statically-positioned boxes with disjoint `enable`
 *   windows — which is exactly how the entrance settles here.
 * - **Copy never becomes filter grammar.** The headline travels in a generated
 *   ASS file and reaches FFmpeg as a bare filename, the same rule the render
 *   path has always followed. Only numbers and validated colours are
 *   interpolated into `filter_complex`.
 * - **The mark is the owned asset, never redrawn.** It is overlaid from the
 *   real file. A re-typeset mark is a forgery of our own brand, however
 *   carefully it is copied.
 * - **One accent pulse, and it is a discrete window.** Not a glow ramp, not a
 *   loop. It fires once, on a stated interval.
 *
 * The card is screen-space, and the brief has to say so and say why. It is not
 * seated inside the handset for this scene because the authoritative plate is
 * shot over the subject's hands with the **rear** of the phone toward the
 * viewer: there is no display in frame to seat anything in. Tracked in-screen
 * treatment belongs to the later scenes whose plates face the viewer.
 */

export const NOTIFICATION_COMPOSITE_VERSION = 1 as const;
export const NOTIFICATION_ASS_FILENAME = 'notification.ass';

/**
 * The card's internal spacing, as fractions of its own height.
 *
 * Stated once, here, because the mark is placed by the filter graph and the
 * type is placed by the ASS file — two different mechanisms that have to agree
 * about where the mark ends. When they were derived separately the type sat on
 * top of the mark's right edge, which is exactly the kind of defect a single
 * shared constant makes impossible.
 *
 * `TYPE_LEFT` clears the mark: the mark is `MARK_HEIGHT` tall at roughly 1.45:1,
 * so it ends near `MARK_LEFT + 0.67`, and the type starts well beyond that.
 */
export const MARK_LEFT_FRACTION = 0.28;
export const MARK_HEIGHT_FRACTION = 0.46;
export const TYPE_LEFT_FRACTION = 1.15;

/** How the card settles: three discrete widths, then rest. Disjoint windows. */
export const SETTLE_STEPS: readonly { readonly widthFraction: number }[] = [
  { widthFraction: 0.94 },
  { widthFraction: 1.03 },
  { widthFraction: 1.0 },
];

export interface NotificationCompositeResult {
  readonly outputPath: string;
  readonly checksumSha256: string;
  readonly assFileName: string;
  readonly treatment: NotificationBrief['treatment'];
  readonly headline: string;
  readonly logoAssetPath: string;
  readonly logoChecksumSha256: string;
  /** The card's resting rectangle, in delivery pixels. */
  readonly cardRect: {
    readonly xPx: number;
    readonly yPx: number;
    readonly widthPx: number;
    readonly heightPx: number;
  };
  readonly withinSafeBounds: boolean;
  readonly settleWindows: readonly { readonly fromSeconds: number; readonly toSeconds: number }[];
  readonly pulse: { readonly fromSeconds: number; readonly toSeconds: number };
  readonly notes: readonly string[];
}

export interface CompositeNotificationOptions {
  readonly rawClipPath: string;
  readonly outputPath: string;
  readonly notification: NotificationBrief;
  readonly logoPath: string;
  readonly clipDurationSeconds: number;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}

export async function compositeNotification(
  options: CompositeNotificationOptions,
): Promise<NotificationCompositeResult> {
  const brief = options.notification;
  if (brief.treatment !== 'SCREEN_SPACE_MOTION_GRAPHICS') {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `notification treatment ${brief.treatment} is declared in the brief but only SCREEN_SPACE_MOTION_GRAPHICS is implemented. A treatment the code cannot execute is refused by name rather than approximated with the one that exists.`,
    );
  }

  const logoBytes = await readFile(options.logoPath).catch(() => null);
  if (!logoBytes || logoBytes.byteLength === 0) {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `the Combat Reviews mark at ${options.logoPath} could not be read. The card is never drawn with a substitute mark.`,
    );
  }

  const geometry = resolveCardGeometry(brief);
  if (!geometry.withinSafeBounds) {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `the notification card (${geometry.xPx},${geometry.yPx} ${geometry.widthPx}x${geometry.heightPx}) leaves the ${brief.safeMarginPx}px mobile-safe margin of the ${LTX_SUPPORTED_WIDTH_PX}x${LTX_SUPPORTED_HEIGHT_PX} frame.`,
    );
  }

  const settleWindows = SETTLE_STEPS.map((_, index) => ({
    fromSeconds: Number((brief.entranceStartSeconds + index * brief.settleStepSeconds).toFixed(6)),
    toSeconds: Number(
      (brief.entranceStartSeconds + (index + 1) * brief.settleStepSeconds).toFixed(6),
    ),
  }));
  const restFrom = settleWindows[settleWindows.length - 1]?.toSeconds ?? brief.entranceStartSeconds;

  // The headline arrives with the card at rest, so the type is never scaled by
  // the settle: soft or stretched type is the one thing a viewer reads as an
  // enlarged screenshot rather than an interface.
  const assPath = join(dirnameOf(options.outputPath), NOTIFICATION_ASS_FILENAME);
  await mkdir(dirnameOf(options.outputPath), { recursive: true });
  await writeFile(
    assPath,
    buildNotificationAss({
      brief,
      geometry,
      fromSeconds: restFrom,
      toSeconds: options.clipDurationSeconds,
    }),
    'utf8',
  );

  const args = buildFilterArguments({
    brief,
    geometry,
    settleWindows,
    restFrom,
    clipDurationSeconds: options.clipDurationSeconds,
  });

  options.onProgress?.(
    `compositing the Combat Reviews notification over the raw clip (${brief.treatment}, entrance ${brief.entranceStartSeconds}s, one accent pulse at ${brief.pulseStartSeconds}s)`,
  );

  const result = await options.runner.run(
    options.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      options.rawClipPath,
      '-i',
      options.logoPath,
      '-filter_complex',
      args.filterComplex,
      '-map',
      '[out]',
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
    // `cwd` is the job directory and the subtitle file is referenced by bare
    // filename: a Windows `C:\…` path inside a filter argument collides with
    // the `:` option separator. Same constraint the render path documents.
    { timeoutMs: 600_000, cwd: dirnameOf(options.outputPath) },
  );
  if (result.exitCode !== 0) {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `the notification composite failed: ${result.stderr.trim().slice(-500)}`,
    );
  }

  const bytes = await readFile(options.outputPath);
  return {
    outputPath: options.outputPath,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    assFileName: NOTIFICATION_ASS_FILENAME,
    treatment: brief.treatment,
    headline: brief.headline,
    logoAssetPath: options.logoPath,
    logoChecksumSha256: createHash('sha256').update(logoBytes).digest('hex'),
    cardRect: {
      xPx: geometry.xPx,
      yPx: geometry.yPx,
      widthPx: geometry.widthPx,
      heightPx: geometry.heightPx,
    },
    withinSafeBounds: geometry.withinSafeBounds,
    settleWindows,
    pulse: {
      fromSeconds: brief.pulseStartSeconds,
      toSeconds: Number((brief.pulseStartSeconds + brief.pulseDurationSeconds).toFixed(6)),
    },
    notes: [
      'The notification was composited after generation. LTX never saw a card, a mark, lettering or a product interface, and could not have drawn one.',
      'The mark is the owned Combat Reviews asset, overlaid from its own file. No mark is redrawn by this pipeline.',
      'The headline travels in a generated ASS file and never becomes filter-graph grammar.',
      'The card is screen-space motion graphics, not tracked into the handset. The brief records why.',
      'No count of events is stated. The headline is the copy a person authored and carries no number.',
    ],
  };
}

interface CardGeometry {
  readonly xPx: number;
  readonly yPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly withinSafeBounds: boolean;
}

export function resolveCardGeometry(brief: NotificationBrief): CardGeometry {
  const widthPx = even(LTX_SUPPORTED_WIDTH_PX - 2 * brief.safeMarginPx);
  const xPx = even(Math.round((LTX_SUPPORTED_WIDTH_PX - widthPx) / 2));
  const yPx = even(brief.cardTopPx);
  const heightPx = even(brief.cardHeightPx);
  const withinSafeBounds =
    xPx >= brief.safeMarginPx &&
    yPx >= brief.safeMarginPx &&
    xPx + widthPx <= LTX_SUPPORTED_WIDTH_PX - brief.safeMarginPx &&
    yPx + heightPx <= LTX_SUPPORTED_HEIGHT_PX - brief.safeMarginPx;
  return { xPx, yPx, widthPx, heightPx, withinSafeBounds };
}

/**
 * The card, the mark and the accent, as statically-positioned boxes with
 * disjoint `enable` windows.
 *
 * Every number reaching the filter string is computed here and formatted by
 * `num`; every colour goes through `ffmpegColor`. No authored string appears
 * anywhere in this graph.
 */
function buildFilterArguments(input: {
  brief: NotificationBrief;
  geometry: CardGeometry;
  settleWindows: readonly { fromSeconds: number; toSeconds: number }[];
  restFrom: number;
  clipDurationSeconds: number;
}): { filterComplex: string } {
  const { brief, geometry } = input;
  const card = ffmpegColor(brief.cardColorHex);
  const accent = ffmpegColor(brief.accentColorHex);

  // The mark sits inside the card's left margin, vertically centred, at a
  // height that leaves the type room. Derived, never hand-placed twice.
  const logoHeight = even(Math.round(geometry.heightPx * MARK_HEIGHT_FRACTION));
  const logoX = geometry.xPx + even(Math.round(geometry.heightPx * MARK_LEFT_FRACTION));
  const logoY = geometry.yPx + even(Math.round((geometry.heightPx - logoHeight) / 2));

  const steps = input.settleWindows.map((window, index) => {
    const fraction = SETTLE_STEPS[index]?.widthFraction ?? 1;
    const width = even(Math.round(geometry.widthPx * fraction));
    const height = even(Math.round(geometry.heightPx * fraction));
    const x = even(Math.round(geometry.xPx + (geometry.widthPx - width) / 2));
    const y = even(Math.round(geometry.yPx + (geometry.heightPx - height) / 2));
    return `drawbox=x=${num(x)}:y=${num(y)}:w=${num(width)}:h=${num(height)}:color=${card}:t=fill:enable='between(t,${num(window.fromSeconds)},${num(window.toSeconds)})'`;
  });

  const resting = `drawbox=x=${num(geometry.xPx)}:y=${num(geometry.yPx)}:w=${num(geometry.widthPx)}:h=${num(geometry.heightPx)}:color=${card}:t=fill:enable='gte(t,${num(input.restFrom)})'`;

  // One controlled pulse: a full-width accent rule along the card's lower
  // edge, on a single disjoint window. Not a glow, not a loop.
  const pulseHeight = even(Math.max(6, Math.round(geometry.heightPx * 0.05)));
  const pulse = `drawbox=x=${num(geometry.xPx)}:y=${num(geometry.yPx + geometry.heightPx - pulseHeight)}:w=${num(geometry.widthPx)}:h=${num(pulseHeight)}:color=${accent}:t=fill:enable='between(t,${num(brief.pulseStartSeconds)},${num(brief.pulseStartSeconds + brief.pulseDurationSeconds)})'`;

  const base = [
    `[0:v]scale=${num(LTX_SUPPORTED_WIDTH_PX)}:${num(LTX_SUPPORTED_HEIGHT_PX)}:flags=lanczos,setsar=1,format=yuv420p`,
    ...steps,
    resting,
    pulse,
  ].join(',');

  const filterComplex = [
    `${base}[plate]`,
    `[1:v]scale=-2:${num(logoHeight)}:flags=lanczos[mark]`,
    `[plate][mark]overlay=x=${num(logoX)}:y=${num(logoY)}:enable='gte(t,${num(input.restFrom)})'[marked]`,
    `[marked]subtitles=${NOTIFICATION_ASS_FILENAME}[out]`,
  ].join(';');

  return { filterComplex };
}

/**
 * The headline, positioned over the card and left of nothing it could cover.
 *
 * `\pos` places it against the card's own rectangle rather than against a
 * bottom-centre margin, and the fade is short: a notification appears, it does
 * not drift in.
 */
export function buildNotificationAss(input: {
  brief: NotificationBrief;
  geometry: CardGeometry;
  fromSeconds: number;
  toSeconds: number;
}): string {
  const { brief, geometry } = input;
  const textX = geometry.xPx + Math.round(geometry.heightPx * TYPE_LEFT_FRACTION);
  const textY = geometry.yPx + Math.round(geometry.heightPx / 2);

  const header = [
    '[Script Info]',
    '; Generated by the Scene-1 LTX acceptance run — do not edit; regenerate from the brief.',
    'ScriptType: v4.00+',
    `PlayResX: ${LTX_SUPPORTED_WIDTH_PX}`,
    `PlayResY: ${LTX_SUPPORTED_HEIGHT_PX}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Notification',
      brief.fontFamily.replace(/[,\r\n]/g, ' ').trim() || 'Arial',
      String(brief.fontSizePx),
      toAssColor(brief.headlineColorHex),
      toAssColor(brief.headlineColorHex),
      toAssColor(brief.cardColorHex),
      toAssColor(brief.cardColorHex, 255),
      '-1',
      '0',
      '0',
      '0',
      '100',
      '100',
      '2',
      '0',
      '1',
      '0',
      '0',
      // 4 = middle-left, so `\pos` anchors the type at the card's own baseline.
      '4',
      '0',
      '0',
      '0',
      '1',
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const dialogue = [
    'Dialogue: 0',
    toAssTimestamp(input.fromSeconds),
    toAssTimestamp(input.toSeconds),
    'Notification',
    '',
    '0',
    '0',
    '0',
    '',
    `{\\pos(${textX},${textY})\\fad(90,0)}${escapeAssText(brief.headline)}`,
  ].join(',');

  return [...header, dialogue, ''].join('\r\n');
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

/** `#rrggbb` to FFmpeg's `0xRRGGBB`. Validated by the brief schema before it arrives. */
function ffmpegColor(hex: string): string {
  const cleaned = hex.replace('#', '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(cleaned)) {
    throw new StoryboardVideoError(
      'FINAL_RENDER_FAILURE',
      `"${hex}" is not a #rrggbb colour and may not reach a filter argument`,
    );
  }
  return `0x${cleaned}`;
}

/** h264 will not encode an odd dimension, and a nudged rectangle is a moved one. */
function even(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index <= 0 ? '.' : path.slice(0, index);
}

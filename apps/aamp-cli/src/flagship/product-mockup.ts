import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { hexToFfmpegColor, num, type CommandRunner, type FfmpegBinaries } from '@combat/media';

import type { ProductionAsset } from '../production-assets';

/**
 * The discussion screen, built rather than captured — and labelled as such
 * everywhere it travels.
 *
 * Combat Reviews' discussion region is genuinely unavailable to the read-only
 * capture path: the live screen returns "card talk is unavailable right now",
 * which is a truthful thing for the product to say and a poor thing for an
 * advertisement to show. The storyboard asks for a discussion beat anyway, so
 * this milestone builds one.
 *
 * What makes that honest rather than a fabrication is what the mockup does
 * *not* contain:
 *
 * - **No text.** Not one glyph. No handle, no comment, no reaction count, no
 *   timestamp, no topic. Every word the beat says arrives through the caption
 *   track, which is authored copy that passes the prohibited-claim gate like
 *   any other. A mockup with invented conversation in it would be a fabricated
 *   record however carefully the JSON described it.
 * - **No invented brand.** The one non-geometric element is the real,
 *   `OWNED` Combat Reviews mark, composited from the real logo file. The
 *   palette, the red accent and the rhythm come from the captured screens.
 * - **No claim to be a capture.** Its provenance class is `PRODUCT_MOCKUP`,
 *   its description leads with that, and its restrictions say it a second
 *   time. The asset id says it too, because an id is what appears in a render
 *   manifest that somebody reads in a hurry.
 *
 * It is geometry, in the brand's own colours, in the shape of the product's
 * own interface. It is deterministic: the same brand constraints produce a
 * byte-identical PNG, which is what lets the whole run be re-rendered and
 * compared.
 */

export const PRODUCT_MOCKUP_ASSET_ID = 'product-mockup-discussion';
export const PRODUCT_MOCKUP_PROVENANCE_CLASS = 'PRODUCT_MOCKUP' as const;
export const PRODUCT_MOCKUP_FILENAME = 'generated/product-mockup-discussion.png';

export class ProductMockupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductMockupError';
  }
}

export interface ProductMockupBrand {
  readonly backgroundHex: string;
  readonly accentHex: string;
  readonly surfaceHex: string;
  readonly mutedHex: string;
}

export interface BuildProductMockupInput {
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly stagingRoot: string;
  /** The real, OWNED mark. Composited so the mockup is grounded in a real asset. */
  readonly logoAbsolutePath: string;
  readonly brand: ProductMockupBrand;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** One filled rectangle. Geometry and a validated colour — never a string. */
interface Block {
  readonly xPx: number;
  readonly yPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly colourHex: string;
  readonly opacity: number;
}

/**
 * The interface, as blocks.
 *
 * Laid out from the measured product screens: a header band with the mark, a
 * sort-tab row with one active tab underlined in brand red, four conversation
 * rows each carrying an avatar and two message lines, one row tagged with the
 * red marker the real interface uses to link a comment to a prediction, a
 * composer at the base and the five-item bottom navigation with the discussion
 * item active.
 *
 * Pure: same input, same blocks, same order, same filter text.
 */
export function mockupBlocks(input: {
  readonly brand: ProductMockupBrand;
  readonly widthPx: number;
  readonly heightPx: number;
}): readonly Block[] {
  const { brand, widthPx, heightPx } = input;
  const margin = Math.round(widthPx * 0.074);
  const contentWidth = widthPx - margin * 2;
  const blocks: Block[] = [];

  const surface = (
    xPx: number,
    yPx: number,
    w: number,
    h: number,
    colourHex = brand.surfaceHex,
    opacity = 1,
  ): void => {
    blocks.push({ xPx, yPx, widthPx: w, heightPx: h, colourHex, opacity });
  };

  // Header rule under the mark — the accent bar the captured screens use to
  // introduce a section.
  surface(margin, 366, Math.round(contentWidth * 0.22), 8, brand.accentHex);

  // Sort tabs: one active (accent, filled and underlined), two inactive.
  const tabY = 462;
  surface(margin, tabY, 176, 26, brand.accentHex, 0.9);
  surface(margin, tabY + 46, 176, 8, brand.accentHex);
  surface(margin + 228, tabY, 190, 26, brand.mutedHex, 0.5);
  surface(margin + 470, tabY, 230, 26, brand.mutedHex, 0.5);

  // Conversation rows.
  const rowHeight = 250;
  const firstRowY = 600;
  for (let row = 0; row < 4; row += 1) {
    const y = firstRowY + row * rowHeight;
    surface(margin, y, contentWidth, rowHeight - 40, brand.surfaceHex);
    // Avatar — a shape, never a face and never an identifier.
    surface(margin + 28, y + 32, 88, 88, brand.mutedHex);
    // Name field, deliberately a bar: there is no name, and there is not
    // going to be one.
    surface(margin + 148, y + 40, 210, 22, brand.mutedHex);
    // Message lines, varied so the block reads as writing rather than a table.
    const lineWidths = [contentWidth - 220, contentWidth - 330, contentWidth - 470];
    lineWidths.slice(0, row === 3 ? 2 : 3).forEach((lineWidth, line) => {
      surface(margin + 148, y + 88 + line * 36, lineWidth, 18, brand.mutedHex, 0.75);
    });
    // The prediction marker the real interface uses, on one row only, with the
    // accent edge the captured screens put beside a highlighted item.
    if (row === 1) {
      surface(margin, y, 8, rowHeight - 40, brand.accentHex);
      surface(margin + 148, y + 190, 210, 38, brand.accentHex);
    }
  }

  // Composer.
  const composerY = heightPx - 340;
  surface(margin, composerY, contentWidth, 100, brand.surfaceHex);
  surface(margin + 24, composerY + 40, Math.round(contentWidth * 0.5), 18, brand.mutedHex, 0.6);
  surface(widthPx - margin - 96, composerY + 22, 72, 56, brand.accentHex, 0.95);

  // Bottom navigation, discussion item active.
  const navY = heightPx - 170;
  const navGap = Math.round(contentWidth / 5);
  for (let item = 0; item < 5; item += 1) {
    const active = item === 3;
    surface(
      margin + item * navGap + 24,
      navY,
      56,
      56,
      active ? brand.accentHex : brand.mutedHex,
      active ? 0.95 : 0.5,
    );
  }

  return blocks;
}

/** Every block, as one validated `drawbox` chain. Numbers and colours only. */
export function mockupFilterChain(blocks: readonly Block[]): string {
  return blocks
    .map(
      (block) =>
        `drawbox=x=${num(block.xPx)}:y=${num(block.yPx)}:w=${num(block.widthPx)}:` +
        `h=${num(block.heightPx)}:color=${hexToFfmpegColor(block.colourHex)}@${num(block.opacity)}:t=fill`,
    )
    .join(',');
}

export interface ProductMockupResult {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly asset: ProductionAsset;
  readonly provenance: Record<string, unknown>;
}

/**
 * Renders the mockup and returns the asset entry that carries it, with the
 * provenance record that says what it is.
 */
export async function buildProductMockup(
  input: BuildProductMockupInput,
): Promise<ProductMockupResult> {
  const absolutePath = join(input.stagingRoot, PRODUCT_MOCKUP_FILENAME);
  await mkdir(dirname(absolutePath), { recursive: true });

  const blocks = mockupBlocks({
    brand: input.brand,
    widthPx: input.widthPx,
    heightPx: input.heightPx,
  });

  // The mark is scaled and composited rather than drawn, so the one
  // recognisable element in the frame is the real file.
  const logoWidth = Math.round(input.widthPx * 0.17);
  const filterComplex =
    `[0:v]${mockupFilterChain(blocks)}[ui];` +
    `[1:v]scale=${num(logoWidth)}:-1[mark];` +
    `[ui][mark]overlay=x=${num(Math.round(input.widthPx * 0.074))}:y=250[out]`;

  const args = [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${hexToFfmpegColor(input.brand.backgroundHex)}:s=${num(input.widthPx)}x${num(input.heightPx)}`,
    '-i',
    input.logoAbsolutePath,
    '-filter_complex',
    filterComplex,
    '-map',
    '[out]',
    '-frames:v',
    '1',
    // Deterministic encoding: no clock, no metadata, no encoder banner.
    '-fflags',
    '+bitexact',
    '-pix_fmt',
    'rgb24',
    '-y',
    absolutePath,
  ];

  const result = await input.runner.run(input.binaries.ffmpeg, args, { timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new ProductMockupError(
      `the discussion mockup could not be rendered (exit ${result.exitCode}): ${result.stderr.trim().slice(-800)}`,
    );
  }

  const asset: ProductionAsset = {
    id: PRODUCT_MOCKUP_ASSET_ID,
    path: `./${PRODUCT_MOCKUP_FILENAME}`,
    kind: 'IMAGE',
    // A designed graphic, not a capture. Calling it an APP_SCREENSHOT would
    // make the vocabulary itself say something untrue.
    role: 'BRAND_CARD',
    description:
      'PRODUCT MOCKUP — a designed representation of the Combat Reviews discussion interface. Not a capture, and not live functionality.',
    rights: {
      classification: 'OWNED',
      owner: 'Combat Reviews',
      permittedOutputUse: true,
      restrictions: [
        `provenance: ${PRODUCT_MOCKUP_PROVENANCE_CLASS} — built from the Combat Reviews visual system, not photographed from the product`,
        'contains no user-generated content: no handles, no comments, no reaction counts, no timestamps, no text of any kind',
        'must never be presented as a live capture of the discussion feature',
        'Approved channel: INTERNAL_REVIEW only',
      ],
    },
    beats: ['DISCUSSION'],
    tags: ['mockup', 'discussion', 'generated'],
    declaredWidthPx: input.widthPx,
    declaredHeightPx: input.heightPx,
  };

  return {
    absolutePath,
    relativePath: PRODUCT_MOCKUP_FILENAME,
    asset,
    provenance: {
      assetId: PRODUCT_MOCKUP_ASSET_ID,
      provenanceClass: PRODUCT_MOCKUP_PROVENANCE_CLASS,
      isLiveCapture: false,
      isRealProductScreenshot: false,
      containsUserGeneratedContent: false,
      containsAnyText: false,
      fabricatedIdentifiers: [],
      fabricatedCounts: [],
      builtFrom: [
        'the Combat Reviews black-and-red visual system, as measured from the approved live captures',
        'the real OWNED Combat Reviews mark, composited from the logo file',
      ],
      whyNotACapture:
        "the live discussion screen returns an 'unavailable' state to the read-only capture path, so no usable real capture of the feature exists",
      blockCount: blocks.length,
      deterministic: true,
    },
  };
}

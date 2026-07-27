/**
 * The only values that may ever be interpolated into FFmpeg filter grammar.
 *
 * Extracted so the motion-treatment catalogue and the filter graph share one
 * implementation rather than two that could drift. The rule they encode is the
 * one CLAUDE.md states structurally: **no authored string ever becomes filter
 * grammar**. Numbers go through `num`, colours through `hexToFfmpegColor`
 * (which only accepts a validated `#RRGGBB`), and everything else — captions,
 * CTA copy, overlay text — travels in the generated ASS file instead.
 */

export class FilterPrimitiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterPrimitiveError';
  }
}

/** Fixed-precision, so the same manifest always produces byte-identical argv. */
export function num(value: number): string {
  if (!Number.isFinite(value)) {
    throw new FilterPrimitiveError(`non-finite value in filter graph: ${value}`);
  }
  return Number(value.toFixed(6)).toString();
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * FFmpeg colour literal. Validates the shape rather than trusting the caller:
 * this is the one place a colour string becomes grammar, and a manifest that
 * reached here with something else is a defect worth failing on.
 */
export function hexToFfmpegColor(hex: string): string {
  if (!HEX_COLOR.test(hex)) {
    throw new FilterPrimitiveError(`colour must be #RRGGBB, got "${hex}"`);
  }
  return `0x${hex.replace('#', '').toUpperCase()}`;
}

/** `0xRRGGBB@a` — the form `drawbox`/`color` accept for a translucent fill. */
export function hexToFfmpegColorWithAlpha(hex: string, alpha: number): string {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new FilterPrimitiveError(`alpha must be between 0 and 1, got ${alpha}`);
  }
  return `${hexToFfmpegColor(hex)}@${num(alpha)}`;
}

/** An even dimension: h264 with yuv420p cannot encode an odd width or height. */
export function evenPx(value: number): number {
  return Math.round(value / 2) * 2;
}

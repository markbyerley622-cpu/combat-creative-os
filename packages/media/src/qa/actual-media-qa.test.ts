import { describe, expect, it } from 'vitest';

import {
  hexToRgb,
  maxChannelDistance,
  measureRegion,
  measureTextContrastScore,
  scaleRegion,
  wholeFrame,
  type SampledFrame,
} from './frame-sampling';

function frame(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): SampledFrame {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const offset = (y * width + x) * 3;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
    }
  }
  return { timeSeconds: 0, widthPx: width, heightPx: height, pixels };
}

describe('measureRegion', () => {
  it('reports zero variation for a flat fill — the definition of a blank frame', () => {
    const stats = measureRegion(
      frame(16, 16, () => [30, 30, 30]),
      { x: 0, y: 0, width: 16, height: 16 },
    );
    expect(stats.stdDevLuma).toBeCloseTo(0, 6);
    expect(stats.meanLuma).toBeCloseTo(30, 3);
    expect(stats.brightPixelFraction).toBe(0);
  });

  it('reports real variation for picture content', () => {
    const stats = measureRegion(
      frame(16, 16, (x) => (x % 2 === 0 ? [255, 255, 255] : [0, 0, 0])),
      { x: 0, y: 0, width: 16, height: 16 },
    );
    expect(stats.stdDevLuma).toBeGreaterThan(100);
    expect(stats.brightPixelFraction).toBeCloseTo(0.5, 2);
  });

  it('reports the mean colour of the region, which is how the CTA card is identified', () => {
    const stats = measureRegion(
      frame(8, 8, () => [11, 11, 15]),
      { x: 0, y: 0, width: 8, height: 8 },
    );
    expect(maxChannelDistance(stats, hexToRgb('#0B0B0F'))).toBeCloseTo(0, 6);
    expect(maxChannelDistance(stats, hexToRgb('#FFFFFF'))).toBeGreaterThan(200);
  });

  it('clamps a region that runs past the frame instead of reading out of bounds', () => {
    const stats = measureRegion(
      frame(8, 8, () => [100, 100, 100]),
      {
        x: 6,
        y: 6,
        width: 100,
        height: 100,
      },
    );
    expect(stats.pixelCount).toBe(4);
    expect(stats.meanLuma).toBeCloseTo(100, 3);
  });
});

describe('measureTextContrastScore — the burned-in-type signature', () => {
  it('scores near zero on bright footage with no type', () => {
    // A large white area with no dark boundary nearby: exactly the case that
    // fooled a naive bright-pixel count.
    const bright = frame(64, 64, () => [240, 235, 230]);
    expect(measureTextContrastScore(bright, wholeFrame(bright))).toBeCloseTo(0, 6);
  });

  it('scores near zero on a smooth gradient', () => {
    const gradient = frame(64, 64, (x) => [x * 4, x * 4, x * 4]);
    expect(measureTextContrastScore(gradient, wholeFrame(gradient))).toBeLessThan(0.02);
  });

  it('scores high on white strokes outlined in black — what a caption actually is', () => {
    const captionLike = frame(64, 64, (_x, y) => {
      const inStroke = y % 12 < 3;
      const inOutline = y % 12 >= 3 && y % 12 < 5;
      if (inStroke) return [255, 255, 255];
      if (inOutline) return [0, 0, 0];
      return [90, 90, 90];
    });
    expect(measureTextContrastScore(captionLike, wholeFrame(captionLike))).toBeGreaterThan(0.1);
  });

  it('scores zero on a flat dark fill', () => {
    const dark = frame(32, 32, () => [8, 8, 12]);
    expect(measureTextContrastScore(dark, wholeFrame(dark))).toBe(0);
  });
});

describe('scaleRegion', () => {
  it('converts an output-pixel region into sample coordinates', () => {
    expect(scaleRegion({ x: 0, y: 960, width: 1080, height: 320 }, 1080, 1920, 270, 480)).toEqual({
      x: 0,
      y: 240,
      width: 270,
      height: 80,
    });
  });

  it('never produces a zero-sized region, which would measure nothing', () => {
    const region = scaleRegion({ x: 0, y: 0, width: 2, height: 2 }, 1080, 1920, 270, 480);
    expect(region.width).toBeGreaterThan(0);
    expect(region.height).toBeGreaterThan(0);
  });
});

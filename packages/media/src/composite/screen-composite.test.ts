import { describe, expect, it } from 'vitest';

import { compileShotComposite, concatDemuxerList, ScreenCompositeError } from './screen-composite';
import { normaliseQuadForCover, type NormalisedQuad } from './screen-quad';

const quad: NormalisedQuad = normaliseQuadForCover(
  {
    topLeft: { xPx: 500, yPx: 360 },
    topRight: { xPx: 858, yPx: 338 },
    bottomLeft: { xPx: 481, yPx: 1362 },
    bottomRight: { xPx: 838, yPx: 1381 },
  },
  { sourceWidthPx: 941, sourceHeightPx: 1672, outputWidthPx: 1080, outputHeightPx: 1920 },
);

const shot = {
  shotId: 'shot-a',
  plateInputIndex: 0,
  uiInputIndex: 1,
  outputWidthPx: 1080,
  outputHeightPx: 1920,
  uiCanvasWidthPx: 1080,
  uiCanvasHeightPx: 3090,
  frameRate: 30,
  durationSeconds: 3.3,
  uiStartSeconds: 0,
  quad,
  move: { startZoom: 1.06, endZoom: 1.128, panCentreU: 0.5, panCentreV: 0.5, frames: 99 },
};

describe('compileShotComposite', () => {
  it('moves the plate before the interface is warped', () => {
    const { graph } = compileShotComposite(shot);
    expect(graph.indexOf('zoompan')).toBeLessThan(graph.indexOf('perspective'));
  });

  it('evaluates the warp per frame so the screen tracks the move', () => {
    const { graph } = compileShotComposite(shot);
    expect(graph).toContain('eval=frame');
    expect(graph).toContain('sense=destination');
  });

  it('uses byte-identical corner expressions for the picture warp and the alpha warp', () => {
    const { graph } = compileShotComposite(shot);
    // The two warps differ only in interpolation — cubic for the picture,
    // linear for the alpha, so the mask edge stays hard. Every coordinate
    // must be the same character for character, or the cut-out drifts off the
    // interface it is meant to cut.
    const warps = (graph.match(/perspective=[^,\]]+/g) ?? []).map(
      (warp) => warp.split(':sense=')[0],
    );
    expect(warps).toHaveLength(2);
    expect(warps[0]).toBe(warps[1]);
  });

  it('interpolates the picture cubically and the alpha linearly', () => {
    const { graph } = compileShotComposite(shot);
    expect(graph).toContain('eval=frame:interpolation=cubic');
    expect(graph).toContain('eval=frame,crop=');
  });

  it('cuts the interface to the screen with a rimmed alpha field, not a crop', () => {
    const { graph } = compileShotComposite(shot);
    expect(graph).toContain('color=white:t=fill');
    expect(graph).toContain('color=black:t=3');
    expect(graph).toContain('alphamerge');
  });

  it('crops the taller interface canvas back to the delivery frame', () => {
    const { graph } = compileShotComposite(shot);
    expect(graph).toContain('crop=1080:1920:0:0');
  });

  it('takes its own window of the continuous interface timeline', () => {
    const { graph } = compileShotComposite({ ...shot, uiStartSeconds: 3.3 });
    expect(graph).toContain('trim=start=3.3:duration=3.3');
  });

  it('shares one zoom expression between the plate move and the corners', () => {
    const compiled = compileShotComposite(shot);
    expect(compiled.plateZoomExpression).toBe('1.06+0.068*on/98');
    expect(compiled.graph).toContain(compiled.plateZoomExpression);
  });

  it('refuses an interface canvas shorter than the delivery frame', () => {
    expect(() => compileShotComposite({ ...shot, uiCanvasHeightPx: 1200 })).toThrow(/shorter than/);
  });

  it('refuses a pan that would run off the plate, naming the zoom that would fix it', () => {
    expect(() =>
      compileShotComposite({ ...shot, move: { ...shot.move, panCentreU: 0.71 } }),
    ).toThrow(ScreenCompositeError);
    expect(() =>
      compileShotComposite({ ...shot, move: { ...shot.move, panCentreU: 0.71 } }),
    ).toThrow(/Raise the zoom to at least/);
  });

  it('allows a pan the zoom can actually accommodate', () => {
    expect(() =>
      compileShotComposite({
        ...shot,
        move: { ...shot.move, startZoom: 1.128, endZoom: 1.145, panCentreU: 0.453 },
      }),
    ).not.toThrow();
  });
});

describe('shot labelling', () => {
  it('gives every shot its own label scope so two shots on one plate cannot collide', () => {
    const a = compileShotComposite(shot);
    const b = compileShotComposite({ ...shot, shotId: 'shot-b', uiStartSeconds: 3.3 });
    expect(a.graph).toContain('[shotaplate]');
    expect(b.graph).toContain('[shotbplate]');
    expect(a.outputLabel).not.toBe(b.outputLabel);
  });

  it('never emits an xfade — a cut has to be an actual cut', () => {
    expect(compileShotComposite(shot).graph).not.toContain('xfade');
  });
});

describe('concatDemuxerList', () => {
  it('writes one line per shot, in order, with forward slashes', () => {
    expect(concatDemuxerList(['C:\\work\\shot-0.mp4', 'C:\\work\\shot-1.mp4'])).toBe(
      "file 'C:/work/shot-0.mp4'\nfile 'C:/work/shot-1.mp4'\n",
    );
  });

  it('refuses an empty sequence', () => {
    expect(() => concatDemuxerList([])).toThrow(ScreenCompositeError);
  });

  it('refuses a path carrying the demuxer own escape character', () => {
    expect(() => concatDemuxerList(["C:\\it's\\shot.mp4"])).toThrow(/quote/);
  });
});

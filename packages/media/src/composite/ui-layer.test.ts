import { describe, expect, it } from 'vitest';

import {
  captureRectToCanvas,
  compileUiLayerGraph,
  documentHeightPx,
  easedProgressExpression,
  UiLayerError,
  type UiDocument,
  type UiLayerSpec,
  type UiState,
} from './ui-layer';

const document: UiDocument = {
  id: 'events',
  inputIndex: 1,
  captureWidthPx: 1080,
  captureHeightPx: 1920,
  headroomPx: 1600,
};

const state: UiState = {
  id: 'event-discovery',
  documentId: 'events',
  startSeconds: 0,
  endSeconds: 1.2,
  entrance: 'NONE',
  entranceSeconds: 0,
  scroll: { fromPx: 0, toPx: 400, startSeconds: 0, endSeconds: 0.8, easing: 'EASE_OUT_CUBIC' },
};

const spec: UiLayerSpec = {
  canvasWidthPx: 1080,
  canvasHeightPx: 3090,
  frameRate: 30,
  durationSeconds: 5.6,
  documents: [document],
  states: [state],
  accents: [],
  baseInputIndex: 0,
};

describe('easedProgressExpression', () => {
  it('clamps progress to the window at both ends', () => {
    const expression = easedProgressExpression(1, 2, 'LINEAR');
    expect(expression).toContain('min(1,max(0,');
  });

  it('uses a deceleration curve for a settling scroll', () => {
    expect(easedProgressExpression(0, 1, 'EASE_OUT_CUBIC')).toContain('1-pow(1-');
  });
});

describe('compileUiLayerGraph', () => {
  it('builds headroom from the capture own top rows rather than a colour literal', () => {
    const { graph } = compileUiLayerGraph(spec);
    expect(graph).toContain('crop=1080:2:0:0');
    expect(graph).toContain('scale=1080:1600');
    expect(graph).toContain('vstack=inputs=2');
    expect(graph).not.toMatch(/color=0x[0-9A-F]{6}(?!.*drawbox)/);
  });

  it('scrolls with a negative overlay offset so the document travels upward', () => {
    const { graph } = compileUiLayerGraph(spec);
    expect(graph).toContain("overlay=x=0:y='-(0+400*");
  });

  it('keeps a still document alive for the whole cut', () => {
    const { graph } = compileUiLayerGraph(spec);
    expect(graph).toContain('eof_action=repeat');
  });

  it('splits a document once per state that shows it', () => {
    const second: UiState = {
      ...state,
      id: 'event-selection',
      startSeconds: 1.2,
      endSeconds: 2,
      scroll: { fromPx: 400, toPx: 400, startSeconds: 1.2, endSeconds: 2, easing: 'LINEAR' },
    };
    const { graph } = compileUiLayerGraph({ ...spec, states: [state, second] });
    expect(graph).toContain('[eventsbase]split=2[eventsdoc0][eventsdoc1]');
    expect(graph).toContain('[eventsdoc0]overlay');
    expect(graph).toContain('[eventsdoc1]overlay');
  });

  it('passes a single-use document straight through rather than splitting it', () => {
    const { graph } = compileUiLayerGraph(spec);
    expect(graph).toContain('[eventsbase]null[eventsdoc0]');
  });

  it('refuses a document no state ever shows', () => {
    const spare: UiDocument = { ...document, id: 'spare', inputIndex: 2 };
    expect(() => compileUiLayerGraph({ ...spec, documents: [document, spare] })).toThrow(
      /never shown by any state/,
    );
  });

  it('renders a later state over an earlier one, which is the wipe', () => {
    const second: UiState = {
      ...state,
      id: 'comparison',
      startSeconds: 1.2,
      endSeconds: 3,
      entrance: 'PUSH_UP',
      entranceSeconds: 0.3,
      scroll: { fromPx: 100, toPx: 100, startSeconds: 1.2, endSeconds: 3, easing: 'LINEAR' },
    };
    const { graph } = compileUiLayerGraph({ ...spec, states: [second, state] });
    // Ordered by start time regardless of the order supplied.
    expect(graph.indexOf('between(t,0,1.2)')).toBeLessThan(graph.indexOf('between(t,1.2,3)'));
    expect(graph).toContain('3090*(1-');
  });

  it('holds the outgoing state under a push-up so the screen never goes blank', () => {
    const second: UiState = {
      ...state,
      id: 'comparison',
      startSeconds: 1.2,
      endSeconds: 3,
      entrance: 'PUSH_UP',
      entranceSeconds: 0.34,
      scroll: { fromPx: 100, toPx: 100, startSeconds: 1.2, endSeconds: 3, easing: 'LINEAR' },
    };
    const { graph } = compileUiLayerGraph({ ...spec, states: [state, second] });
    // The outgoing list is drawn until 1.54, not 1.2 — the band the incoming
    // document has not covered yet would otherwise be the black base.
    expect(graph).toContain('between(t,0,1.54)');
  });

  it('does not extend a state when the next one cuts rather than wipes', () => {
    const second: UiState = {
      ...state,
      id: 'next',
      startSeconds: 1.2,
      endSeconds: 3,
      entrance: 'NONE',
      entranceSeconds: 0,
      scroll: { fromPx: 100, toPx: 100, startSeconds: 1.2, endSeconds: 3, easing: 'LINEAR' },
    };
    const { graph } = compileUiLayerGraph({ ...spec, states: [state, second] });
    expect(graph).toContain('between(t,0,1.2)');
  });

  it('never emits an xfade or a dissolve between product states', () => {
    const { graph } = compileUiLayerGraph(spec);
    expect(graph).not.toContain('xfade');
    expect(graph).not.toContain('blend');
  });

  it('refuses a document shorter than the canvas rather than leaving the screen uncovered', () => {
    const short: UiDocument = { ...document, headroomPx: 0 };
    expect(() => compileUiLayerGraph({ ...spec, documents: [short] })).toThrow(UiLayerError);
    expect(() => compileUiLayerGraph({ ...spec, documents: [short] })).toThrow(
      /Raise its headroom/,
    );
  });

  it('refuses a scroll that would run past the end of the capture', () => {
    const overscrolled: UiState = {
      ...state,
      scroll: { ...state.scroll, toPx: 9999 },
    };
    expect(() => compileUiLayerGraph({ ...spec, states: [overscrolled] })).toThrow(
      /past the end of the capture/,
    );
  });

  it('refuses a document whose width does not match the canvas', () => {
    const narrow: UiDocument = { ...document, captureWidthPx: 900 };
    expect(() => compileUiLayerGraph({ ...spec, documents: [narrow] })).toThrow(/resample/);
  });

  it('refuses a state naming a document that does not exist', () => {
    expect(() =>
      compileUiLayerGraph({ ...spec, states: [{ ...state, documentId: 'missing' }] }),
    ).toThrow(/unknown document/);
  });
});

describe('accents', () => {
  it('emits geometry only — no accent can carry text', () => {
    const { graph } = compileUiLayerGraph({
      ...spec,
      accents: [
        {
          id: 'select',
          key: 'SELECTION_OUTLINE',
          xPx: 40,
          yPx: 100,
          widthPx: 1000,
          heightPx: 400,
          startSeconds: 0.9,
          endSeconds: 1.2,
          colorHex: '#DA0318',
        },
      ],
    });
    expect(graph).toContain('drawbox=');
    expect(graph).not.toContain('drawtext');
    expect(graph).toContain("enable='between(t,0.9,1.2)'");
  });

  it('gives a press both a wash and a heavier frame', () => {
    const { graph } = compileUiLayerGraph({
      ...spec,
      accents: [
        {
          id: 'press',
          key: 'PRESS_OUTLINE',
          xPx: 40,
          yPx: 100,
          widthPx: 1000,
          heightPx: 200,
          startSeconds: 3.7,
          endSeconds: 3.95,
          colorHex: '#DA0318',
        },
      ],
    });
    expect(graph).toContain('t=fill');
    expect(graph).toContain('t=12');
  });
});

describe('captureRectToCanvas', () => {
  it('shifts a measured region by the headroom and the scroll', () => {
    const rect = captureRectToCanvas(
      { xPx: 12, yPx: 1128, widthPx: 818, heightPx: 392 },
      document,
      600,
    );
    expect(rect.xPx).toBe(12);
    expect(rect.yPx).toBe(1128 + 1600 - 600);
    expect(rect.heightPx).toBe(392);
  });

  it('agrees with the document height helper', () => {
    expect(documentHeightPx(document)).toBe(3520);
  });
});

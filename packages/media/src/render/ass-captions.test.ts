import { describe, expect, it } from 'vitest';

import { buildAssSubtitleFile, escapeAssText, toAssColor, toAssTimestamp } from './ass-captions';
import type { CaptionStyle } from './manifest';

const STYLE: CaptionStyle = {
  fontFamily: 'Arial',
  fontSizePx: 56,
  primaryColorHex: '#FFFFFF',
  outlineColorHex: '#000000',
  outlineWidthPx: 4,
  bold: true,
  uppercase: true,
  marginBottomPx: 420,
  marginHorizontalPx: 96,
};

describe('toAssColor', () => {
  it('reverses RGB into ASS byte order and puts alpha first', () => {
    // ASS is &HAABBGGRR — a pure red becomes 0000FF, not FF0000.
    expect(toAssColor('#FF0000')).toBe('&H000000FF');
    expect(toAssColor('#0000FF')).toBe('&H00FF0000');
    expect(toAssColor('#FFFFFF')).toBe('&H00FFFFFF');
    expect(toAssColor('#000000', 128)).toBe('&H80000000');
  });
});

describe('toAssTimestamp', () => {
  it('formats seconds as H:MM:SS.cc', () => {
    expect(toAssTimestamp(0)).toBe('0:00:00.00');
    expect(toAssTimestamp(1.5)).toBe('0:00:01.50');
    expect(toAssTimestamp(61.234)).toBe('0:01:01.23');
    expect(toAssTimestamp(3661.99)).toBe('1:01:01.99');
  });

  it('clamps a negative time rather than emitting a malformed stamp', () => {
    expect(toAssTimestamp(-5)).toBe('0:00:00.00');
  });
});

describe('escapeAssText — caption copy cannot inject ASS override tags', () => {
  it('neutralises brace-delimited override blocks', () => {
    // Without escaping this would reposition and recolour the whole line.
    expect(escapeAssText('{\\pos(0,0)\\c&H0000FF&}gotcha')).not.toContain('{');
    expect(escapeAssText('{\\pos(0,0)}gotcha')).toBe('(∖pos(0,0))gotcha');
  });

  it('turns hard newlines into ASS line breaks instead of breaking the event line', () => {
    expect(escapeAssText('first\nsecond')).toBe('first\\Nsecond');
    expect(escapeAssText('first\r\nsecond')).toBe('first\\Nsecond');
  });

  it('strips control characters', () => {
    expect(escapeAssText(`a${String.fromCharCode(7)}b${String.fromCharCode(0)}c`)).toBe('abc');
  });

  it('leaves the characters that would be structural in a filter argument alone', () => {
    // `:`, `,`, `'` and `[` are all filter-graph grammar and all ordinary
    // text here — which is the reason captions travel in a file.
    const text = "Round 3: Silva, Adesanya — who's [really] winning?";
    expect(escapeAssText(text)).toBe(text);
  });
});

describe('buildAssSubtitleFile', () => {
  const cues = [
    { startSeconds: 0.3, endSeconds: 3, text: 'Real fights. Real reviews.' },
    { startSeconds: 3.9, endSeconds: 6.2, text: 'Track every card' },
  ];

  it('declares the output resolution, so positions are in output pixels', () => {
    const ass = buildAssSubtitleFile({ style: STYLE, cues, widthPx: 1080, heightPx: 1920 });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
  });

  it('emits one dialogue line per cue, at the cue times, with a fade', () => {
    const ass = buildAssSubtitleFile({ style: STYLE, cues, widthPx: 1080, heightPx: 1920 });
    const dialogue = ass.split('\r\n').filter((line) => line.startsWith('Dialogue:'));
    expect(dialogue).toHaveLength(2);
    expect(dialogue[0]).toContain('0:00:00.30,0:00:03.00');
    expect(dialogue[0]).toContain('{\\fad(120,120)}');
    expect(dialogue[1]).toContain('0:00:03.90,0:00:06.20');
  });

  it('applies the manifest casing rule to the rendered text', () => {
    const ass = buildAssSubtitleFile({ style: STYLE, cues, widthPx: 1080, heightPx: 1920 });
    expect(ass).toContain('REAL FIGHTS. REAL REVIEWS.');

    const lower = buildAssSubtitleFile({
      style: { ...STYLE, uppercase: false },
      cues,
      widthPx: 1080,
      heightPx: 1920,
    });
    expect(lower).toContain('Real fights. Real reviews.');
  });

  it('carries the style margins so libass wraps inside the caption safe area', () => {
    const ass = buildAssSubtitleFile({ style: STYLE, cues, widthPx: 1080, heightPx: 1920 });
    const styleLine = ass.split('\r\n').find((line) => line.startsWith('Style: Caption'));
    expect(styleLine?.split(',').slice(-4)).toEqual(['96', '96', '420', '1']);
  });

  it('never lets a font name containing a comma shift every later style field', () => {
    const ass = buildAssSubtitleFile({
      style: { ...STYLE, fontFamily: 'Bad, Font' },
      cues,
      widthPx: 1080,
      heightPx: 1920,
    });
    const styleLine = ass.split('\r\n').find((line) => line.startsWith('Style: Caption')) ?? '';
    // Name, Fontname, then 21 more fields — 23 in total.
    expect(styleLine.split(',')).toHaveLength(23);
  });

  it('produces byte-identical output for identical input', () => {
    const once = buildAssSubtitleFile({ style: STYLE, cues, widthPx: 1080, heightPx: 1920 });
    const twice = buildAssSubtitleFile({ style: STYLE, cues, widthPx: 1080, heightPx: 1920 });
    expect(once).toBe(twice);
  });
});

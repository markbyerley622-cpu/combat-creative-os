import { describe, expect, it } from 'vitest';

import {
  assertStoryboardSafe,
  renderStoryboardHtml,
  UnsafeStoryboardError,
  type Storyboard,
} from './storyboard';

/**
 * A storyboard is the artefact most likely to be mailed to somebody, which
 * makes it the artefact most likely to leak. The safety walk is therefore
 * tested the way the run-provenance guard is: by handing it exactly the things
 * it must refuse.
 */

const BEAT: Storyboard['beats'][number] = {
  beatId: 'hook',
  index: 0,
  timestampSeconds: 0,
  durationSeconds: 3,
  narrativeRole: 'HOOK',
  description: 'Gym footage with a hard push-in.',
  sourceAssetId: 'clip-gym',
  sourceRelativePath: 'combat-clips/gym.mp4',
  sourceChecksumSha256: 'a'.repeat(64),
  rightsClassification: 'OWNED',
  inSeconds: 0,
  outSeconds: 3,
  caption: 'Twelve events this weekend',
  transition: null,
  motionTreatment: 'PUSH_IN',
  motionIntensity: 0.7,
  motionDescription: 'slow push in toward the centre of frame',
  ctaState: 'BEFORE_CTA',
  audioEvents: ['FIGHT_BELL at 0.10s, -6 dB'],
  selectionReasoning: ['starts on a measured scene boundary'],
  frameFileName: 'storyboard-frames/00-hook.png',
};

const STORYBOARD: Storyboard = {
  storyboardVersion: 1,
  campaignId: '3c9b7a24-8f61-4d0e-9a37-5b2c8e14d7f0',
  workspaceId: '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e',
  campaignName: 'combat-reviews-preview',
  authoredBy: 'Combat Reviews creative lead',
  executionMode: 'HUMAN_ASSISTED_PREVIEW',
  planningSource: 'HUMAN_SUPPLIED_STRUCTURED_PLAN',
  motionCatalogueVersion: 1,
  totalDurationSeconds: 15,
  beats: [BEAT],
  contactSheetFileName: 'contact-sheet.png',
  notice: 'not an approval',
};

describe('storyboard safety', () => {
  it('accepts a storyboard built only from plan, manifest and measurements', () => {
    expect(() => assertStoryboardSafe(STORYBOARD)).not.toThrow();
  });

  it('refuses a credential-shaped value wherever it appears', () => {
    expect(() =>
      assertStoryboardSafe({
        ...STORYBOARD,
        beats: [{ ...BEAT, description: 'see postgres://user:pw@host/db' }],
      }),
    ).toThrow(UnsafeStoryboardError);
    expect(() =>
      assertStoryboardSafe({ ...STORYBOARD, authoredBy: 'sk-ant-abc123DEF456' }),
    ).toThrow(/Anthropic API key/);
  });

  it('refuses an absolute path, so nothing about the machine travels with it', () => {
    expect(() =>
      assertStoryboardSafe({
        ...STORYBOARD,
        beats: [{ ...BEAT, sourceRelativePath: 'C:\\Users\\someone\\library\\clip.mp4' }],
      }),
    ).toThrow(/absolute Windows path/);
    expect(() =>
      assertStoryboardSafe({
        ...STORYBOARD,
        beats: [{ ...BEAT, sourceRelativePath: '/home/someone/library/clip.mp4' }],
      }),
    ).toThrow(/absolute POSIX path/);
  });

  it('refuses a path into derived reference analysis', () => {
    expect(() =>
      assertStoryboardSafe({
        ...STORYBOARD,
        beats: [{ ...BEAT, sourceRelativePath: '.aamp-reference-analysis/scene-0.mp4' }],
      }),
    ).toThrow(/derived reference analysis/);
  });

  it('refuses a forbidden field by name, at any depth', () => {
    expect(() =>
      assertStoryboardSafe({ ...STORYBOARD, beats: [{ ...BEAT, transcript: 'spoken words' }] }),
    ).toThrow(/transcript is a forbidden field/);
    expect(() =>
      assertStoryboardSafe({ ...STORYBOARD, beats: [{ ...BEAT, absolutePath: 'anything' }] }),
    ).toThrow(/absolutePath is a forbidden field/);
  });

  it('reports every violation rather than only the first', () => {
    try {
      assertStoryboardSafe({
        ...STORYBOARD,
        authoredBy: 'sk-ant-leak',
        beats: [{ ...BEAT, apiKey: 'x', transcript: 'y' }],
      });
      throw new Error('expected the storyboard to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeStoryboardError);
      expect((error as UnsafeStoryboardError).violations.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('storyboard HTML', () => {
  const html = renderStoryboardHtml(STORYBOARD);

  it('opens with no server and no network: no remote reference of any kind', () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('@import');
    // Every asset it references is a sibling file, so the directory travels
    // as one unit.
    for (const src of [...html.matchAll(/src="([^"]+)"/g)].map((match) => match[1] as string)) {
      expect(src.startsWith('http'), `${src} is remote`).toBe(false);
      expect(src.startsWith('/'), `${src} is absolute`).toBe(false);
    }
  });

  it('shows every fact a reviewer needs per beat', () => {
    for (const fragment of [
      'HOOK',
      'clip-gym',
      'combat-clips/gym.mp4',
      'OWNED',
      'PUSH_IN',
      'Twelve events this weekend',
      'FIGHT_BELL',
      'starts on a measured scene boundary',
      'BEFORE_CTA',
    ]) {
      expect(html, `the page does not show ${fragment}`).toContain(fragment);
    }
  });

  it('states the execution mode and planning source, so the page cannot be mistaken for a campaign result', () => {
    expect(html).toContain('HUMAN_ASSISTED_PREVIEW');
    expect(html).toContain('HUMAN_SUPPLIED_STRUCTURED_PLAN');
    expect(html).toContain('not an approval');
  });

  it('escapes authored copy so it can never become markup', () => {
    const hostile = renderStoryboardHtml({
      ...STORYBOARD,
      beats: [{ ...BEAT, caption: '<img src=x onerror="alert(1)">' }],
    });
    expect(hostile).not.toContain('<img src=x');
    expect(hostile).toContain('&lt;img src=x');
  });
});

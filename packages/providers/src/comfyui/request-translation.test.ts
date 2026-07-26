import { describe, expect, it } from 'vitest';

import {
  composeNegativePrompt,
  composePromptText,
  deriveFilenamePrefix,
  deriveSeed,
  effectiveDurationSeconds,
  resolveDimensions,
  translateSubmitInput,
} from './request-translation';
import { getComfyUIWorkflowProfile, snapFrameCount } from './workflow-profiles';
import type { VideoGenerationSubmitInput } from '../video-generation';

const profile = getComfyUIWorkflowProfile('LTX_2_3_DRAFT');

function input(overrides: Partial<VideoGenerationSubmitInput> = {}): VideoGenerationSubmitInput {
  return {
    idempotencyKey: 'run-1:GEN:shot-1:1',
    shotId: 'shot-1',
    mode: 'TEXT_TO_VIDEO',
    promptText: 'A fighter shadowboxing',
    candidateCount: 1,
    params: { durationSeconds: 4, aspectRatio: '9:16', resolution: '704x1280', frameRate: 24 },
    ...overrides,
  };
}

describe('prompt composition', () => {
  it('leads with the agent’s own prompt and appends its structured attributes', () => {
    const text = composePromptText(
      input({
        creativeAttributes: {
          subject: 'a lean welterweight',
          action: 'throwing a jab-cross',
          environment: 'a dim basement gym',
          lighting: 'hard key from a single overhead lamp',
          continuityRequirements: ['red gloves throughout', 'same gym'],
        },
      }),
    );

    expect(text.startsWith('A fighter shadowboxing')).toBe(true);
    expect(text).toContain('Subject: a lean welterweight');
    expect(text).toContain('Lighting: hard key from a single overhead lamp');
    expect(text).toContain('Continuity: red gloves throughout; same gym');
  });

  it('is byte-stable for the same brief, so promptSha256 means something', () => {
    const attributes = { subject: 'a fighter', action: 'ducking', environment: 'a ring' };
    expect(composePromptText(input({ creativeAttributes: attributes }))).toBe(
      composePromptText(input({ creativeAttributes: attributes })),
    );
  });

  it('falls back to the profile’s negative prompt only when the agent supplied none', () => {
    expect(composeNegativePrompt(input(), profile)).toBe(profile.defaultNegativePrompt);
    expect(composeNegativePrompt(input({ negativePrompt: 'no logos' }), profile)).toBe('no logos');
  });
});

describe('deterministic derivation', () => {
  it('derives the same seed from the same idempotency key', () => {
    expect(deriveSeed('run-1:GEN:shot-1:1')).toBe(deriveSeed('run-1:GEN:shot-1:1'));
    expect(deriveSeed('run-1:GEN:shot-1:1')).not.toBe(deriveSeed('run-1:GEN:shot-1:2'));
  });

  it('builds an output prefix containing no authored text', () => {
    const prefix = deriveFilenamePrefix('run-1:GEN:shot-1:1');
    expect(prefix).toMatch(/^combat\/[0-9a-f]{32}$/);
  });

  it('honours an explicit seed over the derived one', () => {
    const graph = translateSubmitInput(
      input({ params: { durationSeconds: 4, aspectRatio: '9:16', frameRate: 24, seed: 1234 } }),
      profile,
      { referenceImageFilenames: [] },
    );
    expect(graph.seed).toBe(1234);
  });
});

describe('capability enforcement', () => {
  const rejects = (overrides: Partial<VideoGenerationSubmitInput>, pattern: RegExp): void => {
    expect(() =>
      translateSubmitInput(input(overrides), profile, { referenceImageFilenames: [] }),
    ).toThrow(pattern);
  };

  it('rejects an out-of-range duration', () => {
    rejects({ params: { durationSeconds: 60, aspectRatio: '9:16' } }, /1-10s shots/);
  });

  it('rejects an unsupported aspect ratio', () => {
    rejects({ params: { durationSeconds: 4, aspectRatio: '16:9' } }, /aspect ratio/);
  });

  it('rejects an unsupported resolution rather than silently substituting one', () => {
    rejects(
      { params: { durationSeconds: 4, aspectRatio: '9:16', resolution: '4096x4096' } },
      /does not support resolution/,
    );
  });

  it('rejects an unsupported frame rate', () => {
    rejects({ params: { durationSeconds: 4, aspectRatio: '9:16', frameRate: 60 } }, /60 fps/);
  });

  it('rejects more candidates than the profile can produce', () => {
    rejects({ candidateCount: 9 }, /at most 2 candidate/);
  });

  it('rejects reference video outright', () => {
    rejects({ referenceVideo: { description: 'a famous fight scene' } }, /reference video/);
  });

  it('rejects IMAGE_TO_VIDEO with no reference image', () => {
    rejects({ mode: 'IMAGE_TO_VIDEO' }, /without a reference image/);
  });
});

describe('geometry and timing', () => {
  it('snaps frame counts to the nearest k*n+1 the model can encode', () => {
    expect(snapFrameCount(97, 8)).toBe(97);
    expect(snapFrameCount(96, 8)).toBe(97);
    // Nearest, not next: 100 is closer to 97 than to 105.
    expect(snapFrameCount(100, 8)).toBe(97);
    expect(snapFrameCount(104, 8)).toBe(105);
  });

  it('snaps dimensions to the profile’s multiple', () => {
    expect(resolveDimensions(input(), profile)).toEqual({ widthPx: 704, heightPx: 1280 });
  });

  it('falls back to the profile’s first supported resolution when none is requested', () => {
    const graph = translateSubmitInput(
      input({ params: { durationSeconds: 4, aspectRatio: '9:16', frameRate: 24 } }),
      profile,
      { referenceImageFilenames: [] },
    );
    expect(graph.widthPx).toBe(704);
    expect(graph.heightPx).toBe(1280);
  });

  it('reports the post-snap duration, not the requested one', () => {
    const graph = translateSubmitInput(input(), profile, { referenceImageFilenames: [] });
    expect(graph.frameCount).toBe(97);
    expect(effectiveDurationSeconds(graph)).toBeCloseTo(97 / 24, 5);
  });
});

describe('graph construction', () => {
  it('builds a text-to-video graph whose text is a node input value, never a path', () => {
    const graph = profile.buildGraph(
      translateSubmitInput(input(), profile, { referenceImageFilenames: [] }),
    );

    expect(graph['4']).toMatchObject({ class_type: 'EmptyLTXVLatentVideo' });
    expect(graph['5']).toMatchObject({ class_type: 'LTXVConditioning' });
    expect(graph['10']).toMatchObject({
      class_type: 'SaveVideo',
      inputs: expect.objectContaining({ filename_prefix: expect.stringMatching(/^combat\//) }),
    });
    // The prompt is data inside a node's inputs, and appears nowhere else.
    const serialised = JSON.stringify(graph);
    const filenamePrefix = (graph['10'] as { inputs: { filename_prefix: string } }).inputs
      .filename_prefix;
    expect(filenamePrefix).not.toContain('fighter');
    expect(serialised).toContain('A fighter shadowboxing');
  });

  it('routes an image-to-video request through LTXVImgToVideo', () => {
    const graph = profile.buildGraph(
      translateSubmitInput(
        input({
          mode: 'IMAGE_TO_VIDEO',
          referenceImages: [
            {
              assetId: 'ref-1',
              rights: {
                usageClass: 'OWNED',
                rightsHolder: 'Combat Reviews',
                licenseType: 'FULL_BUY_OUT',
              },
            },
          ],
        }),
        profile,
        { referenceImageFilenames: ['combat-ref-abc.png'] },
      ),
    );

    expect(graph['4']).toMatchObject({
      class_type: 'LoadImage',
      inputs: { image: 'combat-ref-abc.png' },
    });
    expect(graph['5']).toMatchObject({ class_type: 'LTXVImgToVideo' });
    expect(graph['7']).toMatchObject({
      inputs: expect.objectContaining({ latent_image: ['5', 2] }),
    });
  });
});

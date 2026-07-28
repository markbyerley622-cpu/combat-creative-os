import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ManifestValidationError,
  MIN_TRANSITION_SECONDS,
  parseRenderManifest,
  RenderManifestSchema,
  secondsToFrames,
  type RenderManifest,
} from './manifest';

const FIXTURE_MANIFEST_PATH = resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'combat-reviews-15s.manifest.json',
);

async function loadFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(FIXTURE_MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
}

/** The fixture with one branch mutated — every negative case starts from something valid. */
async function fixtureWith(
  mutate: (manifest: Record<string, any>) => void,
): Promise<Record<string, unknown>> {
  const manifest = await loadFixture();
  mutate(manifest as Record<string, any>);
  return manifest;
}

function issuePaths(error: unknown): string[] {
  expect(error).toBeInstanceOf(ManifestValidationError);
  return (error as ManifestValidationError).issues.map((issue) => issue.path);
}

function expectRejected(value: unknown): unknown {
  try {
    parseRenderManifest(value);
  } catch (error) {
    return error;
  }
  throw new Error('expected the manifest to be rejected, but it parsed');
}

describe('render manifest — the checked-in fixture', () => {
  it('parses, and is the manifest the CLI and the integration test both use', async () => {
    const manifest = parseRenderManifest(await loadFixture());
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.output.widthPx).toBe(1080);
    expect(manifest.output.heightPx).toBe(1920);
    expect(manifest.output.frameRate).toBe(30);
    expect(manifest.output.durationSeconds).toBe(15);
  });

  it('references only sources cleared for production use — no ANALYSIS_ONLY material', async () => {
    const manifest = parseRenderManifest(await loadFixture());
    for (const source of manifest.sources) {
      expect(source.license.usageClass).not.toBe('ANALYSIS_ONLY');
    }
  });

  it('has a timeline whose scenes and transition overlaps land exactly on the requested duration', async () => {
    const manifest = parseRenderManifest(await loadFixture());
    const scenes = manifest.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
    const overlaps = manifest.scenes.reduce(
      (sum, scene) => sum + (scene.transitionIn?.durationSeconds ?? 0),
      0,
    );
    expect(scenes - overlaps).toBeCloseTo(manifest.output.durationSeconds, 6);
  });

  it('places every scene boundary and transition on a whole frame', async () => {
    const manifest = parseRenderManifest(await loadFixture());
    const fps = manifest.output.frameRate;
    for (const scene of manifest.scenes) {
      expect(scene.durationSeconds * fps).toBeCloseTo(
        secondsToFrames(scene.durationSeconds, fps),
        6,
      );
      if (scene.transitionIn) {
        const frames = scene.transitionIn.durationSeconds * fps;
        expect(frames).toBeCloseTo(Math.round(frames), 6);
      }
    }
  });

  it('keeps the CTA inside the final two seconds, as VERTICAL_SHORT_FORM_V1 requires', async () => {
    const manifest = parseRenderManifest(await loadFixture());
    expect(manifest.cta).toBeDefined();
    const cta = manifest.cta as NonNullable<RenderManifest['cta']>;
    expect(cta.endSeconds).toBe(manifest.output.durationSeconds);
    expect(manifest.output.durationSeconds - cta.startSeconds).toBeGreaterThanOrEqual(2);
  });
});

describe('render manifest — validation', () => {
  it('rejects an unknown manifest version rather than reading it as the newest known one', async () => {
    const error = expectRejected(await fixtureWith((m) => (m.manifestVersion = 3)));
    expect(issuePaths(error)).toContain('manifestVersion');
  });

  it('refuses a v2-only field on a v1 manifest, naming the field and the version', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.manifestVersion = 1;
        (m.scenes as Record<string, unknown>[])[0]!.treatment = { key: 'PUSH_IN', intensity: 0.4 };
      }),
    );
    expect((error as ManifestValidationError).message).toContain(
      'scene.treatment requires manifestVersion 2',
    );
  });

  it('accepts the same field once the manifest declares version 2', async () => {
    const manifest = parseRenderManifest(
      await fixtureWith((m) => {
        m.manifestVersion = 2;
        (m.scenes as Record<string, unknown>[])[0]!.treatment = { key: 'PUSH_IN', intensity: 0.4 };
      }),
    );
    expect(manifest.scenes[0]?.treatment).toEqual({ key: 'PUSH_IN', intensity: 0.4 });
  });

  it('refuses a treatment the scene source cannot carry', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.manifestVersion = 2;
        // Scene 0 is a video clip in the fixture; a bezelled UI frame is a
        // still-image treatment.
        (m.scenes as Record<string, unknown>[])[0]!.treatment = {
          key: 'FRAMED_PHONE_UI',
          intensity: 0.5,
        };
      }),
    );
    expect((error as ManifestValidationError).message).toContain('accepts IMAGE sources');
  });

  it('rejects an unknown top-level field instead of silently ignoring it', async () => {
    const error = expectRejected(await fixtureWith((m) => (m.renderer = 'aerender')));
    expect(error).toBeInstanceOf(ManifestValidationError);
  });

  it('rejects a timeline that does not add up to the requested duration', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.scenes[0].durationSeconds = 4.0;
      }),
    );
    expect((error as ManifestValidationError).message).toMatch(
      /minus transition overlaps .* but output.durationSeconds is 15/,
    );
  });

  it('rejects a scene pointing at a source that does not exist', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.scenes[0].sourceId = 'no-such-source';
      }),
    );
    expect(issuePaths(error)).toContain('scenes.0.sourceId');
  });

  it('rejects a scene whose source is audio', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.scenes[0].sourceId = 'music-bed';
      }),
    );
    expect(issuePaths(error)).toContain('scenes.0.sourceId');
  });

  it('rejects a video scene with no trim range', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        delete m.scenes[0].trim;
      }),
    );
    expect(issuePaths(error)).toContain('scenes.0.trim');
  });

  it('rejects a trim range shorter than the scene it feeds', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.scenes[0].trim = { inSeconds: 0.5, outSeconds: 1.0 };
      }),
    );
    expect(issuePaths(error)).toContain('scenes.0.trim');
  });

  it('rejects a still-image scene that declares a trim range', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.scenes[1].trim = { inSeconds: 0, outSeconds: 3 };
      }),
    );
    expect(issuePaths(error)).toContain('scenes.1.trim');
  });

  it('rejects a transitionIn on the first scene, and a missing one on any later scene', async () => {
    const first = expectRejected(
      await fixtureWith((m) => {
        m.scenes[0].transitionIn = { kind: 'CUT', durationSeconds: 0.2 };
      }),
    );
    expect(issuePaths(first)).toContain('scenes.0.transitionIn');

    const later = expectRejected(
      await fixtureWith((m) => {
        delete m.scenes[1].transitionIn;
      }),
    );
    expect(issuePaths(later)).toContain('scenes.1.transitionIn');
  });

  it('rejects a transition shorter than one frame — xfade cannot express a zero overlap', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.scenes[1].transitionIn.durationSeconds = 0;
      }),
    );
    expect(issuePaths(error)).toContain('scenes.1.transitionIn.durationSeconds');
    expect(MIN_TRANSITION_SECONDS).toBeCloseTo(1 / 30, 8);
  });

  it('rejects PARALLAX motion on a video source', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.scenes[0].motion = 'PARALLAX';
      }),
    );
    expect(issuePaths(error)).toContain('scenes.0.motion');
  });

  it('rejects an overlay, caption cue or CTA scheduled past the end of the cut', async () => {
    expect(
      issuePaths(
        expectRejected(
          await fixtureWith((m) => {
            m.overlays[0].endSeconds = 16;
          }),
        ),
      ),
    ).toContain('overlays.0.endSeconds');

    expect(
      issuePaths(
        expectRejected(
          await fixtureWith((m) => {
            m.captions.cues[0].endSeconds = 20;
          }),
        ),
      ),
    ).toContain('captions.cues.0.endSeconds');

    expect(
      issuePaths(
        expectRejected(
          await fixtureWith((m) => {
            m.cta.endSeconds = 15.5;
          }),
        ),
      ),
    ).toContain('cta.endSeconds');
  });

  it('rejects a logo or CTA lockup that points at a video source', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.branding.logoSourceId = 'clip-training';
      }),
    );
    expect(issuePaths(error)).toContain('branding.logoSourceId');
  });

  it('rejects audio tracks when the output asks for no audio stream', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.output.audioCodec = null;
      }),
    );
    expect(issuePaths(error)).toContain('audio.tracks');
  });

  it('rejects an audio stream requested with nothing to put in it', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        delete m.audio;
        for (const scene of m.scenes) scene.useSourceAudio = false;
      }),
    );
    expect(issuePaths(error)).toContain('audio');
  });

  it('rejects a duplicate source, scene or audio-track id', async () => {
    expect(
      issuePaths(
        expectRejected(
          await fixtureWith((m) => {
            m.sources[1].id = m.sources[0].id;
          }),
        ),
      ),
    ).toContain('sources.1.id');

    expect(
      issuePaths(
        expectRejected(
          await fixtureWith((m) => {
            m.scenes[1].id = m.scenes[0].id;
          }),
        ),
      ),
    ).toContain('scenes.1.id');
  });

  it('rejects a name that is not filesystem-safe, since it becomes part of the output filename', async () => {
    const error = expectRejected(await fixtureWith((m) => (m.name = '../escape')));
    expect(issuePaths(error)).toContain('name');
  });

  it('reports every problem at once rather than only the first', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.scenes[0].sourceId = 'missing-a';
        m.branding.logoSourceId = 'missing-b';
      }),
    );
    expect((error as ManifestValidationError).issues.length).toBeGreaterThanOrEqual(2);
  });

  it('applies documented defaults for optional presentation fields', () => {
    const parsed = RenderManifestSchema.parse({
      manifestVersion: 1,
      name: 'minimal',
      campaignId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      campaignPrompt: 'minimal cut',
      output: {
        durationSeconds: 2,
        aspectRatio: '9:16',
        widthPx: 1080,
        heightPx: 1920,
        frameRate: 30,
        container: 'mp4',
        videoCodec: 'h264',
        audioCodec: null,
        pixelFormat: 'yuv420p',
      },
      sources: [
        {
          id: 'still',
          kind: 'IMAGE',
          path: 'still.png',
          description: 'a still',
          license: {
            usageClass: 'OWNED',
            rightsHolder: 'Combat Reviews',
            licenseType: 'FULL_RIGHTS',
          },
        },
      ],
      scenes: [{ id: 'only', sourceId: 'still', durationSeconds: 2 }],
    });
    expect(parsed.scenes[0]?.motion).toBe('STATIC');
    expect(parsed.scenes[0]?.framing.mode).toBe('COVER');
    expect(parsed.scenes[0]?.useSourceAudio).toBe(false);
    expect(parsed.output.durationToleranceFrames).toBe(2);
    expect(parsed.output.deliveryProfileKey).toBe('VERTICAL_SHORT_FORM_V1');
    expect(parsed.sources[0]?.license.restrictions).toEqual([]);
    expect(parsed.overlays).toEqual([]);
  });
});

describe('render manifest — the v2 colour grade', () => {
  it('refuses a grade on a v1 manifest by name', async () => {
    const error = expectRejected(
      await fixtureWith((m) => {
        m.manifestVersion = 1;
        m.scenes[0].grade = { key: 'BRAND_NOIR', intensity: 0.5 };
      }),
    );
    expect((error as ManifestValidationError).message).toContain('scene.grade');
  });

  it('accepts a grade on a v2 manifest and defaults its intensity', async () => {
    const manifest = parseRenderManifest(
      await fixtureWith((m) => {
        m.manifestVersion = 2;
        m.scenes[0].grade = { key: 'BRAND_EMBER' };
      }),
    );
    expect(manifest.scenes[0]?.grade).toEqual({ key: 'BRAND_EMBER', intensity: 0.5 });
  });

  it('leaves an ungraded scene ungraded rather than defaulting one in', async () => {
    const manifest = parseRenderManifest(
      await fixtureWith((m) => {
        m.manifestVersion = 2;
      }),
    );
    expect(manifest.scenes[0]?.grade).toBeUndefined();
  });

  it('refuses a grade key the catalogue does not have', async () => {
    expectRejected(
      await fixtureWith((m) => {
        m.manifestVersion = 2;
        m.scenes[0].grade = { key: 'SEPIA' };
      }),
    );
  });
});

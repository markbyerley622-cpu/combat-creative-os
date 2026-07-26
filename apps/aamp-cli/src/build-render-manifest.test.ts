import { describe, expect, it } from 'vitest';

import { buildRenderManifest, planTimeline, TimelineError } from './build-render-manifest';
import { parseGenerationManifest } from './generation-manifest';
import type { GeneratedShotResult } from './generate-shots';

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

function generationManifest(overrides: Record<string, unknown> = {}) {
  return parseGenerationManifest({
    manifestVersion: 1,
    name: 'combat-reviews-15s',
    workspaceId: WORKSPACE_ID,
    campaignId: CAMPAIGN_ID,
    brandName: 'Combat Reviews',
    campaignPrompt: 'Show fight fans that Combat Reviews settles every argument about a fight.',
    objective: 'Drive app installs',
    targetAudience: 'Combat sports fans aged 18-34',
    hook: 'Who really won that round?',
    keyMessages: ['Every round scored', 'Argue with data'],
    outputDurationSeconds: 15,
    generation: { profile: 'LTX_2_3_DRAFT', shotCount: 1, maxShotDurationSeconds: 4 },
    cta: { headline: 'Download Combat Reviews', durationSeconds: 3 },
    assets: [
      {
        id: 'logo',
        role: 'LOGO',
        kind: 'IMAGE',
        path: './logo.png',
        description: 'Combat Reviews logo',
        license: {
          usageClass: 'OWNED',
          rightsHolder: 'Combat Reviews',
          licenseType: 'FULL_BUY_OUT',
        },
      },
      {
        id: 'shot-app-1',
        role: 'APP_SCREENSHOT',
        kind: 'IMAGE',
        path: './app-1.png',
        description: 'Scorecard screen',
        license: {
          usageClass: 'OWNED',
          rightsHolder: 'Combat Reviews',
          licenseType: 'FULL_BUY_OUT',
        },
      },
    ],
    ...overrides,
  });
}

function generatedShot(durationSeconds: number): GeneratedShotResult {
  return {
    brief: {
      index: 0,
      shotId: '33333333-3333-4333-8333-333333333333',
      description: 'A fighter throwing a combination',
      durationSeconds,
      promptText: 'a fighter throwing a combination',
      creativeAttributes: {
        subject: 'a fighter',
        action: 'throwing a combination',
        environment: 'a gym',
        cameraMovement: 'slow push in',
        lensFraming: 'medium',
        lighting: 'hard key',
        colorTreatment: 'cool',
        motionIntensity: 'DYNAMIC',
        continuityRequirements: [],
        visualObjective: 'establish energy',
      },
    },
    localPath: 'C:/generated/shot-0.mp4',
    checksumSha256: 'a'.repeat(64),
    sizeBytes: 500_000,
    measuredDurationSeconds: durationSeconds,
    measuredWidthPx: 704,
    measuredHeightPx: 1280,
    measuredVideoCodec: 'h264',
    measuredFrameRate: 24,
  };
}

const resolvedAssets = (manifest: ReturnType<typeof generationManifest>) =>
  manifest.assets.map((asset) => ({ asset, absolutePath: `C:/campaign/${asset.path.slice(2)}` }));

describe('timeline planning', () => {
  it('makes scenes minus transition overlaps land exactly on the requested duration', () => {
    const totalFrames = 450; // 15s at 30fps
    const plan = planTimeline(
      [
        { sourceId: 'gen-0', kind: 'VIDEO', availableFrames: 120, frames: 0 },
        { sourceId: 'app-1', kind: 'IMAGE', frames: 0 },
        { sourceId: 'app-2', kind: 'IMAGE', frames: 0 },
      ],
      totalFrames,
    );

    const sceneTotal = plan.reduce((sum, scene) => sum + scene.frames, 0);
    const overlaps = (plan.length - 1) * 12;
    expect(sceneTotal - overlaps).toBe(totalFrames);
  });

  it('never asks a clip for more frames than it contains', () => {
    const plan = planTimeline(
      [
        { sourceId: 'gen-0', kind: 'VIDEO', availableFrames: 97, frames: 0 },
        { sourceId: 'app-1', kind: 'IMAGE', frames: 0 },
      ],
      450,
    );
    const video = plan.find((scene) => scene.sourceId === 'gen-0');
    expect(video?.frames).toBeLessThan(97);
  });

  it('refuses a timeline with no still to absorb the remainder', () => {
    expect(() =>
      planTimeline([{ sourceId: 'gen-0', kind: 'VIDEO', availableFrames: 97, frames: 0 }], 450),
    ).toThrow(TimelineError);
  });

  it('refuses when generated footage overruns the whole cut', () => {
    expect(() =>
      planTimeline(
        [
          { sourceId: 'gen-0', kind: 'VIDEO', availableFrames: 600, frames: 0 },
          { sourceId: 'app-1', kind: 'IMAGE', frames: 0 },
        ],
        450,
      ),
    ).toThrow(/leaves only/);
  });
});

describe('render manifest assembly', () => {
  it('produces a manifest the renderer’s own schema accepts', () => {
    const manifest = generationManifest();
    const built = buildRenderManifest({
      manifest,
      generatedShots: [generatedShot(4.04)],
      resolvedAssets: resolvedAssets(manifest),
    });

    expect(built.output).toMatchObject({
      durationSeconds: 15,
      widthPx: 1080,
      heightPx: 1920,
      videoCodec: 'h264',
    });
    // No music asset in this manifest, so the master is deliberately silent.
    expect(built.output.audioCodec).toBeNull();
  });

  it('places the generated clip as a real source with its measured checksum', () => {
    const manifest = generationManifest();
    const built = buildRenderManifest({
      manifest,
      generatedShots: [generatedShot(4.04)],
      resolvedAssets: resolvedAssets(manifest),
    });

    const generated = built.sources.find((source) => source.id === 'gen-0');
    expect(generated).toMatchObject({
      kind: 'VIDEO',
      path: 'C:/generated/shot-0.mp4',
      expectedChecksum: 'a'.repeat(64),
    });
    expect(generated?.license.usageClass).toBe('OWNED');
  });

  it('ends on the CTA and keeps captions clear of it', () => {
    const manifest = generationManifest();
    const built = buildRenderManifest({
      manifest,
      generatedShots: [generatedShot(4.04)],
      resolvedAssets: resolvedAssets(manifest),
    });

    expect(built.cta?.startSeconds).toBe(12);
    expect(built.cta?.endSeconds).toBe(15);
    for (const cue of built.captions?.cues ?? []) {
      expect(cue.endSeconds).toBeLessThanOrEqual(12);
    }
  });

  it('adds an aac audio stream when music is supplied', () => {
    const manifest = generationManifest({
      assets: [
        ...generationManifest().assets,
        {
          id: 'music',
          role: 'MUSIC',
          kind: 'AUDIO',
          path: './bed.wav',
          description: 'Licensed music bed',
          license: {
            usageClass: 'LICENSED_FOR_OUTPUT',
            rightsHolder: 'Stock house',
            licenseType: 'ROYALTY_FREE',
            restrictions: [],
          },
        },
      ],
    });

    const built = buildRenderManifest({
      manifest,
      generatedShots: [generatedShot(4.04)],
      resolvedAssets: resolvedAssets(manifest),
    });

    expect(built.output.audioCodec).toBe('aac');
    expect(built.audio?.tracks[0]).toMatchObject({ role: 'MUSIC', sourceId: 'music' });
  });
});

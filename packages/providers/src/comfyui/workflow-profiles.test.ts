import { describe, expect, it } from 'vitest';

import {
  COMFYUI_WORKFLOW_PROFILES,
  COMFYUI_WORKFLOW_PROFILE_KEYS,
  ComfyUIProfileError,
  getComfyUIWorkflowProfile,
  isComfyUIWorkflowProfileKey,
  largestDeviceVramGb,
  snapDimension,
} from './workflow-profiles';

describe('the profile registry', () => {
  it('exposes exactly the declared keys', () => {
    expect(Object.keys(COMFYUI_WORKFLOW_PROFILES).sort()).toEqual(
      [...COMFYUI_WORKFLOW_PROFILE_KEYS].sort(),
    );
  });

  it('rejects an unknown key rather than defaulting to one', () => {
    expect(isComfyUIWorkflowProfileKey('SOMETHING_ELSE')).toBe(false);
  });

  it('records model files, a licence and a hardware floor for every profile', () => {
    for (const key of COMFYUI_WORKFLOW_PROFILE_KEYS) {
      const profile = getComfyUIWorkflowProfile(key);
      expect(profile.modelFiles.length).toBeGreaterThan(0);
      expect(profile.license.url).toMatch(/^https:\/\//);
      expect(profile.hardware.minimumVramGb).toBeGreaterThan(0);
      expect(profile.hardware.sourceUrl).toMatch(/^https:\/\//);
      expect(profile.requiredNodes.length).toBeGreaterThan(0);
    }
  });
});

describe('LTX_2_3_DRAFT compatibility validation', () => {
  const profile = getComfyUIWorkflowProfile('LTX_2_3_DRAFT');
  const allNodes = new Set(profile.requiredNodes);

  it('accepts an endpoint with every required node and enough VRAM', () => {
    expect(profile.validateEnvironment({ installedNodes: allNodes, vramGb: 24 })).toEqual({
      compatible: true,
      problems: [],
    });
  });

  it('names the specific node classes that are missing', () => {
    const partial = new Set(
      profile.requiredNodes.filter((node) => node !== 'EmptyLTXVLatentVideo'),
    );
    const result = profile.validateEnvironment({ installedNodes: partial, vramGb: 24 });

    expect(result.compatible).toBe(false);
    expect(result.problems[0]).toContain('EmptyLTXVLatentVideo');
  });

  it('refuses an endpoint below the profile’s VRAM floor', () => {
    const result = profile.validateEnvironment({ installedNodes: allNodes, vramGb: 4 });
    expect(result.compatible).toBe(false);
    expect(result.problems.join(' ')).toContain('needs at least 12 GB');
  });

  it('does not fail on VRAM when the endpoint does not report it', () => {
    expect(profile.validateEnvironment({ installedNodes: allNodes }).compatible).toBe(true);
  });
});

describe('HUNYUAN_VIDEO_1_5_QUALITY is declared but not runnable', () => {
  const profile = getComfyUIWorkflowProfile('HUNYUAN_VIDEO_1_5_QUALITY');

  it('is marked as requiring live verification', () => {
    expect(profile.templateStatus).toBe('REQUIRES_LIVE_VERIFICATION');
  });

  it('refuses compatibility even on a fully-equipped endpoint', () => {
    const result = profile.validateEnvironment({
      installedNodes: new Set(profile.requiredNodes),
      vramGb: 80,
    });
    expect(result.compatible).toBe(false);
    expect(result.problems.join(' ')).toContain('REQUIRES_LIVE_VERIFICATION');
  });

  it('refuses to build a graph rather than shipping an unverified one', () => {
    expect(() =>
      profile.buildGraph({
        promptText: 'x',
        negativePrompt: 'y',
        widthPx: 720,
        heightPx: 1280,
        frameCount: 49,
        frameRate: 24,
        seed: 1,
        steps: 30,
        cfg: 6,
        batchSize: 1,
        referenceImageFilenames: [],
        filenamePrefix: 'combat/abc',
        mode: 'TEXT_TO_VIDEO',
      }),
    ).toThrow(ComfyUIProfileError);
  });

  it('records that its licence does not clear commercial output', () => {
    expect(profile.license.permitsCommercialOutput).toBe(false);
  });
});

describe('helpers', () => {
  it('reads the largest device VRAM in GB', () => {
    expect(
      largestDeviceVramGb([{ vram_total: 4 * 1024 ** 3 }, { vram_total: 24 * 1024 ** 3 }]),
    ).toBeCloseTo(24, 5);
  });

  it('returns undefined when no device reports VRAM', () => {
    expect(largestDeviceVramGb([{}, {}])).toBeUndefined();
  });

  it('snaps a dimension up to at least one multiple', () => {
    expect(snapDimension(10, 32)).toBe(32);
    expect(snapDimension(1080, 32)).toBe(1088);
  });
});

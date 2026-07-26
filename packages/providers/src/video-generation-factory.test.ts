import { describe, expect, it } from 'vitest';

import {
  VideoGenerationProviderConfigError,
  createVideoGenerationProvider,
  resolveWorkflowProfileKey,
} from './video-generation-factory';
import { MockVideoGenerationProvider } from './video-generation.mock';

const comfyui = {
  baseUrl: 'http://127.0.0.1:8188',
  workflowProfile: 'LTX_2_3_DRAFT',
  clientId: 'combat-creative-os',
  outputTimeoutMs: 60_000,
  outputDirectory: '/tmp/aamp',
};

describe('provider selection', () => {
  it('builds the mock outside production', () => {
    const provider = createVideoGenerationProvider({ kind: 'mock', nodeEnv: 'test' });
    expect(provider).toBeInstanceOf(MockVideoGenerationProvider);
  });

  it('refuses the mock in production', () => {
    expect(() => createVideoGenerationProvider({ kind: 'mock', nodeEnv: 'production' })).toThrow(
      VideoGenerationProviderConfigError,
    );
  });

  it('states plainly why the mock is refused in production', () => {
    expect(() => createVideoGenerationProvider({ kind: 'mock', nodeEnv: 'production' })).toThrow(
      /every "generated" shot would be fabricated/,
    );
  });

  it('builds the real ComfyUI adapter when configured', () => {
    const provider = createVideoGenerationProvider({
      kind: 'comfyui',
      nodeEnv: 'production',
      comfyui,
    });
    expect(provider.name).toBe('comfyui:LTX_2_3_DRAFT');
  });

  it('refuses comfyui with no configuration block', () => {
    expect(() => createVideoGenerationProvider({ kind: 'comfyui', nodeEnv: 'production' })).toThrow(
      /no ComfyUI configuration was supplied/,
    );
  });

  it('rejects a base URL that is not http(s)', () => {
    expect(() =>
      createVideoGenerationProvider({
        kind: 'comfyui',
        nodeEnv: 'development',
        comfyui: { ...comfyui, baseUrl: 'file:///etc/passwd' },
      }),
    ).toThrow(/must be http: or https:/);
  });
});

describe('workflow profile resolution', () => {
  it('accepts a known, verified profile', () => {
    expect(resolveWorkflowProfileKey('LTX_2_3_DRAFT')).toBe('LTX_2_3_DRAFT');
  });

  it('rejects an unknown profile name', () => {
    expect(() => resolveWorkflowProfileKey('LTX_9')).toThrow(/not a known workflow profile/);
  });

  it('refuses a profile whose template has never been verified against a live server', () => {
    expect(() => resolveWorkflowProfileKey('HUNYUAN_VIDEO_1_5_QUALITY')).toThrow(
      /REQUIRES_LIVE_VERIFICATION/,
    );
  });
});

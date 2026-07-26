import { describe, expect, it } from 'vitest';

import { workerEnvSchema, type WorkerEnv } from '@combat/config';
import {
  COMFYUI_WORKFLOW_PROFILE_KEYS,
  MockVideoGenerationProvider,
  VideoGenerationProviderConfigError,
} from '@combat/providers';

import { resolveVideoGenerationProvider } from './activity-dependencies';

const BASE = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/combat',
  REASONING_PROVIDER: 'mock' as const,
};

function env(overrides: Record<string, unknown>): WorkerEnv {
  return workerEnvSchema.parse({ ...BASE, ...overrides });
}

describe('the Worker resolves its video-generation provider from config', () => {
  it('builds the mock in development', () => {
    const provider = resolveVideoGenerationProvider(
      env({ NODE_ENV: 'development', VIDEO_GENERATION_PROVIDER: 'mock' }),
      process.cwd(),
    );
    expect(provider).toBeInstanceOf(MockVideoGenerationProvider);
  });

  it('builds the real ComfyUI adapter when one is configured', () => {
    const provider = resolveVideoGenerationProvider(
      env({
        VIDEO_GENERATION_PROVIDER: 'comfyui',
        COMFYUI_BASE_URL: 'http://comfy.internal:8188',
      }),
      process.cwd(),
    );
    expect(provider.name).toBe('comfyui:LTX_2_3_DRAFT');
  });

  it('refuses a profile whose template has never been verified', () => {
    expect(() =>
      resolveVideoGenerationProvider(
        env({
          VIDEO_GENERATION_PROVIDER: 'comfyui',
          COMFYUI_BASE_URL: 'http://comfy.internal:8188',
          COMFYUI_WORKFLOW_PROFILE: 'HUNYUAN_VIDEO_1_5_QUALITY',
        }),
        process.cwd(),
      ),
    ).toThrow(VideoGenerationProviderConfigError);
  });

  it('refuses an unknown profile name', () => {
    expect(() =>
      resolveVideoGenerationProvider(
        env({
          VIDEO_GENERATION_PROVIDER: 'comfyui',
          COMFYUI_BASE_URL: 'http://comfy.internal:8188',
          COMFYUI_WORKFLOW_PROFILE: 'NOT_A_PROFILE',
        }),
        process.cwd(),
      ),
    ).toThrow(/not a known workflow profile/);
  });
});

describe('config and the profile registry do not drift apart', () => {
  /**
   * `packages/config` deliberately types `COMFYUI_WORKFLOW_PROFILE` as a plain
   * string, because it must not depend on `packages/providers`. This is the
   * test that keeps the two honest: the schema's documented default has to be
   * a key the registry actually knows, or a default-configured Worker would
   * fail at construction instead of starting.
   */
  it('the schema default names a real, selectable profile', () => {
    const configured = workerEnvSchema.parse(BASE).COMFYUI_WORKFLOW_PROFILE;
    expect(COMFYUI_WORKFLOW_PROFILE_KEYS).toContain(configured);
    expect(() =>
      resolveVideoGenerationProvider(
        env({ VIDEO_GENERATION_PROVIDER: 'comfyui', COMFYUI_BASE_URL: 'http://x:8188' }),
        process.cwd(),
      ),
    ).not.toThrow();
  });
});

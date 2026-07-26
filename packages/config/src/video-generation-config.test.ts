import { describe, expect, it } from 'vitest';

import { aampCliEnvSchema, videoGenerationEnvSchema, workerEnvSchema } from './schema';

const WORKER_BASE = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/combat',
  REASONING_PROVIDER: 'mock' as const,
};

function issuePaths(error: unknown): string[] {
  const zodError = error as { issues?: { path: (string | number)[] }[] };
  return (zodError.issues ?? []).map((issue) => issue.path.join('.'));
}

describe('video generation config defaults', () => {
  it('defaults to the mock so a fresh clone needs no GPU or endpoint', () => {
    const parsed = videoGenerationEnvSchema.parse({});
    expect(parsed.VIDEO_GENERATION_PROVIDER).toBe('mock');
    expect(parsed.COMFYUI_WORKFLOW_PROFILE).toBe('LTX_2_3_DRAFT');
    expect(parsed.COMFYUI_OUTPUT_TIMEOUT_MS).toBe(900_000);
  });

  it('coerces the timeout from its string environment form', () => {
    expect(
      videoGenerationEnvSchema.parse({ COMFYUI_OUTPUT_TIMEOUT_MS: '120000' })
        .COMFYUI_OUTPUT_TIMEOUT_MS,
    ).toBe(120_000);
  });
});

describe('the worker fails closed on video-generation configuration', () => {
  it('refuses to start in production with the mock selected', () => {
    const result = workerEnvSchema.safeParse({
      ...WORKER_BASE,
      NODE_ENV: 'production',
      VIDEO_GENERATION_PROVIDER: 'mock',
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result.error)).toContain('VIDEO_GENERATION_PROVIDER');
  });

  it('allows the mock outside production', () => {
    expect(
      workerEnvSchema.safeParse({
        ...WORKER_BASE,
        NODE_ENV: 'development',
        VIDEO_GENERATION_PROVIDER: 'mock',
      }).success,
    ).toBe(true);
  });

  it('refuses comfyui with no endpoint rather than falling back to the mock', () => {
    const result = workerEnvSchema.safeParse({
      ...WORKER_BASE,
      NODE_ENV: 'development',
      VIDEO_GENERATION_PROVIDER: 'comfyui',
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result.error)).toContain('COMFYUI_BASE_URL');
    expect(JSON.stringify(result.error)).toContain('silently falling back to the mock');
  });

  it('refuses an endpoint that is not a URL', () => {
    const result = workerEnvSchema.safeParse({
      ...WORKER_BASE,
      VIDEO_GENERATION_PROVIDER: 'comfyui',
      COMFYUI_BASE_URL: 'not a url',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a non-http endpoint scheme', () => {
    const result = workerEnvSchema.safeParse({
      ...WORKER_BASE,
      VIDEO_GENERATION_PROVIDER: 'comfyui',
      COMFYUI_BASE_URL: 'file:///models',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('must be http: or https:');
  });

  it('accepts a fully configured comfyui worker in production', () => {
    expect(
      workerEnvSchema.safeParse({
        ...WORKER_BASE,
        NODE_ENV: 'production',
        VIDEO_GENERATION_PROVIDER: 'comfyui',
        COMFYUI_BASE_URL: 'http://comfy.internal:8188',
      }).success,
    ).toBe(true);
  });

  it('never surfaces the API key value in a validation error', () => {
    const result = workerEnvSchema.safeParse({
      ...WORKER_BASE,
      NODE_ENV: 'production',
      VIDEO_GENERATION_PROVIDER: 'mock',
      COMFYUI_API_KEY: 'super-secret-value',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).not.toContain('super-secret-value');
  });
});

describe('the aamp-cli schema applies the same rules without database config', () => {
  it('needs no DATABASE_URL', () => {
    expect(aampCliEnvSchema.safeParse({ NODE_ENV: 'development' }).success).toBe(true);
  });

  it('still refuses comfyui with no endpoint', () => {
    const result = aampCliEnvSchema.safeParse({ VIDEO_GENERATION_PROVIDER: 'comfyui' });
    expect(result.success).toBe(false);
    expect(issuePaths(result.error)).toContain('COMFYUI_BASE_URL');
  });

  it('still refuses the mock in production', () => {
    expect(
      aampCliEnvSchema.safeParse({ NODE_ENV: 'production', VIDEO_GENERATION_PROVIDER: 'mock' })
        .success,
    ).toBe(false);
  });
});

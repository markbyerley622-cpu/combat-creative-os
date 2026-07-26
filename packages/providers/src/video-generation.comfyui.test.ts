import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeComfyUIServer } from './comfyui/testing/fake-comfyui-server';
import { ComfyUIVideoGenerationProvider, derivePromptId } from './video-generation.comfyui';
import { VideoGenerationError, type VideoGenerationSubmitInput } from './video-generation';

let outputDirectory: string;

beforeEach(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), 'comfyui-provider-'));
});

afterEach(async () => {
  await rm(outputDirectory, { recursive: true, force: true });
});

function submitInput(
  overrides: Partial<VideoGenerationSubmitInput> = {},
): VideoGenerationSubmitInput {
  return {
    idempotencyKey: 'run-1:GEN:shot-1:1',
    shotId: 'shot-1',
    mode: 'TEXT_TO_VIDEO',
    promptText: 'A fighter shadowboxing in a dim gym',
    candidateCount: 1,
    params: { durationSeconds: 4, aspectRatio: '9:16', resolution: '704x1280', frameRate: 24 },
    ...overrides,
  };
}

function build(
  server: ReturnType<typeof createFakeComfyUIServer>,
  overrides: { outputTimeoutMs?: number; now?: () => Date } = {},
): ComfyUIVideoGenerationProvider {
  return new ComfyUIVideoGenerationProvider({
    baseUrl: 'http://127.0.0.1:8188',
    profileKey: 'LTX_2_3_DRAFT',
    clientId: 'test-client',
    outputTimeoutMs: overrides.outputTimeoutMs ?? 60_000,
    outputDirectory,
    fetchImpl: server.fetchImpl,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

describe('ComfyUIVideoGenerationProvider — submission', () => {
  it('queues one prompt and returns ComfyUI’s own prompt id as the job id', async () => {
    const server = createFakeComfyUIServer();
    const handle = await build(server).submit(submitInput());

    expect(handle.jobId).toBe(derivePromptId('run-1:GEN:shot-1:1'));
    expect(server.submittedPromptIds).toEqual([handle.jobId]);
  });

  it('is idempotent: the same key never queues a second render', async () => {
    const server = createFakeComfyUIServer();
    const provider = build(server);

    const first = await provider.submit(submitInput());
    const second = await provider.submit(submitInput());

    expect(second.jobId).toBe(first.jobId);
    expect(server.submittedPromptIds).toHaveLength(1);
  });

  it('does not re-queue a job the server already knows about after a restart', async () => {
    const server = createFakeComfyUIServer();
    // A different provider instance stands in for a restarted worker: it has
    // no in-memory record, so only the server's own state can prevent a
    // duplicate paid render.
    await build(server).submit(submitInput());
    await build(server).submit(submitInput());

    expect(server.submittedPromptIds).toHaveLength(1);
  });

  it('translates a ComfyUI validation failure into a non-retryable rejection', async () => {
    const server = createFakeComfyUIServer({ rejectSubmission: 'ckpt_name: file not found' });

    await expect(build(server).submit(submitInput())).rejects.toMatchObject({
      failure: { reason: 'PROVIDER_REJECTED', retryable: false },
    });
  });

  it('rejects an unsupported capability before anything is queued', async () => {
    const server = createFakeComfyUIServer();

    await expect(
      build(server).submit(submitInput({ params: { durationSeconds: 90, aspectRatio: '9:16' } })),
    ).rejects.toBeInstanceOf(VideoGenerationError);
    expect(server.submittedPromptIds).toHaveLength(0);
  });

  it('refuses an ANALYSIS_ONLY reference without contacting the server', async () => {
    const server = createFakeComfyUIServer();

    await expect(
      build(server).submit(
        submitInput({
          mode: 'IMAGE_TO_VIDEO',
          referenceImages: [
            {
              assetId: 'ref-1',
              localPath: join(outputDirectory, 'never-read.png'),
              rights: {
                usageClass: 'ANALYSIS_ONLY',
                rightsHolder: 'Third party',
                licenseType: 'REFERENCE',
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/ANALYSIS_ONLY/);
    expect(server.calls).toHaveLength(0);
  });

  it('refuses a reference with no rights metadata at all', async () => {
    const server = createFakeComfyUIServer();

    await expect(
      build(server).submit(
        submitInput({ mode: 'IMAGE_TO_VIDEO', referenceImages: [{ assetId: 'ref-1' }] }),
      ),
    ).rejects.toThrow(/no rights metadata/);
    expect(server.calls).toHaveLength(0);
  });
});

describe('ComfyUIVideoGenerationProvider — polling', () => {
  it('reports POLLING while queued and SUCCEEDED once history has output', async () => {
    const server = createFakeComfyUIServer({ pollsBeforeCompletion: 2 });
    const provider = build(server);
    const handle = await provider.submit(submitInput());

    expect(await provider.getStatus(handle)).toBe('POLLING');
    expect(await provider.getStatus(handle)).toBe('POLLING');
    expect(await provider.getStatus(handle)).toBe('SUCCEEDED');
  });

  it('maps an execution error to FAILED with the node detail preserved', async () => {
    const server = createFakeComfyUIServer({ failWithError: 'CUDA out of memory' });
    const provider = build(server);
    const handle = await provider.submit(submitInput());

    expect(await provider.getStatus(handle)).toBe('FAILED');
    expect(await provider.getFailure(handle)).toMatchObject({
      reason: 'PROVIDER_ERROR',
      message: expect.stringContaining('CUDA out of memory'),
    });
  });

  it('times out and interrupts the run once the deadline passes', async () => {
    const server = createFakeComfyUIServer({ pollsBeforeCompletion: 99 });
    let clock = new Date('2026-07-26T00:00:00Z');
    const provider = build(server, { outputTimeoutMs: 1_000, now: () => clock });
    const handle = await provider.submit(submitInput());

    clock = new Date('2026-07-26T00:05:00Z');
    expect(await provider.getStatus(handle)).toBe('TIMED_OUT');
    expect(server.interruptCount()).toBe(1);
  });

  it('rejects a malformed response rather than treating it as progress', async () => {
    const server = createFakeComfyUIServer({ malformedResponses: true });
    const provider = build(server);

    await expect(provider.submit(submitInput())).rejects.toMatchObject({
      failure: { reason: 'PROVIDER_REJECTED' },
    });
  });
});

describe('ComfyUIVideoGenerationProvider — output retrieval', () => {
  it('downloads the clip, checksums it, and records generation provenance', async () => {
    const server = createFakeComfyUIServer();
    const provider = build(server);
    const handle = await provider.submit(submitInput());
    await provider.getStatus(handle);

    const [candidate] = await provider.fetchResult(handle);

    expect(candidate).toBeDefined();
    const bytes = await readFile(candidate!.localPath!);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(candidate!.checksumSha256);
    expect(candidate!.sizeBytes).toBe(bytes.byteLength);
    expect(candidate!.provenance).toMatchObject({
      workflowProfileKey: 'LTX_2_3_DRAFT',
      modelIdentifier: 'ltx-2-19b-distilled',
      templateVersion: 1,
    });
    expect(candidate!.provenance?.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a job that completed with no video output', async () => {
    const server = createFakeComfyUIServer({ completeWithNoOutput: true });
    const provider = build(server);
    const handle = await provider.submit(submitInput());

    await expect(provider.fetchResult(handle)).rejects.toThrow(/no video output/);
  });

  it('refuses a zero-byte download instead of registering an empty asset', async () => {
    const server = createFakeComfyUIServer({ emptyOutputBytes: true });
    const provider = build(server);
    const handle = await provider.submit(submitInput());

    await expect(provider.fetchResult(handle)).rejects.toThrow(/zero-byte/);
  });

  it('does not attribute a job’s output to a different shot’s handle', async () => {
    const server = createFakeComfyUIServer();
    const provider = build(server);
    const handle = await provider.submit(submitInput());

    // A superseded attempt's late completion arriving under another shot id
    // must not inherit the original job's seed and prompt provenance.
    const [candidate] = await provider.fetchResult({ jobId: handle.jobId, shotId: 'other-shot' });

    expect(candidate?.provenance?.promptSha256).toBe('');
    expect(candidate?.seed).toBeUndefined();
  });
});

describe('ComfyUIVideoGenerationProvider — cancellation and environment', () => {
  it('dequeues and interrupts on cancel, then reports CANCELLED', async () => {
    const server = createFakeComfyUIServer({ pollsBeforeCompletion: 99 });
    const provider = build(server);
    const handle = await provider.submit(submitInput());

    await provider.cancel(handle);

    expect(server.deletedPromptIds).toContain(handle.jobId);
    expect(server.interruptCount()).toBe(1);
    expect(await provider.getStatus(handle)).toBe('CANCELLED');
    expect(await provider.fetchResult(handle)).toEqual([]);
  });

  it('confirms a compatible endpoint through /object_info and /system_stats', async () => {
    const server = createFakeComfyUIServer();
    await expect(build(server).verifyEnvironment()).resolves.toEqual({
      compatible: true,
      problems: [],
    });
  });

  it('reports the missing node classes when the endpoint cannot run the profile', async () => {
    const server = createFakeComfyUIServer({ installedNodes: ['CLIPTextEncode'] });
    const result = await build(server).verifyEnvironment();

    expect(result.compatible).toBe(false);
    expect(result.problems.join(' ')).toContain('EmptyLTXVLatentVideo');
  });

  it('reports insufficient VRAM rather than letting a job fail on the GPU', async () => {
    const server = createFakeComfyUIServer({ vramTotalBytes: 4 * 1024 ** 3 });
    const result = await build(server).verifyEnvironment();

    expect(result.compatible).toBe(false);
    expect(result.problems.join(' ')).toMatch(/4\.0 GB VRAM/);
  });

  it('surfaces an unreachable endpoint as an incompatible environment', async () => {
    const provider = new ComfyUIVideoGenerationProvider({
      baseUrl: 'http://127.0.0.1:8188',
      profileKey: 'LTX_2_3_DRAFT',
      clientId: 'test-client',
      outputTimeoutMs: 1_000,
      outputDirectory,
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    const result = await provider.verifyEnvironment();
    expect(result.compatible).toBe(false);
    expect(result.problems.join(' ')).toContain('ECONNREFUSED');
  });
});

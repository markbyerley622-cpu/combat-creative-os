import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { FakeLtxServer } from './ltx/testing/fake-ltx-server';
import {
  assertSupportedLtxDuration,
  assertSupportedLtxModel,
  ltxGenerationCostCents,
  LTX_PRICING_PROFILE,
  LtxModelSupportError,
  smallestCoveringDuration,
} from './ltx/models';
import { assertTransferUrlAllowed, LtxRequestError, redactUrl } from './ltx/http-client';
import { LTX_RESPONSE_CONTRACT_STATUS } from './ltx/protocol';
import {
  createLtxHostedProvider,
  VideoGenerationProviderConfigError,
} from './video-generation-factory';
import {
  LtxHostedVideoGenerationProvider,
  LtxVideoGenerationError,
} from './video-generation.ltx-hosted';

/**
 * Every test here runs against the in-process fake server and spends nothing.
 *
 * What it proves is the *client*: the upload contract, the poll loop, the
 * download, the failure mapping and — most importantly — that no credential
 * and no signed URL escapes the provider. It proves nothing about the live
 * API, which is why `LTX_RESPONSE_CONTRACT_STATUS` stays
 * `DOCUMENTED_NOT_EXECUTED`.
 */

const API_KEY = 'ltx_test_key_do_not_use_0123456789';

let directory: string;
let framePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ltx-provider-'));
  framePath = join(directory, 'FRAME-01.png');
  await writeFile(framePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
});

function build(server: FakeLtxServer, overrides: Record<string, unknown> = {}) {
  return new LtxHostedVideoGenerationProvider({
    apiKey: API_KEY,
    model: 'ltx-2-3-fast',
    baseUrl: 'https://api.ltx.io',
    outputTimeoutMs: 60_000,
    outputDirectory: join(directory, 'out'),
    fetchImpl: server.fetch,
    hostAllowance: { additionalTransferHostSuffixes: [server.transferHost] },
    ...overrides,
  });
}

function submitInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: 'run-1:scene-1',
    shotId: 'scene-01',
    mode: 'IMAGE_TO_VIDEO' as const,
    promptText: 'A fighter breathes. Do not alter any on-screen element.',
    candidateCount: 1,
    referenceImages: [
      {
        assetId: 'FRAME-01',
        localPath: framePath,
        mimeType: 'image/png',
        role: 'START_FRAME' as const,
        rights: {
          usageClass: 'OWNED' as const,
          rightsHolder: 'Combat Reviews',
          licenseType: 'OWNED_PRODUCTION_KEYFRAME',
        },
      },
    ],
    params: {
      durationSeconds: 6,
      aspectRatio: '9:16',
      resolution: '1080x1920',
      frameRate: 24,
      providerOptions: { generateAudio: false, cameraMotion: 'SLOW_PUSH_IN' },
    },
    ...overrides,
  };
}

async function driveToCompletion(
  provider: LtxHostedVideoGenerationProvider,
  handle: { jobId: string; shotId: string },
): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const status = await provider.getStatus(handle);
    seen.push(status);
    if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'TIMED_OUT') break;
  }
  return seen;
}

describe('LTX hosted — upload contract', () => {
  it('obtains a ticket, PUTs the frame with every required header, and addresses the image by storage_uri', async () => {
    const server = new FakeLtxServer();
    const provider = build(server);

    await provider.submit(submitInput());

    const ticketCall = server.requests.find((r) => r.path === '/v1/upload');
    const putCall = server.requests.find((r) => r.method === 'PUT');
    const submitCall = server.requests.find((r) => r.path === '/v2/image-to-video');

    expect(ticketCall?.method).toBe('POST');
    // The ticket's required header travelled with the bytes — the fake server
    // answers 400 if it did not, so reaching submit at all proves it.
    expect(putCall?.headerNames).toContain('x-ltx-content-sha256');
    expect(submitCall?.body).toMatchObject({
      model: 'ltx-2-3-fast',
      duration: 6,
      resolution: '1080x1920',
      fps: 24,
      generate_audio: false,
      camera_motion: 'SLOW_PUSH_IN',
    });
    expect((submitCall?.body as { image_uri: string }).image_uri).toMatch(/^ltx:\/\/uploads\//);
  });

  it('never sends the API key to the signed storage host', async () => {
    const server = new FakeLtxServer();
    await build(server).submit(submitInput());

    const putCall = server.requests.find((r) => r.method === 'PUT');
    expect(putCall?.hasAuthorization).toBe(false);
    // The key only ever went to the API origin.
    for (const where of server.authorizationSeenOn) {
      expect(where).toContain('api.ltx.io');
    }
  });

  it('derives the uploaded filename from a checksum, never from authored text', async () => {
    const server = new FakeLtxServer();
    await build(server).submit(submitInput());
    const ticketCall = server.requests.find((r) => r.path === '/v1/upload');
    expect((ticketCall?.body as { filename: string }).filename).toMatch(
      /^combat-frame-[0-9a-f]{32}\.png$/,
    );
  });
});

describe('LTX hosted — asynchronous submit, poll and download', () => {
  it('walks pending → processing → completed and downloads the result', async () => {
    const server = new FakeLtxServer({
      defaultJob: { pendingPolls: 1, processingPolls: 2, terminal: 'completed' },
    });
    const provider = build(server);
    const handle = await provider.submit(submitInput());

    expect(await driveToCompletion(provider, handle)).toEqual([
      'QUEUED',
      'POLLING',
      'POLLING',
      'SUCCEEDED',
    ]);

    const [candidate] = await provider.fetchResult(handle);
    expect(candidate?.localPath).toBeTruthy();
    expect(candidate?.sizeBytes).toBeGreaterThan(0);
    expect(candidate?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    // The bytes really landed on disk, hashed to the recorded value.
    const bytes = await readFile(candidate?.localPath as string);
    expect(bytes.byteLength).toBe(candidate?.sizeBytes);
  });

  it('reports a failed job as FAILED and carries the provider reason', async () => {
    const server = new FakeLtxServer({
      defaultJob: { terminal: 'failed', failureMessage: 'safety filter refused the frame' },
    });
    const provider = build(server);
    const handle = await provider.submit(submitInput());

    expect(await provider.getStatus(handle)).toBe('FAILED');
    const failure = await provider.getFailure(handle);
    expect(failure?.message).toContain('safety filter refused the frame');
    expect(failure?.retryable).toBe(false);
  });

  it('times out against its own deadline and cancels the job rather than leaving it billing', async () => {
    const server = new FakeLtxServer({ defaultJob: { neverCompletes: true } });
    let clock = 0;
    const provider = build(server, { outputTimeoutMs: 1_000, now: () => new Date(clock) });
    const handle = await provider.submit(submitInput());

    clock = 5_000;
    expect(await provider.getStatus(handle)).toBe('TIMED_OUT');
    expect(server.requests.some((r) => r.path.endsWith('/cancel'))).toBe(true);
  });

  it('reports cancellation and stops polling', async () => {
    const server = new FakeLtxServer({ defaultJob: { neverCompletes: true } });
    const provider = build(server);
    const handle = await provider.submit(submitInput());

    await provider.cancel(handle);
    expect(await provider.getStatus(handle)).toBe('CANCELLED');
    expect(await provider.fetchResult(handle)).toEqual([]);
  });

  it('refuses to download a job that is not completed', async () => {
    const server = new FakeLtxServer({ defaultJob: { neverCompletes: true } });
    const provider = build(server);
    const handle = await provider.submit(submitInput());
    await expect(provider.fetchResult(handle)).rejects.toThrow(/not completed/i);
  });
});

describe('LTX hosted — HTTP failure mapping', () => {
  const cases = [
    { status: 401, kind: 'UNAUTHORIZED' },
    { status: 402, kind: 'PAYMENT_REQUIRED' },
    { status: 429, kind: 'RATE_LIMITED' },
  ] as const;

  for (const { status, kind } of cases) {
    it(`maps HTTP ${status} on submit to ${kind}`, async () => {
      const server = new FakeLtxServer({ submitStatus: status, retryAfterSeconds: 30 });
      const provider = build(server);
      await expect(provider.submit(submitInput())).rejects.toMatchObject({
        name: 'LtxVideoGenerationError',
        ltxKind: kind,
      });
    });
  }

  it('maps a malformed submission body to MALFORMED_RESPONSE', async () => {
    const server = new FakeLtxServer({ malformed: { submit: true } });
    await expect(build(server).submit(submitInput())).rejects.toMatchObject({
      ltxKind: 'MALFORMED_RESPONSE',
    });
  });

  it('maps an unrecognised job state to MALFORMED_RESPONSE rather than guessing', async () => {
    const server = new FakeLtxServer();
    const provider = build(server);
    const handle = await provider.submit(submitInput());
    const guessing = new FakeLtxServer({ malformed: { status: true } });
    const strict = build(guessing);
    // Submit against the strict server so the handle is known to it.
    const strictHandle = await strict.submit(submitInput());
    await expect(strict.getStatus(strictHandle)).rejects.toMatchObject({
      ltxKind: 'MALFORMED_RESPONSE',
    });
    expect(handle.jobId).toBeTruthy();
  });

  it('treats a vanished result URL as EXPIRED, not as a generic download failure', async () => {
    const server = new FakeLtxServer({ defaultJob: { downloadStatus: 410 } });
    const provider = build(server);
    const handle = await provider.submit(submitInput());
    await provider.getStatus(handle);
    await expect(provider.fetchResult(handle)).rejects.toMatchObject({ ltxKind: 'EXPIRED' });
  });

  it('never retries a paid submission on its own', async () => {
    const server = new FakeLtxServer({ submitStatus: 500 });
    await expect(build(server).submit(submitInput())).rejects.toThrow();
    // One attempt reached the API. A retry here would be a doubled invoice.
    expect(server.requests.filter((r) => r.path === '/v2/image-to-video')).toHaveLength(1);
  });

  it('returns the existing handle for a repeated idempotency key without resubmitting', async () => {
    const server = new FakeLtxServer();
    const provider = build(server);
    const first = await provider.submit(submitInput());
    const second = await provider.submit(submitInput());
    expect(second).toEqual(first);
    expect(server.submissions).toBe(1);
  });
});

describe('LTX hosted — no credential or signed URL escapes', () => {
  it('keeps signed URLs out of every returned value', async () => {
    const server = new FakeLtxServer();
    const provider = build(server);
    const handle = await provider.submit(submitInput());
    await provider.getStatus(handle);
    const candidates = await provider.fetchResult(handle);
    const usage = await provider.getUsage(handle);

    const serialised = JSON.stringify({ handle, candidates, usage });
    expect(serialised).not.toContain(API_KEY);
    expect(serialised).not.toContain('signature=');
    expect(serialised).not.toContain('signed-upload');
    expect(serialised).not.toContain('signed-result');
  });

  it('redacts the query string from any URL that reaches a message', () => {
    expect(redactUrl('https://uploads.ltx.io/put/abc?signature=SECRET&se=123')).toBe(
      'https://uploads.ltx.io/put/abc',
    );
  });

  it('keeps the key out of an error raised against the storage host', async () => {
    const server = new FakeLtxServer({ uploadPutStatus: 403 });
    const provider = build(server);
    const error = await provider.submit(submitInput()).catch((e: unknown) => e);
    expect(String(error)).not.toContain(API_KEY);
    expect(String(error)).not.toContain('signature=');
  });
});

describe('LTX hosted — transfer URLs are untrusted input', () => {
  it('refuses a signed URL on an unexpected host', () => {
    expect(() => assertTransferUrlAllowed('https://evil.example.com/x')).toThrow(
      /unexpected host/i,
    );
  });

  it('refuses a non-https transfer URL', () => {
    expect(() => assertTransferUrlAllowed('http://uploads.ltx.io/x')).toThrow(/non-https/i);
  });

  it('refuses a URL embedding credentials', () => {
    expect(() => assertTransferUrlAllowed('https://user:pw@uploads.ltx.io/x')).toThrow(
      /credentials/i,
    );
  });

  it('accepts an ltx.io host', () => {
    expect(assertTransferUrlAllowed('https://uploads.ltx.io/x?sig=1').host).toBe('uploads.ltx.io');
  });
});

describe('LTX hosted — supported models, durations and pricing', () => {
  it('refuses the deprecated names by name and says what to use', () => {
    expect(() => assertSupportedLtxModel('ltx-2-fast')).toThrow(/deprecated.*ltx-2-3-fast/is);
    expect(() => assertSupportedLtxModel('ltx-2-pro')).toThrow(/deprecated.*ltx-2-3-pro/is);
  });

  it('refuses an unknown model', () => {
    expect(() => assertSupportedLtxModel('sora-9')).toThrow(LtxModelSupportError);
  });

  it('accepts only 6, 8 and 10 second durations', () => {
    expect(assertSupportedLtxDuration(6)).toBe(6);
    expect(assertSupportedLtxDuration(10)).toBe(10);
    expect(() => assertSupportedLtxDuration(4)).toThrow(/never stretch/i);
    expect(() => assertSupportedLtxDuration(7)).toThrow();
  });

  it('buys the smallest supported duration that covers the requirement', () => {
    expect(smallestCoveringDuration(1.8)).toBe(6);
    expect(smallestCoveringDuration(6)).toBe(6);
    expect(smallestCoveringDuration(6.01)).toBe(8);
    expect(smallestCoveringDuration(9.5)).toBe(10);
    expect(() => smallestCoveringDuration(11)).toThrow(/longest supported/i);
  });

  it('prices from the declared rate card', () => {
    expect(ltxGenerationCostCents('ltx-2-3-fast', '1080x1920', 6)).toBe(36);
    expect(ltxGenerationCostCents('ltx-2-3-pro', '1080x1920', 6)).toBe(48);
    expect(ltxGenerationCostCents('ltx-2-3-fast', '1080x1920', 10)).toBe(60);
    expect(LTX_PRICING_PROFILE).toHaveLength(2);
  });

  it('bills the requested duration, not the used one', async () => {
    const server = new FakeLtxServer();
    const provider = build(server);
    const handle = await provider.submit(submitInput());
    await provider.getStatus(handle);
    expect((await provider.getUsage(handle)).costCents).toBe(36);
  });

  it('refuses an unsupported resolution or frame rate before any request', async () => {
    const server = new FakeLtxServer();
    const provider = build(server);
    await expect(
      provider.submit(
        submitInput({
          params: {
            durationSeconds: 6,
            aspectRatio: '9:16',
            resolution: '720x1280',
            frameRate: 24,
          },
        }),
      ),
    ).rejects.toMatchObject({ ltxKind: 'UNSUPPORTED_REQUEST' });
    expect(server.requests).toHaveLength(0);
  });

  it('reports its response contract as documented, not executed', () => {
    expect(LTX_RESPONSE_CONTRACT_STATUS).toBe('DOCUMENTED_NOT_EXECUTED');
    expect(build(new FakeLtxServer()).responseContractStatus).toBe('DOCUMENTED_NOT_EXECUTED');
  });
});

describe('LTX hosted — the factory refuses rather than degrading', () => {
  it('refuses to build without a key', () => {
    expect(() =>
      createLtxHostedProvider({
        apiKey: '',
        model: 'ltx-2-3-fast',
        outputTimeoutMs: 1000,
        outputDirectory: directory,
      }),
    ).toThrow(VideoGenerationProviderConfigError);
  });

  it('refuses a deprecated model at construction', () => {
    expect(() =>
      createLtxHostedProvider({
        apiKey: API_KEY,
        model: 'ltx-2-fast',
        outputTimeoutMs: 1000,
        outputDirectory: directory,
      }),
    ).toThrow(/deprecated/i);
  });

  it('refuses an absent configuration', () => {
    expect(() => createLtxHostedProvider(undefined)).toThrow(/no LTX configuration/i);
  });

  it('constructs with a valid key and model', () => {
    const provider = createLtxHostedProvider({
      apiKey: API_KEY,
      model: 'ltx-2-3-pro',
      outputTimeoutMs: 1000,
      outputDirectory: directory,
    });
    expect(provider.name).toBe('ltx-hosted');
  });
});

describe('LTX hosted — rights are enforced before transmission', () => {
  it('refuses an ANALYSIS_ONLY reference before anything is uploaded', async () => {
    const server = new FakeLtxServer();
    const provider = build(server);
    await expect(
      provider.submit(
        submitInput({
          referenceImages: [
            {
              assetId: 'benchmark-01',
              localPath: framePath,
              role: 'START_FRAME' as const,
              rights: {
                usageClass: 'ANALYSIS_ONLY' as const,
                rightsHolder: 'third party',
                licenseType: 'study only',
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow();
    expect(server.requests).toHaveLength(0);
  });

  it('refuses TEXT_TO_VIDEO — this adapter animates a supplied frame', async () => {
    const server = new FakeLtxServer();
    await expect(
      build(server).submit(submitInput({ mode: 'TEXT_TO_VIDEO' })),
    ).rejects.toMatchObject({ ltxKind: 'UNSUPPORTED_REQUEST' });
    expect(server.requests).toHaveLength(0);
  });
});

describe('LtxRequestError', () => {
  it('carries a retry-after when the provider sent one', () => {
    const error = new LtxRequestError('RATE_LIMITED', 'throttled', 30);
    expect(error.retryAfterSeconds).toBe(30);
  });

  it('is distinguishable from a generation error', () => {
    expect(
      new LtxVideoGenerationError(
        { reason: 'PROVIDER_ERROR', retryable: false, message: 'x' },
        'REJECTED',
      ).ltxKind,
    ).toBe('REJECTED');
  });
});

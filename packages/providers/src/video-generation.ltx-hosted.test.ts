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
import {
  assertTransferUrlAllowed,
  LtxRequestError,
  redactUrl,
  LTX_ALLOWED_RESULT_HOSTS,
  LTX_ALLOWED_UPLOAD_HOSTS,
} from './ltx/http-client';
import {
  toLtxCameraMotion,
  LtxCameraMotionError,
  LTX_CAMERA_MOTIONS,
  LTX_CAMERA_MOTION_MAP,
} from './ltx/camera-motion';
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
      // The internal name never reaches the wire; the boundary translated it.
      camera_motion: 'dolly_in',
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
    expect(() => assertTransferUrlAllowed('https://evil.example.com/x', 'RESULT')).toThrow(
      /unexpected host/i,
    );
  });

  it('refuses a non-https transfer URL', () => {
    expect(() => assertTransferUrlAllowed('http://uploads.ltx.io/x', 'RESULT')).toThrow(
      /non-https/i,
    );
  });

  it('refuses a URL embedding credentials', () => {
    expect(() => assertTransferUrlAllowed('https://user:pw@uploads.ltx.io/x', 'RESULT')).toThrow(
      /credentials/i,
    );
  });

  it('accepts an ltx.io host', () => {
    expect(assertTransferUrlAllowed('https://uploads.ltx.io/x?sig=1', 'RESULT').host).toBe(
      'uploads.ltx.io',
    );
  });
});

/**
 * The one host outside `*.ltx.io` this client may upload to.
 *
 * The live `POST /v1/upload` signs its PUT target to Google Cloud Storage. That
 * exact hostname is authorised for uploads and nothing else is — so the tests
 * that matter most here are the ones that must still fail.
 */
describe('LTX hosted — the authorised signed-upload host', () => {
  const UPLOAD = 'UPLOAD' as const;

  it('accepts exactly https://storage.googleapis.com for an upload', () => {
    const url = assertTransferUrlAllowed(
      'https://storage.googleapis.com/bucket/object?X-Goog-Signature=abc',
      UPLOAD,
    );
    expect(url.host).toBe('storage.googleapis.com');
  });

  it('refuses it over http', () => {
    expect(() =>
      assertTransferUrlAllowed('http://storage.googleapis.com/bucket/object', UPLOAD),
    ).toThrow(/non-https/i);
  });

  it('refuses a suffixed lookalike', () => {
    expect(() =>
      assertTransferUrlAllowed('https://storage.googleapis.com.example.com/x', UPLOAD),
    ).toThrow(/unexpected host/i);
  });

  it('refuses a subdomain of the authorised host', () => {
    expect(() =>
      assertTransferUrlAllowed('https://attacker.storage.googleapis.com/x', UPLOAD),
    ).toThrow(/unexpected host/i);
  });

  it('refuses a hyphenated lookalike', () => {
    expect(() => assertTransferUrlAllowed('https://storage-googleapis.com/x', UPLOAD)).toThrow(
      /unexpected host/i,
    );
  });

  it('refuses any other Google host — there is no wildcard', () => {
    for (const host of [
      'https://googleapis.com/x',
      'https://www.googleapis.com/x',
      'https://storage.cloud.google.com/x',
      'https://storage.googleapis.evil.com/x',
    ]) {
      expect(() => assertTransferUrlAllowed(host, UPLOAD)).toThrow(/unexpected host/i);
    }
  });

  it('grants each purpose from its own list, never implicitly from the other', () => {
    // The two lists happen to hold the same host today. What is being proven is
    // that the *grants* are separate: neither purpose is served by the other's
    // list, and there is no default purpose that could quietly serve both.
    expect(LTX_ALLOWED_UPLOAD_HOSTS).toEqual(['storage.googleapis.com']);
    expect(LTX_ALLOWED_RESULT_HOSTS).toEqual(['storage.googleapis.com']);
    expect(LTX_ALLOWED_UPLOAD_HOSTS).not.toBe(LTX_ALLOWED_RESULT_HOSTS);

    // A caller must say which operation it is performing. There is no arity
    // that omits the purpose, so an unrelated transfer cannot inherit a grant.
    expect(assertTransferUrlAllowed.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a redirect away from the upload target rather than following it', async () => {
    const server = new FakeLtxServer({ uploadPutStatus: 307 });
    const provider = build(server);
    const error = await provider.submit(submitInput()).catch((e: unknown) => e);
    expect(String(error)).toMatch(/redirect/i);
    expect(String(error)).toMatch(/refused rather than followed/i);
    // The bytes never reached a second host.
    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('never lets the signed URL or its query reach a message', async () => {
    const server = new FakeLtxServer({ uploadPutStatus: 500 });
    const provider = build(server);
    const error = await provider.submit(submitInput()).catch((e: unknown) => e);
    const text = String(error);
    expect(text).not.toContain('?');
    expect(text).not.toContain('signature');
    expect(text).not.toContain('X-Goog-Signature');
    expect(text).not.toContain(API_KEY);
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

/**
 * The camera-motion serialization boundary.
 *
 * AAMP's vocabulary is provider-neutral and stays whole; this is the one place
 * it is translated into the eight values the live API supplied in its own 400
 * response. The tests that matter most are the refusals: a nearest-looking
 * substitute is a different shot from the one the storyboard approved.
 */
describe('LTX hosted — camera motion is serialized, never leaked or substituted', () => {
  it('serializes SLOW_PUSH_IN as exactly dolly_in', () => {
    expect(toLtxCameraMotion('SLOW_PUSH_IN')).toBe('dolly_in');
  });

  it('maps every supported internal value to an official LTX value', () => {
    expect([...LTX_CAMERA_MOTION_MAP.entries()]).toEqual([
      ['STATIC', 'static'],
      ['SLOW_PUSH_IN', 'dolly_in'],
      ['SLOW_PULL_OUT', 'dolly_out'],
      ['LATERAL_TRACK_LEFT', 'dolly_left'],
      ['LATERAL_TRACK_RIGHT', 'dolly_right'],
    ]);
    for (const [internal, wire] of LTX_CAMERA_MOTION_MAP) {
      expect(LTX_CAMERA_MOTIONS).toContain(wire);
      expect(toLtxCameraMotion(internal)).toBe(wire);
      // No internal enum name may ever be a legal wire value.
      expect(LTX_CAMERA_MOTIONS).not.toContain(internal as never);
    }
  });

  it('passes an already-official value through unchanged', () => {
    for (const wire of LTX_CAMERA_MOTIONS) expect(toLtxCameraMotion(wire)).toBe(wire);
  });

  it('refuses every internal value with no defensible equivalent, by name', () => {
    for (const internal of ['HANDHELD_DRIFT', 'ORBIT_LEFT', 'ORBIT_RIGHT']) {
      let caught: unknown = null;
      try {
        toLtxCameraMotion(internal);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LtxCameraMotionError);
      const typed = caught as LtxCameraMotionError;
      expect(typed.kind).toBe('UNSUPPORTED_PROVIDER_CAMERA_MOTION');
      expect(typed.providerName).toBe('ltx-hosted');
      expect(typed.requestedCameraMotion).toBe(internal);
      expect(typed.message).toContain(internal);
    }
  });

  it('refuses a tilt rather than substituting a jib — they are different moves', () => {
    for (const internal of ['TILT_UP', 'TILT_DOWN']) {
      expect(() => toLtxCameraMotion(internal)).toThrow(LtxCameraMotionError);
      expect(() => toLtxCameraMotion(internal)).toThrow(/different moves/i);
    }
    // And the substitution is genuinely absent, not merely discouraged.
    expect([...LTX_CAMERA_MOTION_MAP.values()]).not.toContain('jib_up');
    expect([...LTX_CAMERA_MOTION_MAP.values()]).not.toContain('jib_down');
  });

  it('refuses CRANE_DOWN, which no internal contract defines', () => {
    expect(() => toLtxCameraMotion('CRANE_DOWN')).toThrow(LtxCameraMotionError);
    expect(LTX_CAMERA_MOTION_MAP.has('CRANE_DOWN')).toBe(false);
  });

  it('never substitutes static and never silently omits the field', () => {
    for (const internal of ['HANDHELD_DRIFT', 'ORBIT_LEFT', 'TILT_UP', 'CRANE_DOWN', '']) {
      expect(() => toLtxCameraMotion(internal)).toThrow();
    }
    expect(() => toLtxCameraMotion('HANDHELD_DRIFT')).toThrow(/refused rather than omitted/i);
  });

  it('refuses before any network access — nothing is uploaded and no job is created', async () => {
    const server = new FakeLtxServer();
    const provider = build(server);
    const error = await provider
      .submit(
        submitInput({
          params: {
            durationSeconds: 6,
            aspectRatio: '9:16',
            resolution: '1080x1920',
            frameRate: 24,
            providerOptions: { generateAudio: false, cameraMotion: 'ORBIT_LEFT' },
          },
        }),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LtxVideoGenerationError);
    expect((error as LtxVideoGenerationError).ltxKind).toBe('UNSUPPORTED_PROVIDER_CAMERA_MOTION');
    expect(String(error)).toContain('ORBIT_LEFT');
    expect(String(error)).toContain('ltx-hosted');
    // The decisive assertion: not one request left this process.
    expect(server.requests).toHaveLength(0);
    expect(server.submissions).toBe(0);
  });

  it('puts no internal enum name anywhere in the outgoing JSON', async () => {
    const server = new FakeLtxServer();
    await build(server).submit(submitInput());

    const wire = JSON.stringify(server.requests.map((request) => request.body));
    for (const internal of [
      'STATIC',
      'SLOW_PUSH_IN',
      'SLOW_PULL_OUT',
      'HANDHELD_DRIFT',
      'LATERAL_TRACK_LEFT',
      'LATERAL_TRACK_RIGHT',
      'TILT_UP',
      'TILT_DOWN',
      'ORBIT_LEFT',
      'ORBIT_RIGHT',
    ]) {
      expect(wire).not.toContain(internal);
    }
  });

  it('sends the Scene-1 body the live contract expects, and no invented field', async () => {
    const server = new FakeLtxServer();
    await build(server).submit(submitInput());
    const body = server.requests.find((r) => r.path === '/v2/image-to-video')?.body as Record<
      string,
      unknown
    >;

    expect(Object.keys(body).sort()).toEqual(
      [
        'camera_motion',
        'duration',
        'fps',
        'generate_audio',
        'image_uri',
        'model',
        'prompt',
        'resolution',
      ].sort(),
    );
    expect(body.model).toBe('ltx-2-3-fast');
    expect(body.duration).toBe(6);
    expect(body.resolution).toBe('1080x1920');
    expect(body.fps).toBe(24);
    expect(body.generate_audio).toBe(false);
    expect(body.camera_motion).toBe('dolly_in');
    // No speed, strength or intensity field is invented to carry "slow".
    for (const invented of ['speed', 'strength', 'intensity', 'motion_strength', 'camera_speed']) {
      expect(body[invented]).toBeUndefined();
    }
  });
});

/**
 * The result download, authorised separately from the upload.
 */
describe('LTX hosted — the authorised result-download host', () => {
  const RESULT = 'RESULT' as const;

  it('accepts exactly https://storage.googleapis.com for a result', () => {
    expect(
      assertTransferUrlAllowed(
        'https://storage.googleapis.com/bucket/out.mp4?X-Goog-Signature=abc',
        RESULT,
      ).host,
    ).toBe('storage.googleapis.com');
  });

  it('refuses it over http', () => {
    expect(() =>
      assertTransferUrlAllowed('http://storage.googleapis.com/bucket/out.mp4', RESULT),
    ).toThrow(/non-https/i);
  });

  it('refuses lookalikes and subdomains', () => {
    for (const host of [
      'https://storage.googleapis.com.example.com/x',
      'https://attacker.storage.googleapis.com/x',
      'https://storage-googleapis.com/x',
      'https://www.googleapis.com/x',
      'https://storage.cloud.google.com/x',
    ]) {
      expect(() => assertTransferUrlAllowed(host, RESULT)).toThrow(/unexpected host/i);
    }
  });

  it('downloads a completed result from the authorised host and hashes the bytes', async () => {
    const payload = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 9, 9, 9]);
    const server = new FakeLtxServer({
      transferHost: 'storage.googleapis.com',
      defaultJob: { videoBytes: payload },
    });
    // No `additionalTransferHostSuffixes`: the host passes on the RESULT
    // allowance alone, which is the property under test.
    const provider = build(server, { hostAllowance: {} });
    const handle = await provider.submit(submitInput());
    await provider.getStatus(handle);

    const [candidate] = await provider.fetchResult(handle);
    expect(candidate?.sizeBytes).toBe(payload.byteLength);
    expect(candidate?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    const bytes = await readFile(candidate?.localPath as string);
    expect(new Uint8Array(bytes)).toEqual(payload);
  });

  it('refuses a redirect on the result rather than following it', async () => {
    const server = new FakeLtxServer({
      transferHost: 'storage.googleapis.com',
      defaultJob: { downloadStatus: 302 },
    });
    const provider = build(server, { hostAllowance: {} });
    const handle = await provider.submit(submitInput());
    await provider.getStatus(handle);

    const error = await provider.fetchResult(handle).catch((e: unknown) => e);
    expect(String(error)).toMatch(/redirect/i);
    expect(String(error)).toMatch(/refused rather than followed/i);
  });

  it('keeps the signed result URL and its query out of every message', async () => {
    const server = new FakeLtxServer({
      transferHost: 'storage.googleapis.com',
      defaultJob: { downloadStatus: 500 },
    });
    const provider = build(server, { hostAllowance: {} });
    const handle = await provider.submit(submitInput());
    await provider.getStatus(handle);

    const error = await provider.fetchResult(handle).catch((e: unknown) => e);
    const text = String(error);
    expect(text).not.toContain('?');
    expect(text).not.toContain('signature');
    expect(text).not.toContain(API_KEY);
  });

  it('exposes no signed URL on the candidate it returns', async () => {
    const server = new FakeLtxServer({ transferHost: 'storage.googleapis.com' });
    const provider = build(server, { hostAllowance: {} });
    const handle = await provider.submit(submitInput());
    await provider.getStatus(handle);

    const [candidate] = await provider.fetchResult(handle);
    const serialised = JSON.stringify(candidate);
    expect(serialised).not.toContain('signature');
    expect(serialised).not.toContain('storage.googleapis.com');
    expect(serialised).not.toContain(API_KEY);
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeCommandRunner, okResult } from '../test-helpers/fake-command-runner';
import type { RenderManifest, RenderSource } from './manifest';
import { SourceFileError } from './paths';
import {
  assertLicensedForOutput,
  LicenseExpiredError,
  resolveManifestSources,
  SourceChecksumMismatchError,
  SourceKindMismatchError,
  SourceNotLicensedForOutputError,
} from './source-resolution';

const AS_OF = new Date('2026-07-26T00:00:00.000Z');

let root: string;

const VIDEO_PROBE = JSON.stringify({
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30/1',
      nb_frames: '180',
    },
  ],
  format: { format_name: 'mov,mp4', duration: '6.000000' },
});

function videoSource(overrides: Partial<RenderSource> = {}): RenderSource {
  return {
    id: 'clip',
    kind: 'VIDEO',
    path: 'clip.mp4',
    description: 'a licensed clip',
    license: {
      usageClass: 'LICENSED_FOR_OUTPUT',
      rightsHolder: 'Rights Co',
      licenseType: 'ROYALTY_FREE',
      restrictions: [],
    },
    ...overrides,
  } as RenderSource;
}

function manifestWith(sources: readonly RenderSource[]): RenderManifest {
  return { sources } as unknown as RenderManifest;
}

function runnerReturningVideoProbe(): FakeCommandRunner {
  const runner = new FakeCommandRunner();
  runner.setResult('ffprobe', okResult(VIDEO_PROBE));
  return runner;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'combat-sources-'));
  await writeFile(join(root, 'clip.mp4'), 'not really an mp4, but non-empty');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const options = (): Parameters<typeof resolveManifestSources>[2] => ({
  baseDir: root,
  allowedRoots: [root],
  asOf: AS_OF,
});

describe('licensing gate — the only way a file reaches the renderer', () => {
  it('rejects an ANALYSIS_ONLY reference, which is the class every Creative Memory source carries', async () => {
    const runner = runnerReturningVideoProbe();
    await expect(
      resolveManifestSources(
        runner,
        manifestWith([
          videoSource({
            license: {
              usageClass: 'ANALYSIS_ONLY',
              rightsHolder: 'Someone Else',
              licenseType: 'LIMITED_USAGE',
              restrictions: [],
            },
          }),
        ]),
        options(),
      ),
    ).rejects.toThrow(SourceNotLicensedForOutputError);
  });

  it('refuses ANALYSIS_ONLY before touching the filesystem or invoking ffprobe', async () => {
    const runner = runnerReturningVideoProbe();
    await expect(
      resolveManifestSources(
        runner,
        manifestWith([
          videoSource({
            // A path that does not exist: if the licensing gate ran second,
            // the error would be about the missing file instead.
            path: 'does-not-exist.mp4',
            license: {
              usageClass: 'ANALYSIS_ONLY',
              rightsHolder: 'Someone Else',
              licenseType: 'LIMITED_USAGE',
              restrictions: [],
            },
          }),
        ]),
        options(),
      ),
    ).rejects.toThrow(SourceNotLicensedForOutputError);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects a licence that has already expired', async () => {
    const runner = runnerReturningVideoProbe();
    await expect(
      resolveManifestSources(
        runner,
        manifestWith([
          videoSource({
            license: {
              usageClass: 'LICENSED_FOR_OUTPUT',
              rightsHolder: 'Rights Co',
              licenseType: 'LIMITED_USAGE',
              expiresAt: '2026-07-25T00:00:00.000Z',
              restrictions: [],
            },
          }),
        ]),
        options(),
      ),
    ).rejects.toThrow(LicenseExpiredError);
  });

  it('accepts a licence that expires in the future, and an OWNED source with no expiry', () => {
    expect(() =>
      assertLicensedForOutput(
        videoSource({
          license: {
            usageClass: 'LICENSED_FOR_OUTPUT',
            rightsHolder: 'Rights Co',
            licenseType: 'LIMITED_USAGE',
            expiresAt: '2099-01-01T00:00:00.000Z',
            restrictions: [],
          },
        }),
        AS_OF,
      ),
    ).not.toThrow();

    expect(() =>
      assertLicensedForOutput(
        videoSource({
          license: {
            usageClass: 'OWNED',
            rightsHolder: 'Combat Reviews',
            licenseType: 'FULL_RIGHTS',
            restrictions: [],
          },
        }),
        AS_OF,
      ),
    ).not.toThrow();
  });

  it('treats an unparseable expiry as expired rather than as perpetual', () => {
    expect(() =>
      assertLicensedForOutput(
        videoSource({
          license: {
            usageClass: 'OWNED',
            rightsHolder: 'Combat Reviews',
            licenseType: 'FULL_RIGHTS',
            expiresAt: 'whenever',
            restrictions: [],
          },
        }),
        AS_OF,
      ),
    ).toThrow(LicenseExpiredError);
  });
});

describe('source resolution', () => {
  it('rejects a missing source file with a typed error, not an FFmpeg exit code', async () => {
    const runner = runnerReturningVideoProbe();
    await expect(
      resolveManifestSources(
        runner,
        manifestWith([videoSource({ path: 'absent.mp4' })]),
        options(),
      ),
    ).rejects.toThrow(SourceFileError);
  });

  it('rejects a zero-byte source file', async () => {
    await writeFile(join(root, 'empty.mp4'), '');
    const runner = runnerReturningVideoProbe();
    await expect(
      resolveManifestSources(runner, manifestWith([videoSource({ path: 'empty.mp4' })]), options()),
    ).rejects.toThrow(/zero bytes/);
  });

  it('rejects a source whose bytes do not match the declared checksum', async () => {
    const runner = runnerReturningVideoProbe();
    await expect(
      resolveManifestSources(
        runner,
        manifestWith([videoSource({ expectedChecksum: 'a'.repeat(64) })]),
        options(),
      ),
    ).rejects.toThrow(SourceChecksumMismatchError);
  });

  it('rejects a source declared VIDEO that probes as something else', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult(
      'ffprobe',
      okResult(
        JSON.stringify({
          streams: [{ codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }],
          format: { format_name: 'wav', duration: '6.0' },
        }),
      ),
    );
    await expect(
      resolveManifestSources(runner, manifestWith([videoSource()]), options()),
    ).rejects.toThrow(SourceKindMismatchError);
  });

  it('rejects malformed source media — ffprobe failing is a resolution failure, not a render failure', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', {
      stdout: '',
      stderr: 'moov atom not found',
      exitCode: 1,
      stderrTruncated: false,
    });
    await expect(
      resolveManifestSources(runner, manifestWith([videoSource()]), options()),
    ).rejects.toThrow(/moov atom not found/);
  });

  it('returns the checksum, size and probe every provenance record needs', async () => {
    const runner = runnerReturningVideoProbe();
    const resolved = await resolveManifestSources(runner, manifestWith([videoSource()]), options());
    const clip = resolved.get('clip');
    expect(clip).toBeDefined();
    expect(clip?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(clip?.sizeBytes).toBeGreaterThan(0);
    expect(clip?.probe.mediaType).toBe('VIDEO');
    expect(clip?.license.rightsHolder).toBe('Rights Co');
    expect(clip?.absolutePath).toBe(join(root, 'clip.mp4'));
  });

  it('invokes the configured ffprobe binary, passing the file path as its own argv element', async () => {
    const configuredBinary = 'C:\\tools\\ffprobe.exe';
    const runner = new FakeCommandRunner();
    runner.setResult(configuredBinary, okResult(VIDEO_PROBE));

    await resolveManifestSources(runner, manifestWith([videoSource()]), {
      ...options(),
      ffprobePath: configuredBinary,
    });

    const call = runner.callsTo(configuredBinary)[0];
    expect(call).toBeDefined();
    expect(call?.args).toContain(join(root, 'clip.mp4'));
    // Never one interpolated string.
    expect(call?.args.some((arg) => arg.includes(' -'))).toBe(false);
  });
});

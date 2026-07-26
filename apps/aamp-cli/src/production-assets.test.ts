import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandResult, CommandRunner } from '@combat/media';

import { AssetResolutionError, resolveProductionAssets } from './asset-resolution';
import {
  parseProductionAssetManifest,
  permitsOutput,
  ProductionAssetManifestError,
} from './production-assets';

const NOW = new Date('2026-07-27T00:00:00Z');

const LOGO = {
  id: 'logo-primary',
  path: './logo.png',
  kind: 'IMAGE',
  role: 'LOGO',
  description: 'Combat Reviews logo',
  rights: { classification: 'OWNED', owner: 'Combat Reviews', permittedOutputUse: true },
};

const manifestWith = (assets: unknown[]) => ({
  manifestVersion: 1,
  library: 'test library',
  assets,
});

describe('rights classification', () => {
  it('permits exactly the three output classes', () => {
    expect(['OWNED', 'COMMISSIONED', 'LICENSED_FOR_OUTPUT'].every(permitsOutput as never)).toBe(
      true,
    );
    expect(permitsOutput('ANALYSIS_ONLY')).toBe(false);
    expect(permitsOutput('UNKNOWN_RIGHTS')).toBe(false);
  });

  it('refuses an ANALYSIS_ONLY asset at parse time, naming why', () => {
    expect(() =>
      parseProductionAssetManifest(
        manifestWith([
          LOGO,
          {
            ...LOGO,
            id: 'benchmark',
            role: 'SOURCE_CLIP',
            kind: 'VIDEO',
            rights: {
              classification: 'ANALYSIS_ONLY',
              owner: 'Some agency',
              permittedOutputUse: true,
            },
          },
        ]),
      ),
    ).toThrow(/must never enter a production asset manifest/);
  });

  it('refuses UNKNOWN_RIGHTS rather than assuming permission', () => {
    expect(() =>
      parseProductionAssetManifest(
        manifestWith([
          LOGO,
          {
            ...LOGO,
            id: 'mystery',
            rights: {
              classification: 'UNKNOWN_RIGHTS',
              owner: 'unclear',
              permittedOutputUse: true,
            },
          },
        ]),
      ),
    ).toThrow(/establish and record the rights/);
  });

  it('refuses an asset whose owner withheld output use', () => {
    expect(() =>
      parseProductionAssetManifest(
        manifestWith([
          LOGO,
          {
            ...LOGO,
            id: 'internal-only',
            rights: {
              classification: 'LICENSED_FOR_OUTPUT',
              owner: 'Stock house',
              permittedOutputUse: false,
            },
          },
        ]),
      ),
    ).toThrow(/may not contribute bytes to an output/);
  });

  it('requires a logo and rejects role/kind mismatches', () => {
    expect(() =>
      parseProductionAssetManifest(manifestWith([{ ...LOGO, role: 'SOURCE_CLIP' }])),
    ).toThrow(ProductionAssetManifestError);
  });
});

describe('asset resolution against real files', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'aamp-assets-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** ffprobe stand-in: reports a 1080x1920 still for anything it is asked about. */
  const imageRunner = (): CommandRunner => ({
    async run(): Promise<CommandResult> {
      return {
        stdout: JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'png', width: 1080, height: 1920 }],
          format: { format_name: 'png_pipe' },
        }),
        stderr: '',
        exitCode: 0,
      };
    },
  });

  const write = async (name: string, content = 'not really a png but non-empty') => {
    await writeFile(join(directory, name), content, 'utf8');
  };

  const resolveWith = async (assets: unknown[], now = NOW) =>
    resolveProductionAssets({
      manifest: parseProductionAssetManifest(manifestWith(assets)),
      manifestDir: directory,
      allowedRoots: [directory],
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      now,
      runner: imageRunner(),
    });

  it('resolves a present, in-scope, correctly-typed asset', async () => {
    await write('logo.png');
    const resolved = await resolveWith([LOGO]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved[0]!.measuredWidthPx).toBe(1080);
  });

  it('refuses a missing file', async () => {
    await expect(resolveWith([LOGO])).rejects.toThrow(/FILE_MISSING/);
  });

  it('refuses an expired licence', async () => {
    await write('logo.png');
    await expect(
      resolveWith([
        {
          ...LOGO,
          rights: {
            classification: 'LICENSED_FOR_OUTPUT',
            owner: 'Stock house',
            permittedOutputUse: true,
            expiresAt: '2026-07-26T00:00:00Z',
          },
        },
      ]),
    ).rejects.toThrow(/LICENCE_EXPIRED/);
  });

  it('accepts a licence that has not yet expired', async () => {
    await write('logo.png');
    const resolved = await resolveWith([
      {
        ...LOGO,
        rights: {
          classification: 'LICENSED_FOR_OUTPUT',
          owner: 'Stock house',
          permittedOutputUse: true,
          expiresAt: '2027-01-01T00:00:00Z',
        },
      },
    ]);
    expect(resolved).toHaveLength(1);
  });

  it('refuses a path that escapes the allowed roots', async () => {
    await write('logo.png');
    await expect(
      resolveProductionAssets({
        manifest: parseProductionAssetManifest(manifestWith([{ ...LOGO, path: '../outside.png' }])),
        manifestDir: directory,
        allowedRoots: [directory],
        binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
        now: NOW,
        runner: imageRunner(),
      }),
    ).rejects.toThrow(/UNSAFE_PATH/);
  });

  it('refuses a checksum mismatch rather than rendering the wrong file', async () => {
    await write('logo.png');
    await expect(resolveWith([{ ...LOGO, checksumSha256: 'a'.repeat(64) }])).rejects.toThrow(
      /CHECKSUM_MISMATCH/,
    );
  });

  it('refuses a file that decodes as a different kind than declared', async () => {
    await write('logo.png');
    await write('bed.wav');
    // The logo stays so the manifest itself is valid; the music entry is the
    // one that lies about its kind, and the probe catches it.
    await expect(
      resolveWith([
        LOGO,
        {
          ...LOGO,
          id: 'music-bed',
          path: './bed.wav',
          kind: 'AUDIO',
          role: 'MUSIC',
          description: 'claims to be audio but decodes as a still',
        },
      ]),
    ).rejects.toThrow(/KIND_MISMATCH/);
  });

  it('reports every rejection at once, not just the first', async () => {
    try {
      await resolveWith([LOGO, { ...LOGO, id: 'second', path: './missing-too.png' }]);
      expect.unreachable('expected resolution to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AssetResolutionError);
      expect((error as AssetResolutionError).rejections).toHaveLength(2);
    }
  });

  it('records a declared-versus-measured discrepancy without failing', async () => {
    await write('logo.png');
    const resolved = await resolveWith([{ ...LOGO, declaredWidthPx: 720 }]);
    expect(resolved[0]!.discrepancies[0]).toContain('declared 720px wide but measured 1080px');
  });
});

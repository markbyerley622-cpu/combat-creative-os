import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NodeCommandRunner, resolveFfmpegBinaries } from '@combat/media';

import { parseProductionAssetManifest, type ProductionAssetManifest } from '../production-assets';
import { AssetRootPreflightError, runAssetRootPreflight } from './asset-root-preflight';

/**
 * The preflight exists because the library is *outside* the repository, which
 * makes every path in it operator-supplied. So the cases worth testing are the
 * ones where an operator-supplied path is not what it appears to be: a link out
 * of the root, the same bytes under two ids, a reference file dressed up as
 * production material, media that does not decode.
 *
 * Real files and real ffprobe throughout — a fake filesystem cannot have a
 * symlink that escapes, and a fake prober cannot tell a PNG from an MP4.
 */

const binaries = resolveFfmpegBinaries(process.env);

function ffmpegAvailable(): boolean {
  return spawnSync(binaries.ffprobe, ['-version'], { timeout: 15_000 }).status === 0;
}

const available = ffmpegAvailable();
const suite = available ? describe : describe.skip;

if (!available) {
  // eslint-disable-next-line no-console -- a silently skipped preflight test is worse than a noisy one
  console.warn(
    `[preflight] SKIPPED: ffprobe not runnable at "${binaries.ffprobe}". Set FFMPEG_PATH/FFPROBE_PATH to run the asset-root preflight tests.`,
  );
}

const OWNED = {
  classification: 'OWNED' as const,
  owner: 'Combat Reviews',
  permittedOutputUse: true,
  restrictions: [],
};

suite('external asset-root preflight', () => {
  let root: string;
  let outside: string;
  const runner = new NodeCommandRunner();

  async function makeVideo(target: string, seconds: number, size = '1280x720'): Promise<void> {
    await mkdir(join(target, '..'), { recursive: true }).catch(() => undefined);
    const result = await runner.run(
      binaries.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=30:duration=${seconds}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=300:duration=${seconds}:sample_rate=48000`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-y',
        target,
      ],
      { timeoutMs: 120_000 },
    );
    if (result.exitCode !== 0) throw new Error(`could not build ${target}: ${result.stderr}`);
  }

  async function makeImage(target: string, size = '1080x1920'): Promise<void> {
    const result = await runner.run(
      binaries.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=0x223344:s=${size}:d=1`,
        '-frames:v',
        '1',
        '-y',
        target,
      ],
      { timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) throw new Error(`could not build ${target}: ${result.stderr}`);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'asset-root-'));
    outside = await mkdtemp(join(tmpdir(), 'outside-root-'));
    for (const directory of ['brand', 'app-ui', 'combat-clips', 'audio', 'references']) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await makeImage(join(root, 'brand', 'logo.png'), '560x168');
    await makeImage(join(root, 'app-ui', 'screen.png'));
    await makeVideo(join(root, 'combat-clips', 'session.mp4'), 8);
    await makeVideo(join(root, 'combat-clips', 'short.mp4'), 1);
    await makeVideo(join(root, 'references', 'benchmark.mp4'), 2);
    await makeVideo(join(outside, 'not-ours.mp4'), 3);
    // A copy of an existing clip, so duplicate-by-content has something real.
    await makeImage(join(root, 'app-ui', 'other-screen.png'), '1080x1921');
    await copyFile(
      join(root, 'combat-clips', 'session.mp4'),
      join(root, 'combat-clips', 'copy.mp4'),
    );
    // A real MP4 truncated mid-header: recognisably an MP4, and undecodable.
    // Random bytes are not enough — ffprobe guesses a codec for those, which
    // is a different (and also correct) refusal.
    const whole = await readFile(join(root, 'combat-clips', 'session.mp4'));
    await writeFile(join(root, 'combat-clips', 'corrupt.mp4'), whole.subarray(0, 180));
  }, 300_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(outside, { recursive: true, force: true }).catch(() => undefined);
  });

  function manifestWith(assets: readonly Record<string, unknown>[] = []): ProductionAssetManifest {
    return parseProductionAssetManifest({
      manifestVersion: 1,
      library: 'test',
      assets: [
        {
          id: 'logo',
          path: 'brand/logo.png',
          kind: 'IMAGE',
          role: 'LOGO',
          description: 'logo',
          rights: OWNED,
        },
        {
          id: 'screen',
          path: 'app-ui/screen.png',
          kind: 'IMAGE',
          role: 'APP_SCREENSHOT',
          description: 'screen',
          rights: OWNED,
        },
        {
          id: 'session',
          path: 'combat-clips/session.mp4',
          kind: 'VIDEO',
          role: 'SOURCE_CLIP',
          description: 'session',
          rights: OWNED,
        },
        ...assets,
      ],
    });
  }

  const preflight = (manifest: ProductionAssetManifest, shortestBeatSeconds = 3) =>
    runAssetRootPreflight({
      manifest,
      manifestDir: root,
      assetRoot: root,
      binaries,
      now: new Date('2026-07-27T00:00:00Z'),
      runner,
      shortestBeatSeconds,
    });

  it('accepts a well-formed library and reports what it found', async () => {
    const report = await preflight(manifestWith());
    expect(report.assets).toHaveLength(3);
    expect(report.outputEligibleCount).toBe(3);
    expect(report.directoriesPresent).toContain('combat-clips');
    expect(report.directoriesPresent).toContain('references');
    // Measurements come from the file, not from the manifest.
    const session = report.assets.find((asset) => asset.assetId === 'session');
    expect(session?.measuredDurationSeconds).toBeGreaterThan(7);
    expect(session?.measuredVideoCodec).toBe('h264');
    expect(session?.hasAudio).toBe(true);
    expect(session?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    // Paths in the report are relative to the root, so nothing about this
    // machine travels with it.
    expect(session?.relativePath).toBe('combat-clips/session.mp4');
  }, 120_000);

  it('counts the analysis-only references without resolving any of them', async () => {
    const report = await preflight(manifestWith());
    expect(report.analysisOnlyReferenceCount).toBeGreaterThan(0);
    expect(report.assets.some((asset) => asset.directory === 'references')).toBe(false);
  }, 120_000);

  it('refuses a path that resolves outside the asset root', async () => {
    const manifest = manifestWith([
      {
        id: 'escape',
        path: join(outside, 'not-ours.mp4'),
        kind: 'VIDEO',
        role: 'SOURCE_CLIP',
        description: 'outside',
        rights: OWNED,
      },
    ]);
    await expect(preflight(manifest)).rejects.toThrow(/PATH_ESCAPES_ASSET_ROOT/);
  }, 120_000);

  it('refuses a symlink inside the root that points outside it', async () => {
    const link = join(root, 'combat-clips', 'linked.mp4');
    try {
      await symlink(join(outside, 'not-ours.mp4'), link);
    } catch {
      // Windows without developer mode refuses symlink creation; the check
      // itself is still exercised by the escaping-path case above.
      return;
    }
    const manifest = manifestWith([
      {
        id: 'linked',
        path: 'combat-clips/linked.mp4',
        kind: 'VIDEO',
        role: 'SOURCE_CLIP',
        description: 'linked',
        rights: OWNED,
      },
    ]);
    await expect(preflight(manifest)).rejects.toThrow(/SYMLINK_ESCAPES_ASSET_ROOT/);
    await rm(link, { force: true });
  }, 120_000);

  it('refuses two manifest entries that are the same bytes', async () => {
    const manifest = manifestWith([
      {
        id: 'session-copy',
        path: 'combat-clips/copy.mp4',
        kind: 'VIDEO',
        role: 'SOURCE_CLIP',
        description: 'copy',
        rights: OWNED,
      },
    ]);
    await expect(preflight(manifest)).rejects.toThrow(/DUPLICATE_CONTENT/);
  }, 120_000);

  it('refuses media that does not decode', async () => {
    const manifest = manifestWith([
      {
        id: 'corrupt',
        path: 'combat-clips/corrupt.mp4',
        kind: 'VIDEO',
        role: 'SOURCE_CLIP',
        description: 'corrupt',
        rights: OWNED,
      },
    ]);
    await expect(preflight(manifest)).rejects.toThrow(/UNREADABLE_MEDIA/);
  }, 120_000);

  it('refuses a file whose declared kind is not what it decodes as', async () => {
    const manifest = manifestWith([
      {
        id: 'mislabelled',
        path: 'app-ui/other-screen.png',
        kind: 'VIDEO',
        role: 'SOURCE_CLIP',
        description: 'a still declared as a clip',
        rights: OWNED,
      },
    ]);
    await expect(preflight(manifest)).rejects.toThrow(/KIND_MISMATCH/);
  }, 120_000);

  it('refuses a clip too short to fill the plan’s shortest beat', async () => {
    const manifest = manifestWith([
      {
        id: 'short',
        path: 'combat-clips/short.mp4',
        kind: 'VIDEO',
        role: 'SOURCE_CLIP',
        description: 'one second',
        rights: OWNED,
      },
    ]);
    await expect(preflight(manifest, 4)).rejects.toThrow(/INSUFFICIENT_CLIP_DURATION/);
  }, 120_000);

  it('refuses a checksum that does not match the bytes on disk', async () => {
    const manifest = manifestWith([
      {
        id: 'wrong-checksum',
        path: 'combat-clips/copy.mp4',
        kind: 'VIDEO',
        role: 'SOURCE_CLIP',
        description: 'copy',
        rights: OWNED,
        checksumSha256: 'b'.repeat(64),
      },
    ]);
    await expect(preflight(manifest)).rejects.toThrow(/CHECKSUM_MISMATCH/);
  }, 120_000);

  it('refuses an asset marked not permitted for output, before reading a byte', async () => {
    const manifest = parseProductionAssetManifest({
      manifestVersion: 1,
      library: 'test',
      assets: [
        {
          id: 'logo',
          path: 'brand/logo.png',
          kind: 'IMAGE',
          role: 'LOGO',
          description: 'logo',
          rights: OWNED,
        },
        {
          id: 'restricted',
          path: 'combat-clips/session.mp4',
          kind: 'VIDEO',
          role: 'SOURCE_CLIP',
          description: 'restricted',
          rights: { ...OWNED, permittedOutputUse: true },
        },
      ],
    });
    // Flip the flag after parsing: the manifest schema refuses
    // `permittedOutputUse: false` outright, and this proves the preflight is a
    // second, independent gate rather than a restatement of the first.
    const mutated = {
      ...manifest,
      assets: manifest.assets.map((asset) =>
        asset.id === 'restricted'
          ? { ...asset, rights: { ...asset.rights, permittedOutputUse: false } }
          : asset,
      ),
    } as ProductionAssetManifest;
    await expect(preflight(mutated)).rejects.toThrow(/RIGHTS_NOT_PERMITTED/);
  }, 120_000);

  it('refuses reference material even when its declared rights say OWNED', async () => {
    // This is the structural half of "analysis-only can never reach output":
    // the rights vocabulary says it is fine, and it is still refused, because
    // it sits under references/.
    const manifest = manifestWith([
      {
        id: 'sneaky-reference',
        path: 'references/benchmark.mp4',
        kind: 'VIDEO',
        role: 'SOURCE_CLIP',
        description: 'benchmark material relabelled as owned footage',
        rights: OWNED,
      },
    ]);
    await expect(preflight(manifest)).rejects.toThrow(/REFERENCE_MATERIAL_IN_PRODUCTION_MANIFEST/);
  }, 120_000);

  it('refuses an asset root that does not exist', async () => {
    await expect(
      runAssetRootPreflight({
        manifest: manifestWith(),
        manifestDir: root,
        assetRoot: resolve(root, 'no-such-directory'),
        binaries,
        now: new Date('2026-07-27T00:00:00Z'),
        runner,
        shortestBeatSeconds: 3,
      }),
    ).rejects.toThrow(AssetRootPreflightError);
  }, 60_000);
});

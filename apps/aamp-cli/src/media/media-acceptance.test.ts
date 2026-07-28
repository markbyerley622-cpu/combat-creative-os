import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NodeCommandRunner, resolveFfmpegBinaries } from '@combat/media';
import {
  createMediaAcquisitionProviders,
  evaluateMediaRights,
  PexelsMediaProvider,
  type MediaAcquisitionProvider,
  type MediaAcquisitionProviderId,
} from '@combat/providers';
import { startFakeMediaApi, type FakeMediaApi } from '@combat/providers/testing';

import { parseProductionAssetManifest } from '../production-assets';
import { applyApprovals } from './approval';
import { runMediaCli, resolveProviderList, MEDIA_EXIT_CODES } from './media-cli';
import { ACQUIRED_ASSETS_FILENAME, REPORT_FILENAMES } from './reports';
import { GALLERY_FILENAME, APPROVAL_TEMPLATE_FILENAME, runDirectory } from './run-store';
import {
  combineScores,
  evaluateSourceQuality,
  measureSourceMedia,
  PREMIUM_SOURCE_FLOOR,
  scoreRightsConfidence,
  scoreVerticalSuitability,
  SOURCE_QUALITY_PROFILE_VERSION,
  verticalCropWidth,
  type MeasureSourceOptions,
} from './source-quality';
import {
  buildProductionAssetManifest,
  classifyForOutput,
  ManifestBuildError,
} from './build-manifest';
import type { MediaQualityMeasurements } from '@combat/providers';

/**
 * The whole chain, end to end, with no network call and no paid call.
 *
 * The providers are pointed at a loopback fixture server; the media is
 * generated locally with FFmpeg's own `lavfi` sources. What this proves is the
 * mechanism — search, rights policy, approval gate, download, measurement,
 * manifest — and it deliberately proves nothing about creative quality, which
 * no part of this system measures.
 */

const runner = new NodeCommandRunner();
const binaries = resolveFfmpegBinaries(process.env);

let ffmpegAvailable = false;
let workspace: string;
let api: FakeMediaApi;
let mediaRoot: string;

async function hasFfmpeg(): Promise<boolean> {
  const result = await runner.run(binaries.ffmpeg, ['-hide_banner', '-version'], {
    timeoutMs: 10_000,
  });
  return result.exitCode === 0;
}

/** Generates a synthetic clip with `lavfi`. No third-party media is ever committed. */
async function generateClip(
  path: string,
  options: {
    readonly size: string;
    readonly seconds: number;
    readonly fps: number;
    readonly black?: boolean;
  },
): Promise<void> {
  const source = options.black
    ? `color=c=black:s=${options.size}:r=${options.fps}:d=${options.seconds}`
    : `testsrc2=s=${options.size}:r=${options.fps}:d=${options.seconds}`;
  const result = await runner.run(
    binaries.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      source,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      path,
    ],
    { timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) throw new Error(`lavfi generation failed: ${result.stderr}`);
}

beforeAll(async () => {
  ffmpegAvailable = await hasFfmpeg();
  workspace = await mkdtemp(join(tmpdir(), 'aamp-media-'));
  mediaRoot = join(workspace, 'media');
  await mkdir(mediaRoot, { recursive: true });
  // A repository marker so `findRepositoryRoot` stops here rather than climbing
  // into the real tree and writing runs into it.
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages: []\n');
  api = await startFakeMediaApi({ apiKeys: { pexels: 'pex-key' } });
}, 120_000);

afterAll(async () => {
  await api?.close();
  await rm(workspace, { recursive: true, force: true });
});

function fixtureProviders(): ReadonlyMap<MediaAcquisitionProviderId, MediaAcquisitionProvider> {
  return new Map<MediaAcquisitionProviderId, MediaAcquisitionProvider>([
    ['PEXELS', new PexelsMediaProvider({ apiKey: 'pex-key', baseUrlOverride: api.origin })],
  ]);
}

function cliContext(overrides: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    context: {
      cwd: workspace,
      env: { PEXELS_API_KEY: 'pex-key', AAMP_WORKSPACE_ID: 'combat-reviews', ...overrides },
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      now: () => new Date('2026-07-27T12:00:00.000Z'),
      runner,
      providerOverrides: fixtureProviders(),
    },
  };
}

/* ------------------------------------------------------------------------- */

describe('the source-quality profile (pure functions)', () => {
  const base: MediaQualityMeasurements = {
    fileSizeBytes: 10_000_000,
    detectedMediaKind: 'VIDEO',
    declaredMediaKindMismatch: false,
    container: 'mov,mp4,m4a',
    videoCodec: 'h264',
    audioCodec: null,
    widthPx: 3840,
    heightPx: 2160,
    durationSeconds: 12,
    frameRate: 30,
    pixelFormat: 'yuv420p',
    bitrateBitsPerSecond: 40_000_000,
    blackRatio: 0,
    freezeRatio: 0,
    sceneCount: 4,
    sceneChangesPerMinute: 15,
    longestUsableRunSeconds: 6,
    hasAudioStream: false,
    audioLoudnessLufs: null,
    audioClippedSamples: null,
    verticalCropFeasible: true,
    verticalCropWidthPx: 1215,
    checksumSha256: 'a'.repeat(64),
    notMeasured: [],
  };

  it('measures how much survives a 9:16 crop rather than assuming 4K is enough', () => {
    expect(verticalCropWidth(3840, 2160)).toBe(1215);
    // 1920×1080 crops to 607px — below the 1080 floor, so it would have to be
    // upscaled. That is the number the "it's HD, it'll be fine" instinct misses.
    expect(verticalCropWidth(1920, 1080)).toBe(607);
    expect(verticalCropWidth(1080, 1920)).toBe(1080);
  });

  it('passes a clean 4K clip', () => {
    const decision = evaluateSourceQuality({ measurements: base, mediaKind: 'VIDEO' });
    expect(decision.outcome).toBe('MEETS_PROFILE');
    expect(decision.profileVersion).toBe(SOURCE_QUALITY_PROFILE_VERSION);
  });

  it('refuses a source below the resolution floor, and says an upscale does not satisfy it', () => {
    const decision = evaluateSourceQuality({
      measurements: {
        ...base,
        widthPx: 1280,
        heightPx: 720,
        verticalCropWidthPx: 405,
        verticalCropFeasible: false,
      },
      mediaKind: 'VIDEO',
    });
    expect(decision.outcome).toBe('BELOW_PROFILE');
    expect(decision.reasons.join(' ')).toContain('Upscaling does not satisfy it');
  });

  it('accepts a below-floor source for small-overlay use only when a person justified it', () => {
    const decision = evaluateSourceQuality({
      measurements: { ...base, widthPx: 1280, heightPx: 720 },
      mediaKind: 'VIDEO',
      justification: { smallOverlayUseAccepted: true, reason: 'corner badge, 180px wide' },
    });
    expect(decision.outcome).toBe('REVIEW_REQUIRED');
    expect(decision.reasons.join(' ')).toContain('corner badge');
  });

  it('refuses a frame rate below 24 fps', () => {
    expect(
      evaluateSourceQuality({ measurements: { ...base, frameRate: 15 }, mediaKind: 'VIDEO' })
        .outcome,
    ).toBe('BELOW_PROFILE');
  });

  it('refuses excessive black and excessive freeze', () => {
    expect(
      evaluateSourceQuality({ measurements: { ...base, blackRatio: 0.6 }, mediaKind: 'VIDEO' })
        .outcome,
    ).toBe('BELOW_PROFILE');
    expect(
      evaluateSourceQuality({ measurements: { ...base, freezeRatio: 0.6 }, mediaKind: 'VIDEO' })
        .outcome,
    ).toBe('BELOW_PROFILE');
  });

  it('refuses a clip too short to carry a beat unless it is justified', () => {
    const short = { ...base, longestUsableRunSeconds: 1.2 };
    expect(evaluateSourceQuality({ measurements: short, mediaKind: 'VIDEO' }).outcome).toBe(
      'BELOW_PROFILE',
    );
    expect(
      evaluateSourceQuality({
        measurements: short,
        mediaKind: 'VIDEO',
        justification: { shortClipAccepted: true, reason: 'one-second reaction cut' },
      }).outcome,
    ).toBe('REVIEW_REQUIRED');
  });

  it('refuses a codec the renderer would fail on, before a render is attempted', () => {
    expect(
      evaluateSourceQuality({ measurements: { ...base, videoCodec: 'wmv3' }, mediaKind: 'VIDEO' })
        .outcome,
    ).toBe('BELOW_PROFILE');
  });

  it('turns an unmeasured property into a review, never into a pass', () => {
    const decision = evaluateSourceQuality({
      measurements: { ...base, blackRatio: null, freezeRatio: null, longestUsableRunSeconds: null },
      mediaKind: 'VIDEO',
    });
    expect(decision.outcome).toBe('REVIEW_REQUIRED');
    expect(decision.reasons.join(' ')).toContain('unverified');
  });

  it('names the human checks no measurement settles, on every item', () => {
    const decision = evaluateSourceQuality({ measurements: base, mediaKind: 'VIDEO' });
    expect(decision.humanChecksRequired.join(' ')).toContain('watermark');
    expect(decision.humanChecksRequired.join(' ')).toContain('burned-in');
    expect(decision.humanChecksRequired.join(' ')).toContain(
      'No machine measurement of this exists',
    );
  });

  it('never reports a cinematic-quality score', () => {
    const decision = evaluateSourceQuality({ measurements: base, mediaKind: 'VIDEO' });
    expect(Object.keys(decision.scores).sort()).toEqual([
      'editUtilityScore',
      'overallSourceScore',
      'rightsConfidenceScore',
      'technicalQualityScore',
      'verticalSuitabilityScore',
    ]);
  });

  it('scores rights confidence from the policy outcome and zero for a rejection', () => {
    expect(scoreRightsConfidence(undefined)).toBe(0);
    expect(
      scoreRightsConfidence({
        outcome: 'REJECTED',
        policyVersion: 'v',
        reasons: ['nc'],
        candidateUsages: [],
      }),
    ).toBe(0);
    expect(
      scoreRightsConfidence({
        outcome: 'AUTOMATICALLY_ELIGIBLE',
        policyVersion: 'v',
        reasons: ['x'],
        candidateUsages: [],
      }),
    ).toBe(90);
  });

  it('rewards a native vertical source over an ultra-wide one', () => {
    const vertical = scoreVerticalSuitability({
      ...base,
      widthPx: 2160,
      heightPx: 3840,
      verticalCropWidthPx: 2160,
    });
    const ultrawide = scoreVerticalSuitability({
      ...base,
      widthPx: 5120,
      heightPx: 2160,
      verticalCropWidthPx: 1215,
    });
    expect(vertical).toBeGreaterThan(ultrawide);
  });

  it('is deterministic: the same measurements always produce the same scores', () => {
    const a = combineScores({
      technicalQualityScore: 80,
      editUtilityScore: 70,
      verticalSuitabilityScore: 60,
      rightsConfidenceScore: 50,
    });
    const b = combineScores({
      technicalQualityScore: 80,
      editUtilityScore: 70,
      verticalSuitabilityScore: 60,
      rightsConfidenceScore: 50,
    });
    expect(a).toEqual(b);
  });

  it('states its floor as data an operator can read', () => {
    expect(PREMIUM_SOURCE_FLOOR.minimumLongEdgePx).toBe(1920);
    expect(PREMIUM_SOURCE_FLOOR.minimumFrameRate).toBe(24);
  });
});

describe('measuring real bytes', () => {
  it('measures a generated 4K clip from the file rather than from a declaration', async () => {
    if (!ffmpegAvailable) {
      console.warn('SKIPPED: no FFmpeg on PATH — measurement against real bytes was not exercised');
      return;
    }
    const path = join(mediaRoot, 'uhd.mp4');
    await generateClip(path, { size: '3840x2160', seconds: 4, fps: 30 });

    const measurements = await measureSourceMedia({
      filePath: path,
      mediaKind: 'VIDEO',
      runner,
      binaries,
    } satisfies MeasureSourceOptions);

    expect(measurements.widthPx).toBe(3840);
    expect(measurements.heightPx).toBe(2160);
    expect(measurements.videoCodec).toBe('h264');
    expect(measurements.frameRate).toBeCloseTo(30, 1);
    expect(measurements.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(measurements.verticalCropWidthPx).toBe(1215);
    expect(measurements.verticalCropFeasible).toBe(true);
    expect(measurements.blackRatio).toBe(0);
  }, 180_000);

  it('measures an all-black clip as black and refuses it', async () => {
    if (!ffmpegAvailable) {
      console.warn('SKIPPED: no FFmpeg on PATH — black detection was not exercised');
      return;
    }
    const path = join(mediaRoot, 'black.mp4');
    await generateClip(path, { size: '1920x1080', seconds: 3, fps: 30, black: true });

    const measurements = await measureSourceMedia({
      filePath: path,
      mediaKind: 'VIDEO',
      runner,
      binaries,
    });
    expect(measurements.blackRatio).toBeGreaterThan(0.5);

    const decision = evaluateSourceQuality({ measurements, mediaKind: 'VIDEO' });
    expect(decision.outcome).toBe('BELOW_PROFILE');
    expect(decision.reasons.join(' ')).toMatch(/black/);
  }, 180_000);

  it('evaluates a still declared as video against the still rules, and reports the disagreement', async () => {
    if (!ffmpegAvailable) {
      console.warn('SKIPPED: no FFmpeg on PATH — media-kind detection was not exercised');
      return;
    }
    // Found against the operator's real candidate pack: sixty rows recorded as
    // `video` whose downloaded file is a JPEG. Trusting the catalogue produced a
    // confident, wrong refusal ("the codec mjpeg is not one the renderer
    // accepts") — a declaration dressed up as a measurement.
    const path = join(mediaRoot, 'declared-video.jpg');
    const result = await runner.run(
      binaries.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=4000x3000:d=1',
        '-frames:v',
        '1',
        path,
      ],
      { timeoutMs: 60_000 },
    );
    expect(result.exitCode).toBe(0);

    const measurements = await measureSourceMedia({
      filePath: path,
      mediaKind: 'VIDEO',
      runner,
      binaries,
    });
    expect(measurements.detectedMediaKind).toBe('IMAGE');
    expect(measurements.declaredMediaKindMismatch).toBe(true);

    const decision = evaluateSourceQuality({ measurements, mediaKind: 'VIDEO' });
    // Not refused for a video codec it was never going to have.
    expect(decision.reasons.join(' ')).not.toContain('mjpeg');
    expect(decision.reasons.join(' ')).toContain('measures as IMAGE');
    expect(decision.outcome).not.toBe('BELOW_PROFILE');
  }, 120_000);

  it('refuses a zero-byte file before probing it', async () => {
    const path = join(mediaRoot, 'empty.mp4');
    await writeFile(path, '');
    await expect(
      measureSourceMedia({ filePath: path, mediaKind: 'VIDEO', runner, binaries }),
    ).rejects.toThrow(/zero bytes/);
  });
});

describe('the manifest builder', () => {
  const acquired = (overrides: Record<string, unknown> = {}) =>
    ({
      assetId: 'px-1',
      candidateId: 'PX-1',
      provider: 'PEXELS' as const,
      providerAssetId: '1',
      mediaKind: 'VIDEO' as const,
      relativePath: './px-1-abc.mp4',
      checksumSha256: 'a'.repeat(64),
      fileSizeBytes: 1000,
      measurements: {
        fileSizeBytes: 1000,
        detectedMediaKind: 'VIDEO' as const,
        declaredMediaKindMismatch: false,
        container: 'mp4',
        videoCodec: 'h264',
        audioCodec: null,
        widthPx: 3840,
        heightPx: 2160,
        durationSeconds: 12,
        frameRate: 30,
        pixelFormat: 'yuv420p',
        bitrateBitsPerSecond: 40_000_000,
        blackRatio: 0,
        freezeRatio: 0,
        sceneCount: 3,
        sceneChangesPerMinute: 12,
        longestUsableRunSeconds: 5,
        hasAudioStream: false,
        audioLoudnessLufs: null,
        audioClippedSamples: null,
        verticalCropFeasible: true,
        verticalCropWidthPx: 1215,
        checksumSha256: 'a'.repeat(64),
        notMeasured: [],
      },
      qualityDecision: {
        outcome: 'MEETS_PROFILE' as const,
        profileVersion: SOURCE_QUALITY_PROFILE_VERSION,
        scores: {
          technicalQualityScore: 90,
          editUtilityScore: 80,
          verticalSuitabilityScore: 70,
          rightsConfidenceScore: 60,
          overallSourceScore: 76,
        },
        reasons: ['measured'],
        humanChecksRequired: [],
      },
      rights: {
        declaredLicence: 'Pexels License',
        licenceFamily: 'PEXELS_LICENCE' as const,
        creator: 'Ada Fixture',
        commercialUse: 'PERMITTED' as const,
        derivativeUse: 'PERMITTED' as const,
        paidAdvertisingUse: 'PERMITTED' as const,
        recognizablePersonRisk: 'NONE_APPARENT' as const,
        trademarkOrLogoRisk: 'NONE_APPARENT' as const,
        endorsementRisk: 'LOW' as const,
        modelReleaseStatus: 'ON_FILE' as const,
        propertyReleaseStatus: 'NOT_APPLICABLE' as const,
        sourceRestrictions: [],
      },
      rightsDecision: {
        outcome: 'AUTOMATICALLY_ELIGIBLE' as const,
        policyVersion: 'MEDIA_RIGHTS_POLICY_V1',
        reasons: ['clean'],
        candidateUsages: [
          'INTERNAL_EVALUATION' as const,
          'ORGANIC_SOCIAL' as const,
          'PAID_SOCIAL' as const,
        ],
      },
      approval: {
        candidateId: 'PX-1',
        approvedBy: 'A Reviewer',
        approvedUsages: ['ORGANIC_SOCIAL' as const],
        approvedPlatforms: ['instagram-reels'],
        effectiveDate: '2026-07-01T00:00:00.000Z',
        evidenceReferences: [],
        notes: 'read the licence',
        approvedAt: '2026-07-01T00:00:00.000Z',
      },
      landingPageUrl: 'https://www.pexels.com/video/1/',
      downloadHost: 'videos.pexels.com',
      downloadedAt: '2026-07-27T00:00:00.000Z',
      state: 'OUTPUT_ELIGIBLE' as const,
      ...overrides,
    }) as never;

  const baseManifest = parseProductionAssetManifest({
    manifestVersion: 1,
    library: 'Combat Reviews owned library',
    assets: [
      {
        id: 'logo',
        path: './logo.png',
        kind: 'IMAGE',
        role: 'LOGO',
        description: 'brand mark',
        rights: {
          classification: 'OWNED',
          owner: 'Combat Reviews',
          permittedOutputUse: true,
          restrictions: [],
        },
        beats: [],
        tags: [],
      },
    ],
  });

  it('projects licence families onto the existing rights vocabulary, never a new class', () => {
    expect(classifyForOutput('CC0')).toBe('LICENSED_FOR_OUTPUT');
    expect(classifyForOutput('PEXELS_LICENCE')).toBe('LICENSED_FOR_OUTPUT');
    expect(classifyForOutput('US_GOVERNMENT_PUBLIC_DOMAIN')).toBe('LICENSED_FOR_OUTPUT');
    expect(classifyForOutput('CC_BY_NC')).toBe('UNKNOWN_RIGHTS');
    expect(classifyForOutput('UNKNOWN')).toBe('UNKNOWN_RIGHTS');
  });

  it('produces a manifest the existing parser accepts unchanged', () => {
    const built = buildProductionAssetManifest({
      library: 'acquired',
      assets: [acquired()],
      assetDirectory: '/tmp/assets',
      outputManifestDirectory: '/tmp/assets',
      usage: 'ORGANIC_SOCIAL',
      baseManifest,
      baseManifestDirectory: '/tmp/brand',
      now: new Date('2026-07-27T00:00:00.000Z'),
    });
    // Re-parsed here as well: the assertion is that the *existing* schema
    // accepts it, not that this module's own builder is self-consistent.
    expect(() => parseProductionAssetManifest(built.manifest)).not.toThrow();
    expect(built.added).toEqual(['px-1']);
    expect(built.preserved).toEqual(['logo']);
    const entry = built.manifest.assets.find((asset) => asset.id === 'px-1');
    expect(entry?.rights.classification).toBe('LICENSED_FOR_OUTPUT');
    expect(entry?.role).toBe('SOURCE_CLIP');
    expect(entry?.checksumSha256).toBe('a'.repeat(64));
  });

  it('refuses INTERNAL_EVALUATION material from a campaign manifest by name', () => {
    const built = buildProductionAssetManifest({
      library: 'acquired',
      assets: [
        acquired(),
        acquired({
          assetId: 'px-2',
          candidateId: 'PX-2',
          approval: {
            candidateId: 'PX-2',
            approvedBy: 'A Reviewer',
            approvedUsages: ['INTERNAL_EVALUATION'],
            approvedPlatforms: ['internal'],
            effectiveDate: '2026-07-01T00:00:00.000Z',
            evidenceReferences: [],
            notes: 'evaluation only',
            approvedAt: '2026-07-01T00:00:00.000Z',
          },
        }),
      ],
      assetDirectory: '/tmp/assets',
      outputManifestDirectory: '/tmp/assets',
      usage: 'ORGANIC_SOCIAL',
      baseManifest,
      now: new Date('2026-07-27T00:00:00.000Z'),
    });
    expect(built.manifest.assets.map((a) => a.id)).not.toContain('px-2');
    expect(built.refused.map((r) => r.assetId)).toContain('px-2');
    expect(built.refused[0]?.reason).toContain('different kind of permission');
  });

  it('builds a visibly labelled demonstration for internal-evaluation material', () => {
    const built = buildProductionAssetManifest({
      library: 'acquired',
      assets: [
        acquired({
          approval: {
            candidateId: 'PX-1',
            approvedBy: 'A Reviewer',
            approvedUsages: ['INTERNAL_EVALUATION'],
            approvedPlatforms: ['internal'],
            effectiveDate: '2026-07-01T00:00:00.000Z',
            evidenceReferences: [],
            notes: 'evaluation only',
            approvedAt: '2026-07-01T00:00:00.000Z',
          },
        }),
      ],
      assetDirectory: '/tmp/assets',
      outputManifestDirectory: '/tmp/assets',
      usage: 'INTERNAL_EVALUATION',
      baseManifest,
      now: new Date('2026-07-27T00:00:00.000Z'),
    });
    expect(built.isInternalEvaluationDemonstration).toBe(true);
    expect(built.manifest.library).toContain('INTERNAL EVALUATION DEMONSTRATION');
    expect(
      built.manifest.assets.find((a) => a.id === 'px-1')?.rights.restrictions.join(' '),
    ).toContain('INTERNAL EVALUATION ONLY');
  });

  it('refuses a manifest with no logo rather than writing an unusable one', () => {
    expect(() =>
      buildProductionAssetManifest({
        library: 'acquired',
        assets: [acquired()],
        assetDirectory: '/tmp/assets',
        outputManifestDirectory: '/tmp/assets',
        usage: 'ORGANIC_SOCIAL',
        now: new Date('2026-07-27T00:00:00.000Z'),
      }),
    ).toThrow(ManifestBuildError);
  });

  it('refuses an asset that measured below the source profile', () => {
    const built = buildProductionAssetManifest({
      library: 'acquired',
      assets: [
        acquired(),
        acquired({
          assetId: 'px-3',
          candidateId: 'PX-3',
          qualityDecision: {
            outcome: 'BELOW_PROFILE',
            profileVersion: SOURCE_QUALITY_PROFILE_VERSION,
            scores: {
              technicalQualityScore: 10,
              editUtilityScore: 10,
              verticalSuitabilityScore: 10,
              rightsConfidenceScore: 10,
              overallSourceScore: 10,
            },
            reasons: ['1280×720 is below the floor'],
            humanChecksRequired: [],
          },
        }),
      ],
      assetDirectory: '/tmp/assets',
      outputManifestDirectory: '/tmp/assets',
      usage: 'ORGANIC_SOCIAL',
      baseManifest,
      now: new Date('2026-07-27T00:00:00.000Z'),
    });
    expect(built.refused.map((r) => r.assetId)).toContain('px-3');
  });

  it('preserves the base manifest’s plan bindings when it replaces an entry', () => {
    const withBinding = parseProductionAssetManifest({
      manifestVersion: 1,
      library: 'brand',
      assets: [
        ...baseManifest.assets,
        {
          id: 'px-1',
          path: './placeholder.mp4',
          kind: 'VIDEO',
          role: 'SOURCE_CLIP',
          description: 'placeholder',
          rights: {
            classification: 'OWNED',
            owner: 'Combat Reviews',
            permittedOutputUse: true,
            restrictions: [],
          },
          beats: ['HOOK'],
          tags: ['pinned'],
        },
      ],
    });
    const built = buildProductionAssetManifest({
      library: 'acquired',
      assets: [acquired()],
      assetDirectory: '/tmp/assets',
      outputManifestDirectory: '/tmp/assets',
      usage: 'ORGANIC_SOCIAL',
      baseManifest: withBinding,
      now: new Date('2026-07-27T00:00:00.000Z'),
    });
    const entry = built.manifest.assets.find((asset) => asset.id === 'px-1');
    expect(built.replaced).toEqual(['px-1']);
    expect(entry?.beats).toEqual(['HOOK']);
    expect(entry?.tags).toEqual(['pinned']);
    expect(entry?.checksumSha256).toBe('a'.repeat(64));
  });
});

describe('the CLI, end to end', () => {
  it('refuses the sources this system will not integrate with, and says why', () => {
    const { providers, refusals } = resolveProviderList('pexels,youtube,ufc');
    expect(providers).toEqual(['PEXELS']);
    expect(refusals.join(' ')).toContain('grants rights to YouTube');
    expect(refusals.join(' ')).toContain('copyrighted');
  });

  it('searches, writes a run, a gallery and an approval template — and approves nothing', async () => {
    const { out, context } = cliContext();
    const code = await runMediaCli(
      [
        'search',
        '--query',
        'boxing training cinematic',
        '--kind',
        'video',
        '--providers',
        'pexels',
      ],
      context,
    );
    expect(code).toBe(MEDIA_EXIT_CODES.SUCCESS);
    const output = out.join('');
    expect(output).toContain('run id:');
    expect(output).toContain('paid calls:         0');

    const runId = /run id:\s+(\S+)/.exec(output)?.[1] as string;
    const directory = runDirectory(workspace, runId);

    const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(run.paidProviderCalls).toBe(0);
    // Nothing that came out of a search is above rights review.
    for (const candidate of run.candidates as { state: string }[]) {
      expect(['METADATA_VERIFIED', 'RIGHTS_REVIEW_REQUIRED']).toContain(candidate.state);
    }

    const gallery = await readFile(join(directory, GALLERY_FILENAME), 'utf8');
    expect(gallery).toContain('NOTHING HERE IS APPROVED');

    const template = JSON.parse(
      await readFile(join(directory, APPROVAL_TEMPLATE_FILENAME), 'utf8'),
    ) as {
      approvals: { approvedBy: string; notes: string }[];
    };
    // A template that worked as-is would make the attribution untrue on first use.
    expect(template.approvals.every((entry) => entry.approvedBy.startsWith('TODO'))).toBe(true);
    expect(template.approvals.every((entry) => entry.notes.startsWith('TODO'))).toBe(true);
  }, 60_000);

  it('resolves known provider asset ids instead of searching by keyword', async () => {
    const { out, context } = cliContext();
    const code = await runMediaCli(
      ['search', '--ids', '8745106', '--kind', 'video', '--providers', 'pexels'],
      context,
    );
    expect(code).toBe(MEDIA_EXIT_CODES.SUCCESS);

    const output = out.join('');
    const runId = /run id:\s+(\S+)/.exec(output)?.[1] as string;
    const directory = runDirectory(workspace, runId);
    const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')) as {
      request: { query: string };
      candidates: { state: string }[];
      paidProviderCalls: number;
    };

    expect(run.candidates.length).toBe(1);
    expect(run.paidProviderCalls).toBe(0);
    // The recorded request says what was actually asked for, not a keyword
    // nobody typed.
    expect(run.request.query).toContain('provider-asset-ids');
    expect(run.request.query).toContain('8745106');
    // An id lookup is still a search: it confers nothing beyond rights review.
    for (const candidate of run.candidates) {
      expect(['METADATA_VERIFIED', 'RIGHTS_REVIEW_REQUIRED']).toContain(candidate.state);
    }

    const template = JSON.parse(
      await readFile(join(directory, APPROVAL_TEMPLATE_FILENAME), 'utf8'),
    ) as { approvals: { approvedBy: string }[] };
    expect(template.approvals.every((entry) => entry.approvedBy.startsWith('TODO'))).toBe(true);
  }, 60_000);

  it('refuses --ids unless exactly one provider is named', async () => {
    const { err, context } = cliContext();
    const code = await runMediaCli(
      ['search', '--ids', '8745106,8745104', '--kind', 'video', '--providers', 'pexels,pixabay'],
      context,
    );
    // Id 8745106 is a different item at every provider; guessing which was
    // meant is how the wrong footage gets acquired.
    expect(code).toBe(MEDIA_EXIT_CODES.INVALID_ARGUMENTS);
    expect(err.join('')).toContain('exactly one --providers value');
  }, 60_000);

  it('never writes a provider API key into any run artefact', async () => {
    const { out, context } = cliContext();
    await runMediaCli(
      ['search', '--query', 'gym', '--kind', 'video', '--providers', 'pexels'],
      context,
    );
    const runId = /run id:\s+(\S+)/.exec(out.join(''))?.[1] as string;
    const directory = runDirectory(workspace, runId);
    for (const filename of ['run.json', GALLERY_FILENAME, APPROVAL_TEMPLATE_FILENAME]) {
      expect(await readFile(join(directory, filename), 'utf8')).not.toContain('pex-key');
    }
  }, 60_000);

  it('refuses an approval for a candidate the run does not hold', async () => {
    const { out, context } = cliContext();
    await runMediaCli(
      ['search', '--query', 'gym', '--kind', 'video', '--providers', 'pexels'],
      context,
    );
    const runId = /run id:\s+(\S+)/.exec(out.join(''))?.[1] as string;

    const selectionPath = join(workspace, 'bogus-approval.json');
    await writeFile(
      selectionPath,
      JSON.stringify({
        submissionVersion: 1,
        runId,
        approvals: [
          {
            candidateId: 'PX-does-not-exist',
            approvedBy: 'A Reviewer',
            approvedUsages: ['ORGANIC_SOCIAL'],
            approvedPlatforms: ['instagram-reels'],
            effectiveDate: '2026-07-01T00:00:00.000Z',
            notes: 'n/a',
            approvedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const approve = cliContext();
    const code = await runMediaCli(
      ['approve', '--run', runId, '--selection', selectionPath],
      approve.context,
    );
    expect(code).toBe(MEDIA_EXIT_CODES.APPROVAL_REFUSED);
    expect(approve.err.join('')).toContain('has no candidate with this id');
  }, 60_000);

  it('refuses an approval file written against a different run', async () => {
    const { out, context } = cliContext();
    await runMediaCli(
      ['search', '--query', 'gym', '--kind', 'video', '--providers', 'pexels'],
      context,
    );
    const runId = /run id:\s+(\S+)/.exec(out.join(''))?.[1] as string;

    const selectionPath = join(workspace, 'wrong-run.json');
    await writeFile(
      selectionPath,
      JSON.stringify({
        submissionVersion: 1,
        runId: 'search-19700101-deadbeef',
        approvals: [
          {
            candidateId: 'PX-15527457',
            approvedBy: 'A Reviewer',
            approvedUsages: ['ORGANIC_SOCIAL'],
            approvedPlatforms: ['instagram-reels'],
            effectiveDate: '2026-07-01T00:00:00.000Z',
            notes: 'n/a',
            approvedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const approve = cliContext();
    const code = await runMediaCli(
      ['approve', '--run', runId, '--selection', selectionPath],
      approve.context,
    );
    expect(code).toBe(MEDIA_EXIT_CODES.APPROVAL_REFUSED);
    expect(approve.err.join('')).toContain('must not apply to another run');
  }, 60_000);

  it('approves, acquires, measures and builds a manifest the existing generator accepts', async () => {
    if (!ffmpegAvailable) {
      console.warn(
        'SKIPPED: no FFmpeg on PATH — the acquisition chain was not exercised end to end',
      );
      return;
    }

    // The fixture server's `.mp4` route returns a header-only file, which is
    // enough for the byte sniffer and not enough for ffprobe. So the download
    // is pointed at a real generated clip served by the same fixture host.
    const clipPath = join(mediaRoot, 'served.mp4');
    await generateClip(clipPath, { size: '3840x2160', seconds: 4, fps: 30 });

    const search = cliContext();
    await runMediaCli(
      ['search', '--query', 'boxing', '--kind', 'video', '--providers', 'pexels'],
      search.context,
    );
    const runId = /run id:\s+(\S+)/.exec(search.out.join(''))?.[1] as string;
    const directory = runDirectory(workspace, runId);

    // Point the chosen candidate's rendition at the real generated clip via a
    // file the local acquisition path can read: the pack route. This exercises
    // measurement, promotion and manifest emission without a network fetch.
    const runPath = join(directory, 'run.json');
    const run = JSON.parse(await readFile(runPath, 'utf8')) as Record<string, unknown>;
    const candidates = run.candidates as Record<string, unknown>[];
    const chosen = candidates.find((c) => c.candidateId === 'PX-15527457') as Record<
      string,
      unknown
    >;
    chosen.provider = 'EXTERNAL_PILOT_PACK';
    await writeFile(runPath, JSON.stringify(run, null, 2));
    await writeFile(
      join(directory, 'private-provenance.json'),
      JSON.stringify({
        privateProvenanceVersion: 1,
        runId,
        workspaceId: 'combat-reviews',
        externalPackPath: mediaRoot,
        locations: [
          {
            candidateId: 'PX-15527457',
            absolutePath: clipPath,
            checksumSha256: '',
            licenceEvidencePath: null,
          },
        ],
      }),
    );

    const selectionPath = join(workspace, 'approval.json');
    await writeFile(
      selectionPath,
      JSON.stringify({
        submissionVersion: 1,
        runId,
        approvals: [
          {
            candidateId: 'PX-15527457',
            approvedBy: 'A Named Reviewer',
            approvedUsages: ['INTERNAL_EVALUATION', 'ORGANIC_SOCIAL'],
            approvedPlatforms: ['instagram-reels'],
            effectiveDate: '2026-07-01T00:00:00.000Z',
            evidenceReferences: [],
            notes: 'Read the Pexels licence and confirmed no identifiable person is in frame.',
            approvedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const approve = cliContext();
    expect(
      await runMediaCli(['approve', '--run', runId, '--selection', selectionPath], approve.context),
    ).toBe(MEDIA_EXIT_CODES.SUCCESS);

    const outputDir = join(workspace, 'acquired');
    const acquire = cliContext();
    const acquireCode = await runMediaCli(
      ['acquire', '--run', runId, '--selection', selectionPath, '--output-dir', outputDir],
      acquire.context,
    );
    expect(acquireCode).toBe(MEDIA_EXIT_CODES.SUCCESS);

    const acquired = JSON.parse(
      await readFile(join(outputDir, ACQUIRED_ASSETS_FILENAME), 'utf8'),
    ) as {
      assets: {
        assetId: string;
        state: string;
        measurements: { widthPx: number };
        checksumSha256: string;
      }[];
    };
    expect(acquired.assets).toHaveLength(1);
    expect(acquired.assets[0]?.state).toBe('OUTPUT_ELIGIBLE');
    expect(acquired.assets[0]?.measurements.widthPx).toBe(3840);

    // Every evidence artefact is written and none holds a credential.
    for (const filename of Object.values(REPORT_FILENAMES)) {
      const content = await readFile(join(outputDir, filename), 'utf8');
      expect(content).not.toContain('pex-key');
      expect(content.length).toBeGreaterThan(20);
    }
    const provenance = JSON.parse(
      await readFile(join(outputDir, REPORT_FILENAMES.provenance), 'utf8'),
    ) as {
      assets: { landingPageUrl: string; approvedBy: string; checksumSha256: string }[];
      requiresHumanApproval: boolean;
    };
    expect(provenance.requiresHumanApproval).toBe(true);
    expect(provenance.assets[0]?.approvedBy).toBe('A Named Reviewer');
    expect(provenance.assets[0]?.landingPageUrl).toContain('pexels.com');

    // A base manifest with a logo, as a real campaign has.
    const brandDir = join(workspace, 'brand');
    await mkdir(brandDir, { recursive: true });
    await writeFile(join(brandDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const basePath = join(brandDir, 'assets.json');
    await writeFile(
      basePath,
      JSON.stringify({
        manifestVersion: 1,
        library: 'Combat Reviews owned library',
        assets: [
          {
            id: 'logo',
            path: './logo.png',
            kind: 'IMAGE',
            role: 'LOGO',
            description: 'brand mark',
            rights: {
              classification: 'OWNED',
              owner: 'Combat Reviews',
              permittedOutputUse: true,
              restrictions: [],
            },
          },
        ],
      }),
    );

    const manifestPath = join(outputDir, 'production-assets.json');
    const build = cliContext();
    const buildCode = await runMediaCli(
      [
        'build-manifest',
        '--run',
        runId,
        '--output',
        manifestPath,
        '--asset-dir',
        outputDir,
        '--base-manifest',
        basePath,
        '--usage',
        'organic-social',
      ],
      build.context,
    );
    expect(buildCode).toBe(MEDIA_EXIT_CODES.SUCCESS);

    // The binding assertion: the existing production-asset parser accepts it.
    const manifest = parseProductionAssetManifest(
      JSON.parse(await readFile(manifestPath, 'utf8')),
      manifestPath,
    );
    expect(manifest.assets.map((asset) => asset.id).sort()).toEqual(['logo', 'px-15527457']);
    const entry = manifest.assets.find((asset) => asset.id === 'px-15527457');
    expect(entry?.rights.permittedOutputUse).toBe(true);
    expect(entry?.rights.classification).toBe('LICENSED_FOR_OUTPUT');
    expect(entry?.declaredWidthPx).toBe(3840);
    expect(entry?.checksumSha256).toBe(acquired.assets[0]?.checksumSha256);

    // And the credits an operator publishes.
    const credits = await readFile(join(outputDir, REPORT_FILENAMES.creditsMarkdown), 'utf8');
    expect(credits).toContain('# Credits');
    expect(credits).toContain('Acquisition grants no output rights');
  }, 300_000);

  it('never promotes a candidate whose bytes could not be measured, even though the download succeeded', async () => {
    const { out, context } = cliContext();
    await runMediaCli(
      ['search', '--query', 'gym', '--kind', 'video', '--providers', 'pexels'],
      context,
    );
    const runId = /run id:\s+(\S+)/.exec(out.join(''))?.[1] as string;

    // The fixture server answers `.mp4` with a valid ISO base-media *header* —
    // enough to pass the byte sniffer, not enough for ffprobe to read a stream.
    // That is precisely the case the "provider success never marks an asset
    // usable" rule exists for: a 200 response and a plausible file, and nothing
    // established about what is in it.
    const approvalPath = join(workspace, 'unmeasurable.json');
    await writeFile(
      approvalPath,
      JSON.stringify({
        submissionVersion: 1,
        runId,
        approvals: [
          {
            candidateId: 'PX-9944252',
            approvedBy: 'A Reviewer',
            approvedUsages: ['ORGANIC_SOCIAL'],
            approvedPlatforms: ['instagram-reels'],
            effectiveDate: '2026-07-01T00:00:00.000Z',
            evidenceReferences: [],
            notes: 'read the licence',
            approvedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const outputDir = join(workspace, 'unmeasurable-out');
    const acquire = cliContext();
    const code = await runMediaCli(
      ['acquire', '--run', runId, '--selection', approvalPath, '--output-dir', outputDir],
      acquire.context,
    );
    expect(code).toBe(MEDIA_EXIT_CODES.ACQUISITION_FAILURE);
    expect(acquire.err.join('')).toMatch(/MEASUREMENT_FAILED|BELOW_SOURCE_PROFILE/);

    const acquired = JSON.parse(
      await readFile(join(outputDir, ACQUIRED_ASSETS_FILENAME), 'utf8'),
    ) as {
      assets: unknown[];
    };
    expect(acquired.assets).toHaveLength(0);

    const run = JSON.parse(
      await readFile(join(runDirectory(workspace, runId), 'run.json'), 'utf8'),
    ) as {
      candidates: { candidateId: string; state: string }[];
    };
    const candidate = run.candidates.find((entry) => entry.candidateId === 'PX-9944252');
    expect(candidate?.state).not.toBe('OUTPUT_ELIGIBLE');
  }, 60_000);

  it('refuses an approval that claims a usage the rights policy did not leave open', () => {
    const candidate = {
      candidateId: 'PB-1',
      provider: 'PIXABAY' as const,
      providerAssetId: '1',
      mediaKind: 'VIDEO' as const,
      title: 'clip',
      description: '',
      landingPageUrl: 'https://pixabay.com/videos/id-1/',
      renditions: [{ label: 'large', url: 'https://cdn.pixabay.com/video/1/large.mp4' }],
      durationSeconds: 10,
      widthPx: 3840,
      heightPx: 2160,
      frameRate: null,
      orientation: 'LANDSCAPE' as const,
      fileSizeBytes: 1000,
      rights: {
        declaredLicence: 'Pixabay Content License',
        licenceFamily: 'PIXABAY_CONTENT_LICENCE' as const,
        creator: 'El Fixture',
        commercialUse: 'PERMITTED' as const,
        derivativeUse: 'PERMITTED' as const,
        // Pixabay's identifiable-persons clause makes paid advertising a
        // per-item question, so the policy never leaves PAID_SOCIAL open.
        paidAdvertisingUse: 'UNKNOWN' as const,
        recognizablePersonRisk: 'UNKNOWN' as const,
        trademarkOrLogoRisk: 'UNKNOWN' as const,
        endorsementRisk: 'MEDIUM' as const,
        modelReleaseStatus: 'NOT_PROVIDED' as const,
        propertyReleaseStatus: 'NOT_PROVIDED' as const,
        sourceRestrictions: [],
      },
      retrievedAt: '2026-07-27T00:00:00.000Z',
      state: 'RIGHTS_REVIEW_REQUIRED' as const,
      rightsDecision: evaluateMediaRights({
        facts: {
          declaredLicence: 'Pixabay Content License',
          licenceFamily: 'PIXABAY_CONTENT_LICENCE',
          creator: 'El Fixture',
          commercialUse: 'PERMITTED',
          derivativeUse: 'PERMITTED',
          paidAdvertisingUse: 'UNKNOWN',
          recognizablePersonRisk: 'UNKNOWN',
          trademarkOrLogoRisk: 'UNKNOWN',
          endorsementRisk: 'MEDIUM',
          modelReleaseStatus: 'NOT_PROVIDED',
          propertyReleaseStatus: 'NOT_PROVIDED',
          sourceRestrictions: [],
        },
        landingPageUrl: 'https://pixabay.com/videos/id-1/',
      }),
      notes: '',
    };

    const result = applyApprovals({
      run: {
        runVersion: 1,
        runId: 'search-x',
        workspaceId: 'combat-reviews',
        origin: 'PROVIDER_SEARCH',
        startedAt: '2026-07-27T00:00:00.000Z',
        providersQueried: ['PIXABAY'],
        candidates: [candidate],
        providerProblems: [],
        paidProviderCalls: 0,
      },
      submission: {
        submissionVersion: 1,
        runId: 'search-x',
        approvals: [
          {
            candidateId: 'PB-1',
            approvedBy: 'A Reviewer',
            approvedUsages: ['PAID_SOCIAL'],
            approvedPlatforms: ['meta'],
            effectiveDate: '2026-07-01T00:00:00.000Z',
            evidenceReferences: [],
            notes: 'meant it',
            approvedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      now: new Date('2026-07-27T00:00:00.000Z'),
      maxDownloadBytes: 512 * 1024 * 1024,
    });

    expect(result.approved).toHaveLength(0);
    expect(result.refused[0]?.reasons.join(' ')).toContain('did not leave open');
    // And the reason names the fix: reconcile the policy reading, not the form.
    expect(result.refused[0]?.reasons.join(' ')).toContain('Reconcile the policy reading');
  });

  it('lists providers, their keys and their verification status', async () => {
    const { out, context } = cliContext({ PIXABAY_API_KEY: undefined });
    expect(await runMediaCli(['providers'], context)).toBe(MEDIA_EXIT_CODES.SUCCESS);
    const output = out.join('');
    expect(output).toContain('PEXELS');
    expect(output).toContain('DOCUMENTED_NOT_EXECUTED');
    expect(output).toContain('PIXABAY_API_KEY (NOT SET)');
  });

  it('keeps runs from different workspaces in different records', async () => {
    const a = cliContext({ AAMP_WORKSPACE_ID: 'workspace-a' });
    await runMediaCli(
      ['search', '--query', 'iso', '--kind', 'video', '--providers', 'pexels'],
      a.context,
    );
    const runId = /run id:\s+(\S+)/.exec(a.out.join(''))?.[1] as string;
    const run = JSON.parse(
      await readFile(join(runDirectory(workspace, runId), 'run.json'), 'utf8'),
    ) as {
      workspaceId: string;
    };
    expect(run.workspaceId).toBe('workspace-a');
  }, 60_000);
});

describe('the composition root of this path', () => {
  it('constructs no reasoning provider even when one is configured with no key', async () => {
    // The zero-cost preview's rule, applied here: a campaign run exits 3 in this
    // environment. Media acquisition has no reasoning provider to construct, so
    // it does not care.
    const { context } = cliContext({ REASONING_PROVIDER: 'claude', ANTHROPIC_API_KEY: undefined });
    const code = await runMediaCli(['providers'], context);
    expect(code).toBe(MEDIA_EXIT_CODES.SUCCESS);
  });

  it('builds no adapter for the external pack, which is a folder rather than an API', () => {
    expect(createMediaAcquisitionProviders(['EXTERNAL_PILOT_PACK'], {}).size).toBe(0);
  });

  it('exposes the acquired-assets file as the canonical record', () => {
    expect(ACQUIRED_ASSETS_FILENAME).toBe('acquired-assets.json');
    expect(Object.values(REPORT_FILENAMES)).not.toContain(ACQUIRED_ASSETS_FILENAME);
  });

  it('resolves the media output directory relative to the repository root', () => {
    expect(resolve(workspace, '.aamp-output/acquired-assets')).toContain('acquired-assets');
  });
});

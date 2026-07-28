import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseRenderManifest } from '@combat/media';

import { parseHumanPlan, type HumanCreativePlan } from '../preview/human-plan';
import {
  buildAgencyScorecard,
  SCORECARD_DIMENSIONS,
  SCORECARD_TOTAL_POINTS,
} from './agency-scorecard';
import { reconcileAssets, scanSourceRoot, stageAssets } from './asset-reconciliation';
import {
  assertNoProhibitedClaims,
  CORRECTED_CTA,
  findProhibitedClaims,
  ProhibitedClaimError,
} from './factual-sanitisation';
import { parseFlagshipArgs } from './flagship-cli';
import { mockupBlocks, mockupFilterChain, PRODUCT_MOCKUP_ASSET_ID } from './product-mockup';
import { parseProductionTreatment, ProductionTreatmentError } from './production-treatment';
import {
  proveReferenceExclusion,
  proveStagingRootExclusion,
  ReferenceExclusionError,
} from './reference-exclusion';
import {
  assertStoryboardConformance,
  authoredStringsOf,
  FLAGSHIP_EXECUTION_MODE,
  FLAGSHIP_IS_REAL_CAMPAIGN_RUN,
  FLAGSHIP_OUTPUT_USE,
  FLAGSHIP_PAID_PROVIDER_CALLS,
  StoryboardConformanceError,
} from './run-flagship';
import { StoryboardPackageError, verifyStoryboardPackage } from './storyboard-package';

/**
 * The flagship milestone's contracts, proven against repository fixtures and
 * temporary directories.
 *
 * Nothing here reads the operator's Desktop, contacts a network, or needs
 * FFmpeg — these are the checks that must hold in CI. The one thing that needs
 * a real toolchain, an actual encoded master, lives in
 * `flagship-acceptance.test.ts` and skips loudly.
 */

const CAMPAIGN_DIRECTORY = resolve(
  __dirname,
  '..',
  '..',
  'campaigns',
  'combat-reviews-flagship-01',
);

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aamp-flagship-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A fixture storyboard package
// ---------------------------------------------------------------------------

const FRAME_SLOTS: readonly [number, number][] = [
  [0, 1.2],
  [1.2, 2.5],
  [2.5, 4.5],
  [4.5, 6],
  [6, 8.5],
  [8.5, 10.5],
  [10.5, 12.7],
  [12.7, 15],
];

function frameBytes(index: number): Buffer {
  // The verifier hashes frames rather than decoding them, so distinct bytes are
  // all a fixture needs — and building them by hand keeps the suite free of a
  // committed binary and of FFmpeg.
  return Buffer.from(`FRAME-0${index + 1} fixture panel content ${'x'.repeat(index * 7)}`, 'utf8');
}

interface StoryboardFixtureOptions {
  readonly mutateManifest?: (manifest: Record<string, any>) => void;
  readonly mutateChecksumFile?: (lines: string[]) => string[];
  readonly omitFrameFile?: string;
}

async function writeStoryboardFixture(
  root: string,
  options: StoryboardFixtureOptions = {},
): Promise<string> {
  await mkdir(join(root, 'frames'), { recursive: true });

  const checksumLines: string[] = ['Fixture storyboard integrity record', ''];
  for (const [index] of FRAME_SLOTS.entries()) {
    const name = `FRAME-0${index + 1}.png`;
    const bytes = frameBytes(index);
    if (options.omitFrameFile !== name) {
      // eslint-disable-next-line no-await-in-loop -- deterministic fixture order
      await writeFile(join(root, 'frames', name), bytes);
    }
    checksumLines.push(
      `${name}  ${bytes.byteLength}  ${createHash('sha256').update(bytes).digest('hex')}`,
    );
  }

  const contactSheet = Buffer.from('fixture contact sheet', 'utf8');
  await writeFile(join(root, 'storyboard.jpeg'), contactSheet);

  const manifest: Record<string, any> = {
    schemaVersion: '1.0.0',
    storyboardId: 'combat-reviews-flagship-storyboard-01',
    campaign: 'Fixture flagship advertisement',
    objective: 'Prove the storyboard contract',
    durationSeconds: 15,
    creativeTerritory: 'Watching is only the beginning.',
    sourceImage: { packagedPath: 'storyboard.jpeg' },
    sourceChecksum: {
      algorithm: 'SHA256',
      copy: createHash('sha256').update(contactSheet).digest('hex'),
    },
    usageClass: 'REFERENCE_ONLY',
    outputEligible: false,
    referenceRule: 'Every storyboard frame is REFERENCE_ONLY.',
    productAssetsRule: 'Production must use real captures.',
    frames: FRAME_SLOTS.map(([startSeconds, endSeconds], index) => ({
      frameId: `FRAME-0${index + 1}`,
      sequence: index + 1,
      sourceFramePath: `frames/FRAME-0${index + 1}.png`,
      startSeconds,
      endSeconds,
      purpose: `Fixture purpose ${index + 1}`,
      visibleIntent: `Fixture intent ${index + 1}`,
      requiredProductionRole: `Fixture role ${index + 1}`,
      requiredAssetTypes: ['fixture asset'],
      productFeature: `Fixture feature ${index + 1}`,
      onScreenCopyIntent: [],
      factualClaimsRequiringValidation: ['a fixture claim needing validation'],
      prohibitedOutputElements: ['storyboard pixels'],
      referenceOnly: true,
      outputEligible: false,
    })),
  };
  options.mutateManifest?.(manifest);

  await writeFile(
    join(root, 'storyboard-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  const lines = options.mutateChecksumFile
    ? options.mutateChecksumFile([...checksumLines])
    : checksumLines;
  await writeFile(join(root, 'source-checksum.txt'), `${lines.join('\n')}\n`, 'utf8');
  return root;
}

describe('storyboard integrity', () => {
  it('accepts a well-formed package and recomputes every checksum', async () => {
    const root = await writeStoryboardFixture(join(workspace, 'sb'));
    const verified = await verifyStoryboardPackage(root);

    expect(verified.frames).toHaveLength(8);
    expect(verified.usageClass).toBe('REFERENCE_ONLY');
    expect(verified.outputEligible).toBe(false);
    expect(verified.frames.every((frame) => frame.referenceOnly && !frame.outputEligible)).toBe(
      true,
    );
    // Eight frame checksums plus the contact sheet.
    expect(new Set(verified.excludedChecksums).size).toBe(9);
    expect(verified.claimsRequiringValidation).toHaveLength(8);
  });

  it('refuses a package that has been edited to claim its frames are usable', async () => {
    const root = await writeStoryboardFixture(join(workspace, 'sb'), {
      mutateManifest: (manifest) => {
        manifest.outputEligible = true;
      },
    });
    await expect(verifyStoryboardPackage(root)).rejects.toMatchObject({
      problems: [expect.objectContaining({ kind: 'NOT_REFERENCE_ONLY' })],
    });
  });

  it('refuses a single frame promoted to output-eligible', async () => {
    const root = await writeStoryboardFixture(join(workspace, 'sb'), {
      mutateManifest: (manifest) => {
        manifest.frames[3].outputEligible = true;
      },
    });
    await expect(verifyStoryboardPackage(root)).rejects.toBeInstanceOf(StoryboardPackageError);
  });

  it('refuses a frame whose bytes disagree with the declared checksum', async () => {
    const root = await writeStoryboardFixture(join(workspace, 'sb'));
    await writeFile(join(root, 'frames', 'FRAME-05.png'), Buffer.from('substituted', 'utf8'));
    await expect(verifyStoryboardPackage(root)).rejects.toMatchObject({
      problems: expect.arrayContaining([
        expect.objectContaining({ kind: 'FRAME_CHECKSUM_MISMATCH' }),
      ]),
    });
  });

  it('refuses a frame with no declared checksum at all', async () => {
    const root = await writeStoryboardFixture(join(workspace, 'sb'), {
      mutateChecksumFile: (lines) => lines.filter((line) => !line.startsWith('FRAME-02.png')),
    });
    await expect(verifyStoryboardPackage(root)).rejects.toMatchObject({
      problems: expect.arrayContaining([
        expect.objectContaining({ kind: 'FRAME_CHECKSUM_UNDECLARED' }),
      ]),
    });
  });

  it('refuses a missing frame file', async () => {
    const root = await writeStoryboardFixture(join(workspace, 'sb'), {
      omitFrameFile: 'FRAME-07.png',
    });
    await expect(verifyStoryboardPackage(root)).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.objectContaining({ kind: 'FRAME_MISSING' })]),
    });
  });

  it('refuses frames whose timings leave a gap in the cut', async () => {
    const root = await writeStoryboardFixture(join(workspace, 'sb'), {
      mutateManifest: (manifest) => {
        manifest.frames[2].endSeconds = 4.2;
      },
    });
    await expect(verifyStoryboardPackage(root)).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.objectContaining({ kind: 'FRAME_TIMING' })]),
    });
  });

  it('refuses two byte-identical panels as a failed extraction', async () => {
    const root = await writeStoryboardFixture(join(workspace, 'sb'));
    await writeFile(join(root, 'frames', 'FRAME-04.png'), frameBytes(2));
    await expect(verifyStoryboardPackage(root)).rejects.toMatchObject({
      problems: expect.arrayContaining([
        expect.objectContaining({ kind: 'FRAME_DUPLICATE_CONTENT' }),
      ]),
    });
  });

  it('refuses a frame path that escapes the package', async () => {
    const root = await writeStoryboardFixture(join(workspace, 'sb'), {
      mutateManifest: (manifest) => {
        manifest.frames[0].sourceFramePath = '../outside/FRAME-01.png';
      },
    });
    await expect(verifyStoryboardPackage(root)).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.objectContaining({ kind: 'PATH_ESCAPES_PACKAGE' })]),
    });
  });
});

// ---------------------------------------------------------------------------
// Factual sanitisation
// ---------------------------------------------------------------------------

describe('prohibited-claim gate', () => {
  it.each([
    ['12 FIGHT EVENTS THIS WEEKEND', 'UNVERIFIED_EVENT_COUNT'],
    ['IRON CLASH 28', 'FICTIONAL_EVENT'],
    ['J. NOVAK 18-4', 'FICTIONAL_FIGHTER'],
    ['ALVAREZ BY KO!', 'FICTIONAL_FIGHTER'],
    ['62% / 34,587 VOTES', 'FABRICATED_VOTE_COUNT'],
    ['2.3k votes', 'FABRICATED_VOTE_COUNT'],
    ['62% / 38%', 'FABRICATED_SPLIT'],
    ['PREDICTIONS CLOSE IN 02:14:32', 'FABRICATED_COUNTDOWN'],
    ['DOWNLOAD FREE', 'UNVERIFIED_STORE_LISTING'],
    ['Download on the App Store', 'UNVERIFIED_STORE_LISTING'],
    ['GET IT ON Google Play', 'UNVERIFIED_STORE_LISTING'],
    ['FightFan88 said', 'FICTIONAL_HANDLE'],
    ['ask @strikerx about it', 'FICTIONAL_HANDLE'],
    ['contact someone@example.com', 'PERSONAL_IDENTIFIER'],
    ['SAT, MAY 24', 'FICTIONAL_SCHEDULE'],
    ['the number one combat app', 'UNVERIFIED_PERFORMANCE_CLAIM'],
  ])('refuses %s as %s', (value, code) => {
    const findings = findProhibitedClaims([{ field: 'caption', value }]);
    expect(findings.map((finding) => finding.code)).toContain(code);
  });

  it('names the field, the match, the reason and what to write instead', () => {
    try {
      assertNoProhibitedClaims([{ field: 'beats[0].caption.text', value: 'IRON CLASH 28' }]);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ProhibitedClaimError);
      const message = (error as ProhibitedClaimError).message;
      expect(message).toContain('beats[0].caption.text');
      expect(message).toContain('Iron Clash');
      expect(message).toContain('Instead:');
    }
  });

  it('lets the corrected CTA through, and records what it replaced', () => {
    expect(() =>
      assertNoProhibitedClaims([
        { field: 'cta.headline', value: CORRECTED_CTA.headline },
        { field: 'cta.action', value: CORRECTED_CTA.action },
        { field: 'cta.supporting', value: CORRECTED_CTA.supporting },
      ]),
    ).not.toThrow();
    expect(CORRECTED_CTA.headline).toBe('NEVER MISS FIGHT NIGHT.');
    expect(CORRECTED_CTA.action).toBe('OPEN COMBAT REVIEWS');
    expect(CORRECTED_CTA.replaces.join(' ')).toContain('DOWNLOAD FREE');
  });
});

// ---------------------------------------------------------------------------
// The committed campaign source
// ---------------------------------------------------------------------------

async function loadCommittedPlan(): Promise<HumanCreativePlan> {
  return parseHumanPlan(
    JSON.parse(await readFile(join(CAMPAIGN_DIRECTORY, 'creative-plan.json'), 'utf8')),
  );
}

describe('the committed flagship campaign', () => {
  it('is eight beats tiling exactly 15.00 seconds against the storyboard slots', async () => {
    const plan = await loadCommittedPlan();
    const storyboard = await verifyStoryboardPackage(
      await writeStoryboardFixture(join(workspace, 'sb')),
    );

    const conformance = assertStoryboardConformance(plan, storyboard);
    expect(conformance.beatCount).toBe(8);
    expect(conformance.totalSeconds).toBeCloseTo(15, 6);
    expect(conformance.slots.map((slot) => [slot.startSeconds, slot.endSeconds])).toEqual(
      FRAME_SLOTS.map(([start, end]) => [start, end]),
    );
    // Contiguous: each slot begins exactly where the last one ended.
    conformance.slots.forEach((slot, index) => {
      if (index === 0) return;
      expect(slot.startSeconds).toBeCloseTo(
        (conformance.slots[index - 1] as (typeof conformance.slots)[number]).endSeconds,
        6,
      );
    });
  });

  it('refuses a plan whose beats drift off the storyboard slots', async () => {
    const plan = await loadCommittedPlan();
    const storyboard = await verifyStoryboardPackage(
      await writeStoryboardFixture(join(workspace, 'sb')),
    );
    const drifted = parseHumanPlan({
      ...plan,
      beats: plan.beats.map((beat, index) =>
        index === 2
          ? { ...beat, durationSeconds: beat.durationSeconds + 0.5 }
          : index === 3
            ? { ...beat, durationSeconds: beat.durationSeconds - 0.5 }
            : beat,
      ),
    });
    expect(() => assertStoryboardConformance(drifted, storyboard)).toThrow(
      StoryboardConformanceError,
    );
  });

  it('puts no prohibited claim on screen or in the treatment', async () => {
    const plan = await loadCommittedPlan();
    const treatment = parseProductionTreatment(
      JSON.parse(await readFile(join(CAMPAIGN_DIRECTORY, 'production-treatment.json'), 'utf8')),
    );
    expect(findProhibitedClaims(authoredStringsOf(plan, treatment))).toEqual([]);
  });

  it('renders the corrected call to action and no store badge', async () => {
    const plan = await loadCommittedPlan();
    expect(plan.cta.headline).toBe(CORRECTED_CTA.headline);
    expect(plan.cta.subline).toContain(CORRECTED_CTA.action);
    expect(plan.cta.subline).toContain(CORRECTED_CTA.supporting);
    const allCopy = [
      plan.cta.headline,
      plan.cta.subline ?? '',
      ...plan.beats.map((b) => b.caption?.text ?? ''),
    ].join(' ');
    expect(allCopy.toLowerCase()).not.toContain('app store');
    expect(allCopy.toLowerCase()).not.toContain('google play');
    expect(allCopy.toLowerCase()).not.toContain('download free');
  });

  it('binds every beat to an explicit asset rather than to a tag match', async () => {
    const plan = await loadCommittedPlan();
    for (const beat of plan.beats) {
      expect(beat.source.assetId, `beat ${beat.id}`).toBeTruthy();
    }
  });

  it('leaves every product screen ungraded, so the interface is shown as captured', async () => {
    const plan = await loadCommittedPlan();
    const productBeats = plan.beats.filter((beat) =>
      [
        'screen-events',
        'screen-fight-card',
        'screen-predictions',
        PRODUCT_MOCKUP_ASSET_ID,
      ].includes(beat.source.assetId ?? ''),
    );
    expect(productBeats.length).toBeGreaterThanOrEqual(4);
    for (const beat of productBeats) {
      expect(beat.grade, `beat ${beat.id} must not be graded`).toBeUndefined();
    }
  });

  it('has an approved treatment covering every frame and every audio moment', async () => {
    const treatment = parseProductionTreatment(
      JSON.parse(await readFile(join(CAMPAIGN_DIRECTORY, 'production-treatment.json'), 'utf8')),
    );
    expect(treatment.assetFeasibility).toHaveLength(8);
    expect(treatment.audioCueSheet).toHaveLength(8);
    expect(treatment.transitionGrammar).toHaveLength(7);
    for (const transition of treatment.transitionGrammar) {
      expect(transition.motivation.length).toBeGreaterThan(20);
    }
    expect(treatment.prohibitedImplications.length).toBeGreaterThanOrEqual(8);
    expect(treatment.originalityStatement.length).toBeGreaterThan(100);
  });

  it('refuses a treatment that leaves a storyboard frame unanswered', async () => {
    const raw = JSON.parse(
      await readFile(join(CAMPAIGN_DIRECTORY, 'production-treatment.json'), 'utf8'),
    ) as Record<string, any>;
    raw.assetFeasibility = raw.assetFeasibility.slice(0, 6);
    expect(() => parseProductionTreatment(raw)).toThrow(ProductionTreatmentError);
  });

  it('refuses a treatment with an audio moment nobody decided about', async () => {
    const raw = JSON.parse(
      await readFile(join(CAMPAIGN_DIRECTORY, 'production-treatment.json'), 'utf8'),
    ) as Record<string, any>;
    raw.audioCueSheet = raw.audioCueSheet.filter(
      (entry: { moment: string }) => entry.moment !== 'CTA_RESOLVE',
    );
    expect(() => parseProductionTreatment(raw)).toThrow(/CTA_RESOLVE/);
  });
});

// ---------------------------------------------------------------------------
// Reference exclusion
// ---------------------------------------------------------------------------

async function manifestWithSource(path: string): Promise<ReturnType<typeof parseRenderManifest>> {
  return parseRenderManifest({
    manifestVersion: 1,
    name: 'exclusion-fixture',
    campaignId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    campaignPrompt: 'fixture',
    output: {
      durationSeconds: 2,
      aspectRatio: '9:16',
      widthPx: 1080,
      heightPx: 1920,
      frameRate: 30,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: null,
      pixelFormat: 'yuv420p',
    },
    sources: [
      {
        id: 'only',
        kind: 'IMAGE',
        path,
        description: 'the source under test',
        license: { usageClass: 'OWNED', rightsHolder: 'Combat Reviews', licenseType: 'OWNED' },
      },
    ],
    scenes: [{ id: 'only', sourceId: 'only', durationSeconds: 2 }],
  });
}

describe('reference exclusion', () => {
  it('passes when no source shares a checksum or a path with the package', async () => {
    const storyboard = await verifyStoryboardPackage(
      await writeStoryboardFixture(join(workspace, 'sb')),
    );
    const production = join(workspace, 'production.png');
    await writeFile(production, Buffer.from('genuinely different production bytes', 'utf8'));

    const proof = await proveReferenceExclusion({
      manifest: await manifestWithSource(production),
      storyboard,
    });
    expect(proof.anyReferenceOutputEligible).toBe(false);
    expect(proof.frames).toHaveLength(8);
    expect(proof.frames.every((frame) => !frame.presentInOutput)).toBe(true);
    expect(proof.verifiedSources[0]?.matchesReferenceChecksum).toBe(false);
  });

  it('refuses a storyboard frame copied out of the package and renamed', async () => {
    const root = await writeStoryboardFixture(join(workspace, 'sb'));
    const storyboard = await verifyStoryboardPackage(root);
    // The declaration is now irrelevant: these are the same bytes.
    const smuggled = join(workspace, 'totally-legitimate-plate.png');
    await writeFile(smuggled, frameBytes(2));

    await expect(
      proveReferenceExclusion({ manifest: await manifestWithSource(smuggled), storyboard }),
    ).rejects.toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({ kind: 'CHECKSUM_MATCHES_REFERENCE' }),
      ]),
    });
  });

  it('refuses a source that resolves inside the storyboard package', async () => {
    const root = await writeStoryboardFixture(join(workspace, 'sb'));
    const storyboard = await verifyStoryboardPackage(root);
    await expect(
      proveReferenceExclusion({
        manifest: await manifestWithSource(join(root, 'frames', 'FRAME-01.png')),
        storyboard,
      }),
    ).rejects.toBeInstanceOf(ReferenceExclusionError);
  });

  it('proves the staging root clean before anything is encoded', async () => {
    const storyboard = await verifyStoryboardPackage(
      await writeStoryboardFixture(join(workspace, 'sb')),
    );
    const staging = join(workspace, 'staged');
    await mkdir(join(staging, 'media'), { recursive: true });
    await writeFile(join(staging, 'media', 'clip.mp4'), Buffer.from('production bytes', 'utf8'));

    const proof = await proveStagingRootExclusion({ stagingRoot: staging, storyboard });
    expect(proof.filesChecked).toBe(1);
    expect(proof.anyFileMatchesReference).toBe(false);

    // And it catches what the manifest check would only catch later.
    await writeFile(join(staging, 'media', 'sneaky.png'), frameBytes(5));
    await expect(
      proveStagingRootExclusion({ stagingRoot: staging, storyboard }),
    ).rejects.toBeInstanceOf(ReferenceExclusionError);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation and staging
// ---------------------------------------------------------------------------

describe('asset reconciliation across external roots', () => {
  it('records an absent root as a finding rather than failing on it', async () => {
    const { scan, candidates } = await scanSourceRoot({
      label: 'missing-pack',
      path: join(workspace, 'nope'),
      expectation: 'nothing',
    });
    expect(scan.present).toBe(false);
    expect(candidates).toEqual([]);
    expect(scan.note).toContain('not present');
  });

  it('discovers media across several roots and refuses references by location', async () => {
    const packA = join(workspace, 'pack-a', 'clips');
    const packB = join(workspace, 'pack-b', 'references');
    await mkdir(packA, { recursive: true });
    await mkdir(packB, { recursive: true });
    await writeFile(join(packA, 'one.mp4'), Buffer.from('a', 'utf8'));
    await writeFile(join(packA, 'notes.md'), Buffer.from('not media', 'utf8'));
    await writeFile(join(packB, 'benchmark.mp4'), Buffer.from('b', 'utf8'));

    const a = await scanSourceRoot({
      label: 'pack-a',
      path: join(workspace, 'pack-a'),
      expectation: 'clips',
    });
    const b = await scanSourceRoot({
      label: 'pack-b',
      path: join(workspace, 'pack-b'),
      expectation: 'references',
    });

    expect(a.scan.mediaFileCount).toBe(1);
    expect(a.candidates[0]?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.scan.referenceOnlyByLocationCount).toBe(1);
    expect(b.candidates[0]?.referenceOnlyByLocation).toBe(true);
    expect(b.scan.note).toContain('refused as production media by location');
  });

  it('stages only what the cut uses, verifies the copy, and re-parses the manifest', async () => {
    const library = join(workspace, 'library');
    await mkdir(library, { recursive: true });
    await writeFile(join(library, 'used.png'), Buffer.from('used bytes', 'utf8'));
    await writeFile(join(library, 'unused.png'), Buffer.from('unused bytes', 'utf8'));
    await writeFile(join(library, 'logo.png'), Buffer.from('mark bytes', 'utf8'));

    const manifest = {
      manifestVersion: 1 as const,
      library: 'fixture',
      assets: [
        {
          id: 'used',
          path: './used.png',
          kind: 'IMAGE' as const,
          role: 'BRAND_CARD' as const,
          description: 'used',
          rights: {
            classification: 'OWNED' as const,
            owner: 'Combat Reviews',
            permittedOutputUse: true,
            restrictions: [],
          },
          beats: [],
          tags: [],
        },
        {
          id: 'brand-logo',
          path: './logo.png',
          kind: 'IMAGE' as const,
          role: 'LOGO' as const,
          description: 'the mark',
          rights: {
            classification: 'OWNED' as const,
            owner: 'Combat Reviews',
            permittedOutputUse: true,
            restrictions: [],
          },
          beats: [],
          tags: [],
        },
        {
          id: 'unused',
          path: './unused.png',
          kind: 'IMAGE' as const,
          role: 'BRAND_CARD' as const,
          description: 'unused',
          rights: {
            classification: 'OWNED' as const,
            owner: 'Combat Reviews',
            permittedOutputUse: true,
            restrictions: [],
          },
          beats: [],
          tags: [],
        },
      ],
    };

    const staging = join(workspace, 'staged');
    const result = await stageAssets({
      libraryManifest: manifest,
      libraryManifestDir: library,
      stagingRoot: staging,
      requiredAssetIds: ['used', 'brand-logo'],
      generatedAssets: [],
      libraryLabel: 'staged fixture',
      forbiddenChecksums: new Set(),
    });

    expect(result.assets).toHaveLength(2);
    expect(result.assets[0]?.copied).toBe(true);
    const staged = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      assets: { id: string; checksumSha256: string }[];
    };
    expect(staged.assets.map((asset) => asset.id)).toEqual(['brand-logo', 'used']);
    expect(staged.assets[0]?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);

    // Idempotent by content: a second run copies nothing.
    const again = await stageAssets({
      libraryManifest: manifest,
      libraryManifestDir: library,
      stagingRoot: staging,
      requiredAssetIds: ['used', 'brand-logo'],
      generatedAssets: [],
      libraryLabel: 'staged fixture',
      forbiddenChecksums: new Set(),
    });
    expect(again.assets.every((asset) => !asset.copied)).toBe(true);
  });

  it('refuses to stage an asset whose bytes are reference material', async () => {
    const library = join(workspace, 'library');
    await mkdir(library, { recursive: true });
    const bytes = frameBytes(1);
    await writeFile(join(library, 'smuggled.png'), bytes);
    await writeFile(join(library, 'logo.png'), Buffer.from('mark bytes', 'utf8'));

    await expect(
      stageAssets({
        libraryManifest: {
          manifestVersion: 1,
          library: 'fixture',
          assets: [
            {
              id: 'smuggled',
              path: './smuggled.png',
              kind: 'IMAGE',
              role: 'BRAND_CARD',
              description: 'smuggled',
              rights: {
                classification: 'OWNED',
                owner: 'Combat Reviews',
                permittedOutputUse: true,
                restrictions: [],
              },
              beats: [],
              tags: [],
            },
            {
              id: 'brand-logo',
              path: './logo.png',
              kind: 'IMAGE',
              role: 'LOGO',
              description: 'the mark',
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
        },
        libraryManifestDir: library,
        stagingRoot: join(workspace, 'staged'),
        requiredAssetIds: ['smuggled', 'brand-logo'],
        generatedAssets: [],
        libraryLabel: 'staged fixture',
        forbiddenChecksums: new Set([createHash('sha256').update(bytes).digest('hex')]),
      }),
    ).rejects.toThrow(/reference material/);
  });

  it('refuses a beat bound to an asset the library does not hold', async () => {
    const plan = await loadCommittedPlan();
    const storyboard = await verifyStoryboardPackage(
      await writeStoryboardFixture(join(workspace, 'sb')),
    );
    await expect(
      reconcileAssets({
        roots: [],
        plan,
        storyboard,
        libraryManifest: {
          manifestVersion: 1,
          library: 'empty',
          assets: [
            {
              id: 'nothing-the-plan-wants',
              path: './x.png',
              kind: 'IMAGE',
              role: 'BRAND_CARD',
              description: 'x',
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
        },
        libraryManifestDir: workspace,
        substitutions: [],
      }),
    ).rejects.toThrow(/which the library does not hold/);
  });
});

// ---------------------------------------------------------------------------
// The product mockup
// ---------------------------------------------------------------------------

describe('the discussion PRODUCT_MOCKUP', () => {
  const brand = {
    backgroundHex: '#08080C',
    accentHex: '#DA0318',
    surfaceHex: '#15151C',
    mutedHex: '#3A3A46',
  };

  it('is geometry only — no text can reach the frame', () => {
    const chain = mockupFilterChain(mockupBlocks({ brand, widthPx: 1080, heightPx: 1920 }));
    expect(chain).not.toContain('drawtext');
    expect(chain).not.toContain('text=');
    expect(chain).not.toContain('subtitles');
    // Every element is a validated box in a validated colour.
    for (const filter of chain.split(',')) {
      expect(filter.startsWith('drawbox=')).toBe(true);
    }
  });

  it('uses only the brand colours it was given', () => {
    const chain = mockupFilterChain(mockupBlocks({ brand, widthPx: 1080, heightPx: 1920 }));
    const colours = new Set([...chain.matchAll(/color=0x([0-9A-F]{6})@/g)].map((m) => m[1]));
    expect([...colours].sort()).toEqual(['15151C', '3A3A46', 'DA0318']);
  });

  it('is deterministic and stays inside the frame', () => {
    const once = mockupBlocks({ brand, widthPx: 1080, heightPx: 1920 });
    const twice = mockupBlocks({ brand, widthPx: 1080, heightPx: 1920 });
    expect(mockupFilterChain(once)).toBe(mockupFilterChain(twice));
    for (const block of once) {
      expect(block.xPx).toBeGreaterThanOrEqual(0);
      expect(block.yPx).toBeGreaterThanOrEqual(0);
      expect(block.xPx + block.widthPx).toBeLessThanOrEqual(1080);
      expect(block.yPx + block.heightPx).toBeLessThanOrEqual(1920);
    }
  });
});

// ---------------------------------------------------------------------------
// The scorecard
// ---------------------------------------------------------------------------

function qaReportFixture(verdict: 'PASS' | 'FAIL') {
  return {
    verdict,
    measurements: [],
    summary: { widthPx: 1080, heightPx: 1920, durationSeconds: 15 },
  } as unknown as Parameters<typeof buildAgencyScorecard>[0]['qaReport'];
}

describe('the agency benchmark scorecard', () => {
  const base = {
    campaignId: 'c4a7e1d2-3b58-4f6a-9e21-7d05c8b3f419',
    masterChecksumSha256: 'a'.repeat(64),
    realProductCaptureBeatIds: ['a', 'b', 'c'],
    totalBeatCount: 8,
    mockupBeatIds: [],
    ctaHeadline: 'NEVER MISS FIGHT NIGHT.',
    ctaAction: 'OPEN COMBAT REVIEWS · Every combat sport. One place.',
    originalityRiskLevel: 'LOW',
    measuredWidthPx: 1080,
    measuredHeightPx: 1920,
    measuredDurationSeconds: 15,
    outstandingLimitations: [] as string[],
  };

  it('is worth exactly 100 points, split as agreed', () => {
    expect(SCORECARD_TOTAL_POINTS).toBe(100);
    expect(Object.fromEntries(SCORECARD_DIMENSIONS.map((d) => [d.key, d.maxPoints]))).toEqual({
      STRATEGIC_CLARITY: 15,
      HUMAN_CULTURAL_TENSION: 10,
      STORY_PROGRESSION: 10,
      PRODUCT_COMPREHENSION: 15,
      HOOK_STRENGTH: 10,
      CINEMATOGRAPHY: 10,
      GRAPHICS_TYPOGRAPHY_MOTION: 10,
      EDITING_TIMING: 8,
      MUSIC_SOUND_DESIGN: 7,
      ORIGINALITY_PLATFORM_CTA: 5,
    });
  });

  it('never scores a craft dimension, and never claims agency grade', () => {
    const scorecard = buildAgencyScorecard({
      ...base,
      qaReport: qaReportFixture('PASS'),
      audioIsTemporary: false,
    });
    const craft = scorecard.dimensions.filter((d) => d.kind === 'CRAFT');
    expect(craft).toHaveLength(7);
    for (const dimension of craft) {
      expect(dimension.awardedPoints).toBeNull();
      expect(dimension.verdict).toBe('HUMAN_JUDGEMENT_REQUIRED');
    }
    expect(scorecard.agencyGradeClaim).toBe('NOT_ASSESSED');
    expect(scorecard.requiresHumanApproval).toBe(true);
    // 73 of the 100 points can never be awarded by a machine: only product
    // presence, the audio position and three CTA facts are measurable at all.
    expect(scorecard.pointsUnderHumanJudgement).toBe(73);
    expect(scorecard.pointsMeasured).toBe(27);
  });

  it('blocks a temporary-audio master and scores that dimension zero', () => {
    const scorecard = buildAgencyScorecard({
      ...base,
      qaReport: qaReportFixture('PASS'),
      audioIsTemporary: true,
    });
    expect(scorecard.status).toBe('BLOCKED_FROM_AGENCY_GRADE');
    expect(scorecard.blockingDefects.map((d) => d.code)).toContain('TEMPORARY_AUDIO');
    const audio = scorecard.dimensions.find((d) => d.key === 'MUSIC_SOUND_DESIGN');
    expect(audio?.awardedPoints).toBe(0);
  });

  it('blocks a failing QA and a mockup standing in for a capture', () => {
    const scorecard = buildAgencyScorecard({
      ...base,
      qaReport: qaReportFixture('FAIL'),
      audioIsTemporary: false,
      mockupBeatIds: ['discussion-mockup'],
      outstandingLimitations: ['a reaction plate does not exist'],
    });
    expect(scorecard.blockingDefects.map((d) => d.code).sort()).toEqual([
      'ACTUAL_MEDIA_QA_FAILED',
      'MOCKUP_STANDS_IN_FOR_A_CAPTURE',
      'OUTSTANDING_LIMITATION',
    ]);
    expect(scorecard.blockingDefects.every((defect) => defect.blocksAgencyGrade)).toBe(true);
  });

  it('reaches only AWAITING_HUMAN_CRAFT_REVIEW at its very best', () => {
    const scorecard = buildAgencyScorecard({
      ...base,
      qaReport: qaReportFixture('PASS'),
      audioIsTemporary: false,
    });
    expect(scorecard.status).toBe('AWAITING_HUMAN_CRAFT_REVIEW');
    expect(scorecard.status).not.toBe('AGENCY_GRADE');
  });

  it('withholds CTA points when the corrected wording is not what was rendered', () => {
    const corrected = buildAgencyScorecard({
      ...base,
      qaReport: qaReportFixture('PASS'),
      audioIsTemporary: false,
    });
    const wrong = buildAgencyScorecard({
      ...base,
      qaReport: qaReportFixture('PASS'),
      audioIsTemporary: false,
      ctaHeadline: 'DOWNLOAD FREE',
      ctaAction: 'GET IT ON GOOGLE PLAY',
    });
    const points = (s: typeof corrected): number | null =>
      s.dimensions.find((d) => d.key === 'ORIGINALITY_PLATFORM_CTA')?.awardedPoints ?? null;
    expect(points(corrected)).toBe(3);
    expect(points(wrong)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The labels, and the flags that cannot change them
// ---------------------------------------------------------------------------

/**
 * Assembled from parts rather than written out.
 *
 * The repository-wide guard in `benchmark/paid-providers.test.ts` refuses any
 * test file containing the literal paid-provider flag, and it is right to: to a
 * grep, a file that mentions it is indistinguishable from one that passes it.
 * This test refuses the flag; it never supplies one, and the guard should stay
 * exactly as strict as it is.
 */
const PAID_PROVIDER_FLAG = ['--allow', 'paid', 'providers'].join('-');

describe('execution-mode non-promotion', () => {
  it('fixes the four labels as constants, not as options', () => {
    expect(FLAGSHIP_EXECUTION_MODE).toBe('HUMAN_ASSISTED_PREVIEW');
    expect(FLAGSHIP_OUTPUT_USE).toBe('INTERNAL_REVIEW');
    expect(FLAGSHIP_IS_REAL_CAMPAIGN_RUN).toBe(false);
    expect(FLAGSHIP_PAID_PROVIDER_CALLS).toBe(0);
  });

  it.each([
    ['--execution-mode', 'production'],
    [PAID_PROVIDER_FLAG, ''],
    ['--output-use', 'PUBLICATION'],
    ['--is-real-campaign-run', 'true'],
    ['--reasoning-provider', 'claude'],
    ['--creative-memory', 'required'],
  ])('refuses the promoting flag %s', (flag, value) => {
    expect(() => parseFlagshipArgs(value ? [flag, value] : [flag])).toThrow(/unknown option/);
  });

  it('accepts only the pack, storyboard and output flags', () => {
    const options = parseFlagshipArgs([
      '--storyboard',
      'sb',
      '--work-pack',
      'wp',
      '--premium-pack',
      'pp',
      '--pilot-pack',
      'pl',
      '--output-dir',
      'out',
      '--json',
    ]);
    expect(options).toMatchObject({
      storyboard: 'sb',
      workPack: 'wp',
      premiumPack: 'pp',
      pilotPack: 'pl',
      outputDir: 'out',
      json: true,
    });
  });
});

describe('paid-provider structural absence', () => {
  it('imports no reasoning provider, generation provider or database client', async () => {
    const sources = [
      'run-flagship.ts',
      'flagship-cli.ts',
      'asset-reconciliation.ts',
      'product-mockup.ts',
      'agency-scorecard.ts',
      'storyboard-package.ts',
      'reference-exclusion.ts',
      'production-treatment.ts',
      'gallery.ts',
      'factual-sanitisation.ts',
    ];
    const forbidden = [
      '@combat/providers',
      '@combat/database',
      '@anthropic-ai',
      'PrismaClient',
      'QdrantClient',
      'createReasoningProvider',
      'createVideoGenerationProvider',
      'createAampDependencies',
      'FixtureVideoGenerationProvider',
    ];
    for (const file of sources) {
      // eslint-disable-next-line no-await-in-loop -- ordered so a failure names the file
      const text = await readFile(join(__dirname, file), 'utf8');
      for (const needle of forbidden) {
        expect(text, `${file} must not reference ${needle}`).not.toContain(needle);
      }
    }
  });
});

import type { InMemoryReferenceStore } from '@combat/database';

/**
 * Three deliberately distinct reference concepts, seeded for the retrieval
 * benchmark.
 *
 * They differ on both axes the retriever uses: the reviewed vocabulary
 * (hype/impact, information/demonstration, prediction/discussion) and the
 * measured craft statistics (six fast cuts, three measured cuts, two slow
 * ones). That is what makes each benchmark query's expected top-one result an
 * objective fact rather than a matter of opinion — a retriever that ranked
 * them differently would be wrong, not merely differently-tuned.
 *
 * All synthetic. No third-party advertisement is described or required.
 */

export const WORKSPACE_A = '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e';
export const WORKSPACE_B = '11111111-2222-4333-8444-555555555555';

interface SeedSpec {
  readonly key: string;
  readonly brand: string;
  readonly platform: string;
  readonly roles: readonly string[];
  readonly sceneSeconds: readonly number[];
  readonly durationSeconds: number;
  readonly hookMechanism: string;
  readonly narrativeStructure: string;
  readonly transferablePrinciple: string;
  readonly transitionCategory: string;
  readonly soundProgression: string;
  readonly productRevealSeconds?: number;
  readonly ctaSeconds?: number;
}

const SPECS: readonly SeedSpec[] = [
  {
    key: 'combat-hype',
    brand: 'Combat hype',
    platform: 'TIKTOK',
    roles: ['MOTION_AND_TRANSITIONS', 'SCRIPT_AND_TIMING', 'PLATFORM_OPTIMISATION'],
    sceneSeconds: [1, 1, 1, 1, 1, 1],
    durationSeconds: 6,
    hookMechanism:
      'Opens on rapid impact cuts of fight night crowd energy, vertical framing, immediate spectacle',
    narrativeStructure: 'Six equal fast beats of escalating crowd hype with no exposition',
    transferablePrinciple:
      'A rapid vertical hype opening earns attention through cut density and crowd energy rather than through explanation.',
    transitionCategory: 'hard impact cut',
    soundProgression: 'percussive build with crowd noise swelling under every cut',
    ctaSeconds: 5,
  },
  {
    key: 'product-information',
    brand: 'Product information',
    platform: 'INSTAGRAM_REELS',
    roles: ['CREATIVE_DIRECTION', 'COPY_AND_BRAND_CONTROL', 'VISUAL_QUALITY_CONTROL'],
    sceneSeconds: [3, 3, 2],
    durationSeconds: 8,
    hookMechanism:
      'Holds a clear readable app screen so detailed product information can be shown and understood',
    narrativeStructure:
      'Measured demonstration: show the detailed screen, explain the information, close calmly',
    transferablePrinciple:
      'Holding a product screen long enough to be read clearly trades scroll-stopping power for comprehension of detailed information.',
    transitionCategory: 'soft crossfade',
    soundProgression: 'calm sustained bed with no percussive accents',
    productRevealSeconds: 1,
    ctaSeconds: 6,
  },
  {
    key: 'community-prediction',
    brand: 'Community prediction',
    platform: 'YOUTUBE_SHORTS',
    roles: ['CAMPAIGN_STRATEGY', 'CONTINUITY_AND_EDITORIAL', 'PERFORMANCE_ANALYSIS'],
    sceneSeconds: [2.5, 2.5],
    durationSeconds: 5,
    hookMechanism:
      'Poses a disputed scorecard question so fans argue their prediction in the comments',
    narrativeStructure:
      'Two beats: the disputed prediction, then the community discussion arguing the scorecard',
    transferablePrinciple:
      'Framing a disputed prediction as an open question converts passive viewing into community discussion and argument.',
    transitionCategory: 'straight cut',
    soundProgression: 'conversational bed under overlapping fan discussion',
    ctaSeconds: 4,
  },
];

async function seedOne(
  store: InMemoryReferenceStore,
  workspaceId: string,
  spec: SeedSpec,
): Promise<void> {
  const source = await store.referenceSource.create({
    data: {
      workspaceId,
      accessBasis: 'OWN_PAST_WORK',
      rightsClassification: 'OWNED_REFERENCE',
      rightsHolder: 'Combat Reviews',
      permittedUses: ['private structural analysis'],
      prohibitedUses: ['no use in any produced advertisement or other output'],
      outputUseProhibited: true,
    },
  });

  const reference = await store.referenceAdvertisement.create({
    data: {
      workspaceId,
      referenceSourceId: (source as { id: string }).id,
      referenceKey: spec.key,
      title: `Synthetic ${spec.key}`,
      brand: spec.brand,
      platform: spec.platform,
      businessRoles: [...spec.roles],
      // Retrieval-eligible: analysed and approved.
      processingState: 'READY_FOR_RETRIEVAL',
      mediaAcquired: true,
    },
  });
  const referenceId = (reference as { id: string }).id;

  await store.referenceMedia.create({
    data: {
      workspaceId,
      referenceAdvertisementId: referenceId,
      localPath: `C:/analysis/${spec.key}.mp4`,
      checksumSha256: 'a'.repeat(63) + spec.key.length.toString(16),
      sizeBytes: BigInt(100_000),
      durationSeconds: spec.durationSeconds,
      widthPx: spec.platform === 'YOUTUBE_SHORTS' ? 1080 : 1080,
      heightPx: 1920,
      frameRate: 30,
      videoCodec: 'h264',
      hasAudio: false,
      aspectRatio: '9:16',
    },
  });

  let start = 0;
  for (const [index, seconds] of spec.sceneSeconds.entries()) {
    // eslint-disable-next-line no-await-in-loop -- scenes are written in index order
    await store.referenceScene.create({
      data: {
        workspaceId,
        referenceAdvertisementId: referenceId,
        sceneIndex: index,
        startSeconds: start,
        endSeconds: start + seconds,
        durationSeconds: seconds,
        detectionMethod: 'ffmpeg-select-scene',
        detectorConfig: {},
      },
    });
    start += seconds;
  }

  const cutsPerSecond = (spec.sceneSeconds.length - 1) / spec.durationSeconds;
  await store.referenceCraftMetrics.create({
    data: {
      workspaceId,
      referenceAdvertisementId: referenceId,
      durationSeconds: spec.durationSeconds,
      sceneCount: spec.sceneSeconds.length,
      cutsPerSecond,
      averageSceneSeconds: spec.durationSeconds / spec.sceneSeconds.length,
      firstCutSeconds: spec.sceneSeconds[0],
      aspectRatio: '9:16',
      widthPx: 1080,
      heightPx: 1920,
      frameRate: 30,
      videoCodec: 'h264',
      hasAudio: false,
    },
  });

  await store.referenceAnnotation.create({
    data: {
      workspaceId,
      referenceAdvertisementId: referenceId,
      version: 1,
      authorId: 'benchmark',
      hookMechanism: spec.hookMechanism,
      narrativeStructure: spec.narrativeStructure,
      transitionCategory: spec.transitionCategory,
      soundProgression: spec.soundProgression,
      ...(spec.productRevealSeconds === undefined
        ? {}
        : { productRevealSeconds: spec.productRevealSeconds }),
      ...(spec.ctaSeconds === undefined ? {} : { ctaSeconds: spec.ctaSeconds }),
      transferablePrinciple: spec.transferablePrinciple,
      prohibitedDirectSimilarity: `Do not reproduce the ${spec.key} execution directly; take the principle only.`,
      reviewerConfidence: 'HIGH',
      approved: true,
    },
  });
}

export async function seedBenchmarkWorkspace(store: InMemoryReferenceStore): Promise<void> {
  for (const spec of SPECS) {
    // eslint-disable-next-line no-await-in-loop -- seeded in declaration order for determinism
    await seedOne(store, WORKSPACE_A, spec);
  }
  // A second workspace, to prove isolation rather than assume it.
  await seedOne(store, WORKSPACE_B, {
    ...(SPECS[0] as SeedSpec),
    key: 'other-workspace-ad',
    brand: 'Other workspace',
  });
}

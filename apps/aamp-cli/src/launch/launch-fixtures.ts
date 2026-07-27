import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { InMemoryReferenceStore } from '@combat/database';
import type { CommandResult, CommandRunner } from '@combat/media';
import { StructuralBaselineEmbeddingProvider } from '@combat/providers';

import { seedBenchmarkProfiles } from '../creative-memory/benchmark-profile-commands';
import { seedBenchmarkWorkspace, WORKSPACE_A } from '../creative-memory/benchmark-fixture';
import { InMemoryQdrant } from '../creative-memory/in-memory-qdrant';
import type { CreativeMemoryDependencies } from '../creative-memory/injection';
import { indexWorkspace } from '../creative-memory/retrieval-pipeline';

/**
 * Deterministic inputs for the launch acceptance tests.
 *
 * These are **inputs**, never creative: a brief, an approved asset library, an
 * approved capture session and a governed reference workspace. There is no
 * concept, hook, caption, beat or script here — those come from the agents, and
 * `launch-source-hygiene.test.ts` asserts that no file in this directory
 * contains one.
 *
 * Nothing on a command path imports this module; a source-level test asserts
 * that too. It exists so two test files can share one workspace shape without
 * one of them importing the other's `describe` blocks.
 */

export const LAUNCH_FIXTURE_WORKSPACE_ID = WORKSPACE_A;
export const LAUNCH_FIXTURE_CAMPAIGN_ID = '3f9a1c22-7b5e-4d61-9f2a-8c6d5e4b3a21';
export const LAUNCH_FIXTURE_BENCHMARK_PROFILE = 'launch-benchmark';
export const LAUNCH_FIXTURE_REVIEWER = 'reviewer-1';
export const LAUNCH_FIXTURE_AT = new Date('2026-07-28T00:00:00.000Z');

const CAPTURE_ASSET_IDS = ['app-information', 'app-prediction'] as const;

export function launchRequestJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestVersion: 1,
    name: 'example-product-launch',
    workspaceId: LAUNCH_FIXTURE_WORKSPACE_ID,
    campaignId: LAUNCH_FIXTURE_CAMPAIGN_ID,
    brandName: 'Example Product',
    campaignPrompt:
      'Introduce the product to people who have never used it. Explain what it does using only the supplied facts, and end on the download action.',
    objective: 'Introduce the product at launch',
    targetAudience: 'People who follow the category but have never used this product',
    platform: 'TIKTOK',
    targetDurationSeconds: 15,
    productFacts: [
      {
        id: 'coverage',
        label: 'Coverage',
        detail: 'Every event in the category is listed in one place.',
      },
      {
        id: 'free',
        label: 'Price',
        detail: 'The product is free to download and use.',
      },
    ],
    eventFacts: [],
    keyMessages: ['One place for the whole category.'],
    mandatories: [],
    cta: { headline: 'Download Free', subline: 'Example Product', durationSeconds: 3 },
    brandKit: {
      logoAssetId: 'logo',
      primaryColorHex: '#0B0B0F',
      accentColorHex: '#FF3B30',
      captionFontFamily: 'Arial',
      safeAreaTopPx: 220,
      safeAreaBottomPx: 420,
    },
    productLaunch: {
      campaignMode: 'PRODUCT_LAUNCH',
      positioning: 'The single place the whole category is followed from.',
      desiredAudiencePerception: 'This is where people who take the category seriously go.',
      prohibitedClaims: ['the product predicts results', 'the product is officially endorsed'],
      creativeConstraints: ['Vertical 9:16 only.'],
      brandIdentity: {
        voice: 'Direct, short sentences, no hype.',
        personalityAttributes: ['plain', 'informed'],
        prohibitedTone: ['sensational'],
      },
      requiredVariants: [
        { id: 'short', label: 'Six second cutdown', durationSeconds: 6, purpose: 'Feed pre-roll' },
      ],
      conceptCandidateCount: 4,
      benchmarkProfileName: LAUNCH_FIXTURE_BENCHMARK_PROFILE,
      approvedReviewerIds: [LAUNCH_FIXTURE_REVIEWER],
      budgetCeilingCents: 5000,
      requiredCaptureIds: [...CAPTURE_ASSET_IDS],
    },
    sourceAssetManifest: 'assets.json',
    captureManifest: 'captures.json',
    outputDirectory: '.aamp-output/launch',
    generation: { source: 'SOURCE_ONLY' },
    ...overrides,
  };
}

export function productionAssetsJson(
  overrides: { readonly assets?: readonly Record<string, unknown>[] } = {},
): Record<string, unknown> {
  const owned = {
    classification: 'OWNED',
    owner: 'Example Product',
    permittedOutputUse: true,
  };
  return {
    manifestVersion: 1,
    library: 'Example Product owned library',
    assets: overrides.assets ?? [
      {
        id: 'arena-clip',
        path: 'arena.mp4',
        kind: 'VIDEO',
        role: 'SOURCE_CLIP',
        description: 'Owned vertical footage',
        rights: owned,
        beats: ['HOOK', 'EVENT_DETAIL'],
        tags: ['category'],
        declaredWidthPx: 1080,
        declaredHeightPx: 1920,
      },
      {
        id: 'app-information',
        path: 'information.png',
        kind: 'IMAGE',
        role: 'APP_SCREENSHOT',
        description: 'Product screen showing the listing',
        rights: owned,
        beats: ['INFORMATION'],
        declaredWidthPx: 1080,
        declaredHeightPx: 1920,
      },
      {
        id: 'app-prediction',
        path: 'prediction.png',
        kind: 'IMAGE',
        role: 'APP_SCREENSHOT',
        description: 'Product screen showing the second surface',
        rights: owned,
        beats: ['PREDICTION'],
        declaredWidthPx: 1080,
        declaredHeightPx: 1920,
      },
      {
        id: 'app-discussion',
        path: 'discussion.png',
        kind: 'IMAGE',
        role: 'APP_SCREENSHOT',
        description: 'Product screen showing the third surface',
        rights: owned,
        beats: ['DISCUSSION'],
        declaredWidthPx: 1080,
        declaredHeightPx: 1920,
      },
      {
        id: 'brand-card',
        path: 'card.png',
        kind: 'IMAGE',
        role: 'BRAND_CARD',
        description: 'Designed end card',
        rights: owned,
        beats: ['CTA'],
        declaredWidthPx: 1080,
        declaredHeightPx: 1920,
      },
      {
        id: 'logo',
        path: 'logo.png',
        kind: 'IMAGE',
        role: 'LOGO',
        description: 'Product lockup',
        rights: owned,
        declaredWidthPx: 600,
        declaredHeightPx: 200,
      },
    ],
  };
}

/**
 * The bytes every fixture file holds, and their real checksum.
 *
 * Real rather than checksum-shaped: the capture session's checksums are carried
 * into the merged manifest, and asset resolution refuses a file whose bytes
 * disagree with its recorded checksum. A fabricated value would fail that check
 * for the wrong reason and hide whether the merge worked.
 */
export function fixtureFileContent(name: string): string {
  return `fixture bytes for ${name}`;
}

export function fixtureChecksum(name: string): string {
  return createHash('sha256').update(fixtureFileContent(name), 'utf8').digest('hex');
}

function capturedAsset(
  assetId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assetId,
    role: 'APP_EVENT_LIST',
    eligibility: 'OUTPUT_ELIGIBLE',
    rightsClassification: 'OWNED',
    rightsBasis: 'OWNED_UI_CAPTURE',
    relativePath: `${assetId}.png`,
    checksumSha256: fixtureChecksum(`${assetId}.png`),
    widthPx: 1080,
    heightPx: 1920,
    format: 'png',
    sizeBytes: 4096,
    provenance: {
      sourceHost: 'example.invalid',
      sourcePath: `/${assetId}`,
      queryPresent: false,
      capturedAt: '2026-07-27T00:00:00.000Z',
      viewport: 'PHONE_PORTRAIT_1080X1920',
      viewportWidthCssPx: 360,
      viewportHeightCssPx: 640,
      deviceScaleFactor: 3,
      specificationVersion: 1,
      specificationName: 'example-product-public',
      rightsDeclarationVersion: 1,
      browserEngine: 'chromium',
      browserVersion: '0.0.0',
      playwrightVersion: '0.0.0',
      redactedElementCount: 0,
      croppedToSelector: false,
    },
    ...overrides,
  };
}

export function captureSessionJson(
  overrides: { readonly assets?: readonly Record<string, unknown>[] } = {},
): Record<string, unknown> {
  const assets =
    overrides.assets ??
    CAPTURE_ASSET_IDS.map((assetId) => capturedAsset(assetId)).concat([
      // A screen photographed for inspection only. It is present on purpose:
      // the merged manifest must never contain it, and the run must not fail
      // merely because it exists.
      capturedAsset('app-discussion', {
        eligibility: 'REVIEW_REQUIRED',
        rightsClassification: null,
        rightsBasis: null,
      }),
    ]);

  return {
    sessionVersion: 1,
    specificationName: 'example-product-public',
    specificationVersion: 1,
    host: 'example.invalid',
    startedAt: '2026-07-27T00:00:00.000Z',
    completedAt: '2026-07-27T00:01:00.000Z',
    rightsMode: 'DECLARED',
    rightsDeclarationVersion: 1,
    rightsDeclaredBy: 'operator-1',
    rightsExpiresAt: null,
    screensRequested: assets.length,
    screensEnabled: assets.length,
    screensCaptured: assets.length,
    screensSkippedDisabled: [],
    assets,
    failures: [],
    blockedRequests: [],
    totalElementsRedacted: 0,
    browserEngine: 'chromium',
    browserVersion: '0.0.0',
    playwrightVersion: '0.0.0',
    requiresHumanApproval: true,
    paidProviderCalls: 0,
    notice: 'Fixture capture session. Not a real capture.',
  };
}

/** Every media path the fixture manifests declare, in a fixed order. */
export const LAUNCH_FIXTURE_MEDIA_FILES = [
  'arena.mp4',
  'information.png',
  'prediction.png',
  'discussion.png',
  'card.png',
  'logo.png',
  'app-information.png',
  'app-prediction.png',
  'app-discussion.png',
] as const;

export interface LaunchFixtureWorkspace {
  readonly directory: string;
  readonly requestPath: string;
  readonly assetsPath: string;
  readonly capturesPath: string;
}

/**
 * Writes a complete launch workspace: the request, the asset manifest, the
 * capture session and real (tiny) files for every declared path, so containment,
 * size and checksum handling are exercised for real. Only decoding is faked.
 */
export async function writeLaunchFixtureWorkspace(
  directory: string,
  overrides: {
    readonly request?: Record<string, unknown>;
    readonly assets?: Record<string, unknown>;
    readonly captures?: Record<string, unknown>;
    /**
     * Whether to write placeholder bytes for every declared media path.
     *
     * False when the caller has already produced real media — the live render
     * test generates `lavfi` sources and would otherwise have them overwritten
     * with text.
     */
    readonly writeMedia?: boolean;
  } = {},
): Promise<LaunchFixtureWorkspace> {
  await mkdir(directory, { recursive: true });
  const requestPath = join(directory, 'request.json');
  const assetsPath = join(directory, 'assets.json');
  const capturesPath = join(directory, 'captures.json');

  await writeFile(
    requestPath,
    JSON.stringify(overrides.request ?? launchRequestJson(), null, 2),
    'utf8',
  );
  await writeFile(
    assetsPath,
    JSON.stringify(overrides.assets ?? productionAssetsJson(), null, 2),
    'utf8',
  );
  await writeFile(
    capturesPath,
    JSON.stringify(overrides.captures ?? captureSessionJson(), null, 2),
    'utf8',
  );

  const media = (overrides.writeMedia ?? true) ? LAUNCH_FIXTURE_MEDIA_FILES : [];
  for (const name of media) {
    // eslint-disable-next-line no-await-in-loop -- written in a fixed order for a reproducible workspace
    await writeFile(join(directory, name), fixtureFileContent(name), 'utf8');
  }

  return { directory, requestPath, assetsPath, capturesPath };
}

/**
 * A runner that answers ffprobe from a table and records every other command.
 *
 * Recording rather than silently succeeding is what lets a test prove the
 * renderer was never reached, instead of inferring it from an absent file.
 */
export class FfprobeOnlyRunner implements CommandRunner {
  readonly otherInvocations: string[][] = [];

  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    if (command.includes('ffprobe')) {
      const path = args[args.length - 1] ?? '';
      const isVideo = path.endsWith('.mp4');
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: { duration: isVideo ? '12.0' : '0', format_name: isVideo ? 'mp4' : 'png' },
          streams: [
            {
              codec_type: 'video',
              width: 1080,
              height: 1920,
              codec_name: isVideo ? 'h264' : 'png',
              avg_frame_rate: isVideo ? '30/1' : '0/0',
              nb_frames: isVideo ? '360' : '1',
              pix_fmt: 'yuv420p',
            },
          ],
        }),
        stderr: '',
      };
    }
    this.otherInvocations.push([command, ...args]);
    return { exitCode: 1, stdout: '', stderr: 'this fixture runner never renders' };
  }
}

/** A seeded, governed, indexed reference workspace with approved benchmark profiles. */
export async function launchCreativeMemoryDependencies(): Promise<CreativeMemoryDependencies> {
  const store = new InMemoryReferenceStore();
  await seedBenchmarkWorkspace(store);
  await seedBenchmarkProfiles(store, {
    workspaceId: LAUNCH_FIXTURE_WORKSPACE_ID,
    name: LAUNCH_FIXTURE_BENCHMARK_PROFILE,
    reviewerId: LAUNCH_FIXTURE_REVIEWER,
    activatedBy: 'operator-1',
    at: LAUNCH_FIXTURE_AT,
  });

  const embedder = new StructuralBaselineEmbeddingProvider();
  const qdrant = new InMemoryQdrant().asClient();
  await indexWorkspace({
    db: store,
    workspaceId: LAUNCH_FIXTURE_WORKSPACE_ID,
    embedder,
    qdrant,
  });
  return { db: store, qdrant, embedder };
}

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { ProductionAsset } from '../production-assets';

/**
 * The locked ten-panel storyboard package, and the panels as production media.
 *
 * This is deliberately a *separate* module from `storyboard-package.ts`, and
 * the difference is not the panel count — it is the rights position, which is
 * the opposite one.
 *
 * Storyboard-01 is `REFERENCE_ONLY`: its pixels may never reach an output, and
 * `reference-exclusion.ts` proves by checksum that they did not. Storyboard-02
 * is the *locked art direction* for a motion proof, so its pixels are the
 * primary visual source. Collapsing the two into one parser with a flag would
 * put a switch between "these bytes may never be rendered" and "these bytes
 * are what we render", and that is the last switch in this repository anybody
 * should be able to flip by accident.
 *
 * What replaces exclusion here is *declaration*. A panel becomes production
 * media only as an asset that says, in its id, its description, its
 * restrictions and every provenance record it touches: this is storyboard
 * imagery, it is internal-review only, it is not licensed public-production
 * media, and it is not public-release ready.
 */

export const STORYBOARD_V2_FRAME_COUNT = 10;
export const STORYBOARD_V2_DURATION_SECONDS = 15;

/** The ten scene roles, in the only order they may appear. */
export const LOCKED_SCENE_ROLES = [
  'NOTIFICATION_HOOK',
  'COMBAT_SPORT_BREADTH',
  'EVENT_DISCOVERY',
  'RANKINGS_RESEARCH',
  'FIGHTER_COMPARISON',
  'FREE_PREDICTION',
  'PREDICTION_SUBMITTED',
  'PREDICTOR_STATUS_REWARD',
  'COMMUNITY_DISCUSSION',
  'BRAND_CTA',
] as const;
export type LockedSceneRole = (typeof LOCKED_SCENE_ROLES)[number];

/** The locked slot each scene occupies, in seconds. Not configurable. */
export const LOCKED_SCENE_SLOTS: readonly (readonly [number, number])[] = [
  [0.0, 1.1],
  [1.1, 2.3],
  [2.3, 3.8],
  [3.8, 5.1],
  [5.1, 6.6],
  [6.6, 8.0],
  [8.0, 8.9],
  [8.9, 10.7],
  [10.7, 12.7],
  [12.7, 15.0],
];

const Sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a hex sha256');

const FactualCorrectionSchema = z.object({
  region: z.object({
    xPx: z.number().int().min(0),
    yPx: z.number().int().min(0),
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
  }),
  removed: z.string().min(1),
  replacedWith: z.string().min(1).nullable(),
  headlineBefore: z.string().min(1),
  headlineAfter: z.string().min(1),
  reason: z.string().min(1),
  method: z.string().min(1),
  correctedFramePath: z.string().min(1),
  correctedChecksumSha256: Sha256,
  correctedSizeBytes: z.number().int().positive(),
});
export type FactualCorrection = z.infer<typeof FactualCorrectionSchema>;

const FrameSchema = z.object({
  frameId: z.string().regex(/^FRAME-(0[1-9]|10)$/, 'frame ids are FRAME-01 … FRAME-10'),
  sequence: z.number().int().min(1).max(STORYBOARD_V2_FRAME_COUNT),
  sceneRole: z.enum(LOCKED_SCENE_ROLES),
  sourceFramePath: z.string().min(1),
  startSeconds: z.number().min(0),
  endSeconds: z.number().positive(),
  durationSeconds: z.number().positive(),
  purpose: z.string().min(1),
  visibleIntent: z.string().min(1),
  viewerUnderstanding: z.string().min(1),
  requiredProductionRole: z.string().min(1),
  requiredAssetTypes: z.array(z.string().min(1)).default([]),
  productFeature: z.string().min(1),
  onScreenCopyIntent: z.array(z.string()).default([]),
  motionIntent: z.string().default(''),
  transitionInIntent: z.string().default(''),
  graphicsIntent: z.string().default(''),
  colourAndLightingIntent: z.string().default(''),
  audioIntent: z.string().default(''),
  protectedStrengths: z.array(z.string()).default([]),
  factualClaimsRequiringValidation: z.array(z.string()).default([]),
  prohibitedOutputElements: z.array(z.string()).default([]),
  checksumSha256: Sha256,
  sizeBytes: z.number().int().positive(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  /** Both are literals: a package that says otherwise is refused, not downgraded. */
  usageClass: z.literal('STORYBOARD_INTERNAL_REVIEW_ONLY'),
  outputEligibleForPublicRelease: z.literal(false),
  internalReviewMotionProofAuthorised: z.literal(true),
  factualCorrection: FactualCorrectionSchema.optional(),
});
export type StoryboardV2Frame = z.infer<typeof FrameSchema>;

const ManifestSchema = z.object({
  schemaVersion: z.string().min(1),
  storyboardId: z.string().min(1),
  campaign: z.string().min(1),
  objective: z.string().min(1),
  durationSeconds: z.literal(STORYBOARD_V2_DURATION_SECONDS),
  creativeTerritory: z.string().min(1),
  CTA: z.string().min(1),
  sourceImage: z.object({ packagedPath: z.string().min(1), originalPath: z.string().min(1) }),
  sourceChecksum: z.object({ algorithm: z.string(), original: Sha256, copy: Sha256 }),
  usageClass: z.literal('STORYBOARD_INTERNAL_REVIEW_ONLY'),
  outputEligibleForPublicRelease: z.literal(false),
  internalReviewMotionProofAuthorised: z.literal(true),
  licensedForPublicProduction: z.literal(false),
  isPublicReleaseReady: z.literal(false),
  rightsStatement: z.string().min(1),
  referenceRule: z.string().min(1),
  productAssetsRule: z.string().min(1),
  frames: z.array(FrameSchema),
});

export interface StoryboardV2Problem {
  readonly kind:
    | 'PACKAGE_UNREADABLE'
    | 'MANIFEST_INVALID'
    | 'RIGHTS_OVERSTATED'
    | 'FRAME_COUNT'
    | 'SCENE_ORDER'
    | 'SCENE_TIMING'
    | 'FRAME_MISSING'
    | 'FRAME_CHECKSUM_MISMATCH'
    | 'FRAME_DUPLICATE_CONTENT'
    | 'CORRECTION_MISSING'
    | 'CORRECTION_CHECKSUM_MISMATCH'
    | 'PATH_ESCAPES_PACKAGE'
    | 'SHEET_CHECKSUM_MISMATCH';
  readonly detail: string;
}

export class StoryboardV2Error extends Error {
  constructor(
    public readonly problems: readonly StoryboardV2Problem[],
    public readonly storyboardRoot: string,
  ) {
    super(
      `The locked storyboard package at ${storyboardRoot} is not usable:\n${problems
        .map((problem) => `  - ${problem.kind}: ${problem.detail}`)
        .join('\n')}`,
    );
    this.name = 'StoryboardV2Error';
  }
}

export interface VerifiedStoryboardV2Frame extends StoryboardV2Frame {
  readonly absolutePath: string;
  readonly relativePath: string;
  /** The panel actually rendered: the corrected file where one exists. */
  readonly renderAbsolutePath: string;
  readonly renderRelativePath: string;
  readonly renderChecksumSha256: string;
  readonly isFactuallyCorrected: boolean;
}

export interface VerifiedStoryboardV2 {
  readonly storyboardRoot: string;
  readonly storyboardId: string;
  readonly campaign: string;
  readonly objective: string;
  readonly creativeTerritory: string;
  readonly cta: string;
  readonly durationSeconds: number;
  readonly usageClass: 'STORYBOARD_INTERNAL_REVIEW_ONLY';
  readonly outputEligibleForPublicRelease: false;
  readonly internalReviewMotionProofAuthorised: true;
  readonly licensedForPublicProduction: false;
  readonly isPublicReleaseReady: false;
  readonly rightsStatement: string;
  readonly referenceRule: string;
  readonly productAssetsRule: string;
  readonly contactSheetPath: string;
  readonly contactSheetChecksumSha256: string;
  readonly frames: readonly VerifiedStoryboardV2Frame[];
  readonly corrections: readonly (FactualCorrection & { frameId: string; sceneRole: string })[];
  readonly claimsRequiringValidation: readonly { frameId: string; claim: string }[];
}

async function sha256OfFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function containedIn(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

/**
 * Reads and verifies the locked package.
 *
 * Reports every problem it found rather than the first, and re-hashes every
 * file rather than trusting the manifest that describes it — a package is
 * exactly as trustworthy as the last time somebody checked its bytes.
 */
export async function verifyStoryboardV2(rootInput: string): Promise<VerifiedStoryboardV2> {
  const storyboardRoot = resolve(rootInput);
  const problems: StoryboardV2Problem[] = [];
  const fail = (kind: StoryboardV2Problem['kind'], detail: string): void => {
    problems.push({ kind, detail });
  };

  let text: string;
  try {
    text = await readFile(join(storyboardRoot, 'storyboard-manifest.json'), 'utf8');
  } catch (error) {
    throw new StoryboardV2Error(
      [
        {
          kind: 'PACKAGE_UNREADABLE',
          detail: `storyboard-manifest.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      storyboardRoot,
    );
  }

  const parsed = ManifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const rights = parsed.error.issues.some((issue) =>
      issue.path.some(
        (segment) =>
          segment === 'usageClass' ||
          segment === 'outputEligibleForPublicRelease' ||
          segment === 'licensedForPublicProduction' ||
          segment === 'isPublicReleaseReady' ||
          segment === 'internalReviewMotionProofAuthorised',
      ),
    );
    throw new StoryboardV2Error(
      [
        {
          kind: rights ? 'RIGHTS_OVERSTATED' : 'MANIFEST_INVALID',
          detail: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; '),
        },
      ],
      storyboardRoot,
    );
  }
  const manifest = parsed.data;

  if (manifest.frames.length !== STORYBOARD_V2_FRAME_COUNT) {
    fail(
      'FRAME_COUNT',
      `the locked storyboard has ${STORYBOARD_V2_FRAME_COUNT} panels, the package declares ${manifest.frames.length}`,
    );
  }

  const ordered = [...manifest.frames].sort((a, b) => a.sequence - b.sequence);

  // Scene order is locked to the brief, not merely to the package's own
  // numbering: a package that renumbered its panels would otherwise pass.
  ordered.forEach((frame, index) => {
    if (frame.sequence !== index + 1) {
      fail(
        'SCENE_ORDER',
        `${frame.frameId} declares sequence ${frame.sequence} at position ${index + 1}`,
      );
    }
    const expectedRole = LOCKED_SCENE_ROLES[index];
    if (frame.sceneRole !== expectedRole) {
      fail(
        'SCENE_ORDER',
        `position ${index + 1} must be ${expectedRole} but the package declares ${frame.sceneRole}`,
      );
    }
    const slot = LOCKED_SCENE_SLOTS[index];
    if (slot) {
      if (
        Math.abs(frame.startSeconds - slot[0]) > 1e-6 ||
        Math.abs(frame.endSeconds - slot[1]) > 1e-6
      ) {
        fail(
          'SCENE_TIMING',
          `${frame.frameId} is ${frame.startSeconds}-${frame.endSeconds}s but the locked slot is ${slot[0]}-${slot[1]}s`,
        );
      }
    }
  });

  let expectedStart = 0;
  for (const frame of ordered) {
    if (Math.abs(frame.startSeconds - expectedStart) > 1e-6) {
      fail(
        'SCENE_TIMING',
        `${frame.frameId} starts at ${frame.startSeconds}s but the previous scene ended at ${expectedStart}s`,
      );
    }
    expectedStart = frame.endSeconds;
  }
  if (Math.abs(expectedStart - STORYBOARD_V2_DURATION_SECONDS) > 1e-6) {
    fail(
      'SCENE_TIMING',
      `the scenes tile ${expectedStart}s, not ${STORYBOARD_V2_DURATION_SECONDS}s`,
    );
  }

  const frames: VerifiedStoryboardV2Frame[] = [];
  const seen = new Map<string, string>();

  for (const frame of ordered) {
    const absolutePath = resolve(storyboardRoot, frame.sourceFramePath);
    if (!containedIn(storyboardRoot, absolutePath)) {
      fail('PATH_ESCAPES_PACKAGE', `${frame.frameId} resolves outside the package`);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- ordered so the problem list is stable
      await stat(absolutePath);
    } catch {
      fail(
        'FRAME_MISSING',
        `${frame.frameId} is declared at ${frame.sourceFramePath} but is not on disk`,
      );
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- as above
    const checksumSha256 = await sha256OfFile(absolutePath);
    if (checksumSha256 !== frame.checksumSha256.toLowerCase()) {
      fail(
        'FRAME_CHECKSUM_MISMATCH',
        `${frame.frameId} hashes to ${checksumSha256.slice(0, 16)}… but the package declared ${frame.checksumSha256.slice(0, 16).toLowerCase()}…`,
      );
    }
    const duplicate = seen.get(checksumSha256);
    if (duplicate)
      fail('FRAME_DUPLICATE_CONTENT', `${duplicate} and ${frame.frameId} are byte-identical`);
    seen.set(checksumSha256, frame.frameId);

    let renderAbsolutePath = absolutePath;
    let renderRelativePath = frame.sourceFramePath;
    let renderChecksumSha256 = checksumSha256;
    if (frame.factualCorrection) {
      const correctedPath = resolve(storyboardRoot, frame.factualCorrection.correctedFramePath);
      if (!containedIn(storyboardRoot, correctedPath)) {
        fail(
          'PATH_ESCAPES_PACKAGE',
          `${frame.frameId}'s corrected panel resolves outside the package`,
        );
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop -- as above
          const actual = await sha256OfFile(correctedPath);
          if (actual !== frame.factualCorrection.correctedChecksumSha256.toLowerCase()) {
            fail(
              'CORRECTION_CHECKSUM_MISMATCH',
              `${frame.frameId}'s corrected panel hashes to ${actual.slice(0, 16)}… but the package declared ${frame.factualCorrection.correctedChecksumSha256.slice(0, 16).toLowerCase()}…`,
            );
          }
          if (actual === checksumSha256) {
            fail(
              'CORRECTION_MISSING',
              `${frame.frameId} declares a factual correction but the corrected panel is byte-identical to the original`,
            );
          }
          renderAbsolutePath = correctedPath;
          renderRelativePath = frame.factualCorrection.correctedFramePath;
          renderChecksumSha256 = actual;
        } catch {
          fail(
            'CORRECTION_MISSING',
            `${frame.frameId} declares a factual correction but ${frame.factualCorrection.correctedFramePath} is not on disk`,
          );
        }
      }
    }

    frames.push({
      ...frame,
      absolutePath,
      relativePath: relative(storyboardRoot, absolutePath).split(sep).join('/'),
      renderAbsolutePath,
      renderRelativePath,
      renderChecksumSha256,
      isFactuallyCorrected: Boolean(frame.factualCorrection),
    });
  }

  const contactSheetPath = resolve(storyboardRoot, manifest.sourceImage.packagedPath);
  let contactSheetChecksumSha256 = '';
  try {
    contactSheetChecksumSha256 = await sha256OfFile(contactSheetPath);
    if (contactSheetChecksumSha256 !== manifest.sourceChecksum.copy.toLowerCase()) {
      fail(
        'SHEET_CHECKSUM_MISMATCH',
        'the packaged sheet does not hash to the declared copy checksum',
      );
    }
  } catch {
    fail('FRAME_MISSING', `the packaged sheet ${manifest.sourceImage.packagedPath} is not on disk`);
  }

  if (problems.length > 0) throw new StoryboardV2Error(problems, storyboardRoot);

  return {
    storyboardRoot,
    storyboardId: manifest.storyboardId,
    campaign: manifest.campaign,
    objective: manifest.objective,
    creativeTerritory: manifest.creativeTerritory,
    cta: manifest.CTA,
    durationSeconds: manifest.durationSeconds,
    usageClass: 'STORYBOARD_INTERNAL_REVIEW_ONLY',
    outputEligibleForPublicRelease: false,
    internalReviewMotionProofAuthorised: true,
    licensedForPublicProduction: false,
    isPublicReleaseReady: false,
    rightsStatement: manifest.rightsStatement,
    referenceRule: manifest.referenceRule,
    productAssetsRule: manifest.productAssetsRule,
    contactSheetPath,
    contactSheetChecksumSha256,
    frames,
    corrections: frames
      .filter((frame) => frame.factualCorrection)
      .map((frame) => ({
        ...(frame.factualCorrection as FactualCorrection),
        frameId: frame.frameId,
        sceneRole: frame.sceneRole,
      })),
    claimsRequiringValidation: frames.flatMap((frame) =>
      frame.factualClaimsRequiringValidation.map((claim) => ({ frameId: frame.frameId, claim })),
    ),
  };
}

/** The asset id a panel takes in the production manifest. It says what it is. */
export function panelAssetId(frame: { readonly sequence: number }): string {
  return `storyboard-panel-${String(frame.sequence).padStart(2, '0')}`;
}

/**
 * The panels, as production assets.
 *
 * `OWNED` because the operator supplied them, `permittedOutputUse: true`
 * because this run is the internal review they were authorised for, and four
 * restrictions that travel with every one of them so no downstream reader can
 * mistake a panel for a capture, for licensed media, or for something that may
 * be published.
 */
export function buildPanelAssets(
  storyboard: VerifiedStoryboardV2,
): readonly { readonly asset: ProductionAsset; readonly absolutePath: string }[] {
  return storyboard.frames.map((frame) => ({
    absolutePath: frame.renderAbsolutePath,
    asset: {
      id: panelAssetId(frame),
      path: `./panels/${panelAssetId(frame)}.png`,
      kind: 'IMAGE' as const,
      // A designed panel, not a photograph of the product and not a capture.
      role: 'BRAND_CARD' as const,
      description: `STORYBOARD PANEL ${frame.frameId} (${frame.sceneRole}) — locked art direction, internal review only. Not a capture and not licensed public-production media.`,
      rights: {
        classification: 'OWNED' as const,
        owner: 'Combat Reviews',
        permittedOutputUse: true,
        restrictions: [
          'provenance: STORYBOARD_PANEL — operator-supplied storyboard art animated for one internal-review motion proof',
          'not licensed public-production media; no model or property releases exist',
          'every phone screen in this panel is concept UI and is declared PRODUCT_MOCKUP',
          'Approved channel: INTERNAL_REVIEW only; not public-release ready',
        ],
      },
      beats: [],
      tags: ['storyboard', 'panel', frame.sceneRole.toLowerCase()],
      declaredWidthPx: frame.widthPx,
      declaredHeightPx: frame.heightPx,
    },
  }));
}

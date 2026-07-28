import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

/**
 * The flagship storyboard package — read, verified, and permanently barred
 * from the output.
 *
 * A storyboard is the one input to this milestone that is *not* material. It
 * says what the advertisement should do — composition, sequence, pacing,
 * energy, graphics, story, cinematic intention — and none of its pixels may
 * ever reach a frame of the finished file. Two separate mechanisms enforce
 * that, and they are separate on purpose:
 *
 * - **Here, by declaration.** The package must say `REFERENCE_ONLY` and
 *   `outputEligible: false` at the package level *and* on every frame. A
 *   storyboard that has been edited to claim otherwise is refused rather than
 *   quietly promoted, because the whole point of the class is that no flag
 *   can leave it.
 * - **In `reference-exclusion.ts`, by content.** Every frame is hashed, and
 *   the render manifest is proven to contain none of those hashes and no path
 *   under this root. A declaration is a promise; a checksum is evidence, and
 *   this milestone wants both.
 *
 * Everything here is read-only. The package is the operator's own working
 * directory: it is opened, hashed and compared, and never written, renamed,
 * moved or deleted.
 */

/** The frame count the eight-panel storyboard contract is built on. */
export const FLAGSHIP_FRAME_COUNT = 8;

const Sha256Schema = z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a hex sha256');

/**
 * Only the fields this milestone depends on.
 *
 * Deliberately not `.strict()`: the storyboard package is an external document
 * produced by a separate tool, and refusing it because that tool added a field
 * would make an unrelated improvement upstream look like a corrupt package.
 * What this milestone *reads* is validated exactly; what it does not read is
 * ignored.
 */
const StoryboardFrameSchema = z.object({
  frameId: z.string().regex(/^FRAME-0[1-8]$/, 'frame ids are FRAME-01 … FRAME-08'),
  sequence: z.number().int().min(1).max(FLAGSHIP_FRAME_COUNT),
  sourceFramePath: z.string().min(1),
  startSeconds: z.number().min(0),
  endSeconds: z.number().positive(),
  purpose: z.string().min(1),
  visibleIntent: z.string().min(1),
  requiredProductionRole: z.string().min(1),
  requiredAssetTypes: z.array(z.string().min(1)).default([]),
  productFeature: z.string().min(1),
  onScreenCopyIntent: z.array(z.string()).default([]),
  motionIntent: z.string().default(''),
  graphicsIntent: z.string().default(''),
  colourAndLightingIntent: z.string().default(''),
  audioIntent: z.string().default(''),
  protectedStrengths: z.array(z.string()).default([]),
  factualClaimsRequiringValidation: z.array(z.string()).default([]),
  prohibitedOutputElements: z.array(z.string()).default([]),
  /** Both must be present and both must say the frame is reference material. */
  referenceOnly: z.literal(true),
  outputEligible: z.literal(false),
});
export type StoryboardFrame = z.infer<typeof StoryboardFrameSchema>;

const StoryboardManifestSchema = z.object({
  schemaVersion: z.string().min(1),
  storyboardId: z.string().min(1),
  campaign: z.string().min(1),
  objective: z.string().min(1),
  durationSeconds: z.number().positive(),
  creativeTerritory: z.string().min(1),
  sourceImage: z.object({ packagedPath: z.string().min(1) }),
  sourceChecksum: z.object({ algorithm: z.string(), copy: Sha256Schema }),
  usageClass: z.literal('REFERENCE_ONLY'),
  outputEligible: z.literal(false),
  referenceRule: z.string().min(1),
  productAssetsRule: z.string().min(1),
  frames: z.array(StoryboardFrameSchema),
});

export interface StoryboardIntegrityProblem {
  readonly kind:
    | 'PACKAGE_UNREADABLE'
    | 'MANIFEST_INVALID'
    | 'NOT_REFERENCE_ONLY'
    | 'FRAME_COUNT'
    | 'FRAME_SEQUENCE'
    | 'FRAME_TIMING'
    | 'FRAME_MISSING'
    | 'FRAME_CHECKSUM_UNDECLARED'
    | 'FRAME_CHECKSUM_MISMATCH'
    | 'FRAME_DUPLICATE_CONTENT'
    | 'CONTACT_SHEET_MISMATCH'
    | 'PATH_ESCAPES_PACKAGE';
  readonly detail: string;
}

export class StoryboardPackageError extends Error {
  constructor(
    public readonly problems: readonly StoryboardIntegrityProblem[],
    public readonly storyboardRoot: string,
  ) {
    super(
      `The storyboard package at ${storyboardRoot} is not usable:\n${problems
        .map((problem) => `  - ${problem.kind}: ${problem.detail}`)
        .join('\n')}`,
    );
    this.name = 'StoryboardPackageError';
  }
}

/** One verified frame, with the checksum that will later prove its absence. */
export interface VerifiedStoryboardFrame extends StoryboardFrame {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  /** Restated on the verified record so no consumer has to look it up again. */
  readonly usageClass: 'REFERENCE_ONLY';
}

export interface VerifiedStoryboardPackage {
  readonly storyboardRoot: string;
  readonly storyboardId: string;
  readonly campaign: string;
  readonly objective: string;
  readonly creativeTerritory: string;
  readonly durationSeconds: number;
  readonly usageClass: 'REFERENCE_ONLY';
  readonly outputEligible: false;
  readonly referenceRule: string;
  readonly productAssetsRule: string;
  readonly contactSheet: {
    readonly absolutePath: string;
    readonly checksumSha256: string;
    readonly declaredChecksumSha256: string;
  };
  readonly frames: readonly VerifiedStoryboardFrame[];
  /** Every checksum in the package, frames and contact sheet alike. */
  readonly excludedChecksums: readonly string[];
  /** Every claim the storyboard itself flagged as needing verification. */
  readonly claimsRequiringValidation: readonly { frameId: string; claim: string }[];
}

async function sha256OfFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * Parses `source-checksum.txt` — the package's own integrity record.
 *
 * Lines are `NAME SIZE SHA256`. Anything else is prose and is skipped: this
 * file is written for a person to read first and a program to check second,
 * and a parser that demanded a pure data format would have to be kept in step
 * with a human-facing document.
 */
function parseChecksumRecord(text: string): ReadonlyMap<string, string> {
  const declared = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(FRAME-0[1-8]\.png)\s+(\d+)\s+([0-9a-fA-F]{64})\s*$/.exec(line.trim());
    if (match) declared.set(match[1] as string, (match[3] as string).toLowerCase());
  }
  return declared;
}

/** True when `candidate` really sits inside `root` — not merely prefixed by it. */
function containedIn(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

/**
 * Reads and verifies a storyboard package.
 *
 * Fails with every problem it found rather than the first, because an operator
 * repairing a package one refusal at a time is exactly the loop this is meant
 * to avoid.
 */
export async function verifyStoryboardPackage(
  storyboardRootInput: string,
): Promise<VerifiedStoryboardPackage> {
  const storyboardRoot = resolve(storyboardRootInput);
  const problems: StoryboardIntegrityProblem[] = [];
  const fail = (kind: StoryboardIntegrityProblem['kind'], detail: string): void => {
    problems.push({ kind, detail });
  };

  let manifestText: string;
  try {
    manifestText = await readFile(join(storyboardRoot, 'storyboard-manifest.json'), 'utf8');
  } catch (error) {
    throw new StoryboardPackageError(
      [
        {
          kind: 'PACKAGE_UNREADABLE',
          detail: `storyboard-manifest.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      storyboardRoot,
    );
  }

  const parsed = StoryboardManifestSchema.safeParse(JSON.parse(manifestText));
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    );
    // A `usageClass` or `outputEligible` that failed to parse is not a schema
    // nit — it is a package claiming its frames may be used, which is the one
    // claim this milestone can never accept.
    const promoted = parsed.error.issues.some(
      (issue) => issue.path.includes('usageClass') || issue.path.includes('outputEligible'),
    );
    throw new StoryboardPackageError(
      [{ kind: promoted ? 'NOT_REFERENCE_ONLY' : 'MANIFEST_INVALID', detail: issues.join('; ') }],
      storyboardRoot,
    );
  }
  const manifest = parsed.data;

  if (manifest.frames.length !== FLAGSHIP_FRAME_COUNT) {
    fail(
      'FRAME_COUNT',
      `the eight-panel contract needs ${FLAGSHIP_FRAME_COUNT} frames, the package declares ${manifest.frames.length}`,
    );
  }

  const ordered = [...manifest.frames].sort((a, b) => a.sequence - b.sequence);
  ordered.forEach((frame, index) => {
    if (frame.sequence !== index + 1) {
      fail(
        'FRAME_SEQUENCE',
        `frame ${frame.frameId} declares sequence ${frame.sequence} but sits at position ${index + 1}; sequences must run 1…${FLAGSHIP_FRAME_COUNT} with no gap`,
      );
    }
  });

  // Timings must tile the whole cut with no gap and no overlap. A storyboard
  // that leaves 0.3s unaccounted for describes a cut nobody can build to.
  let expectedStart = 0;
  for (const frame of ordered) {
    if (Math.abs(frame.startSeconds - expectedStart) > 1e-6) {
      fail(
        'FRAME_TIMING',
        `frame ${frame.frameId} starts at ${frame.startSeconds}s but the previous frame ended at ${expectedStart}s`,
      );
    }
    if (frame.endSeconds <= frame.startSeconds) {
      fail(
        'FRAME_TIMING',
        `frame ${frame.frameId} ends at ${frame.endSeconds}s, at or before its ${frame.startSeconds}s start`,
      );
    }
    expectedStart = frame.endSeconds;
  }
  if (Math.abs(expectedStart - manifest.durationSeconds) > 1e-6) {
    fail(
      'FRAME_TIMING',
      `the frames tile ${expectedStart}s but the storyboard declares ${manifest.durationSeconds}s`,
    );
  }

  let declared: ReadonlyMap<string, string> = new Map();
  try {
    declared = parseChecksumRecord(
      await readFile(join(storyboardRoot, 'source-checksum.txt'), 'utf8'),
    );
  } catch {
    fail(
      'FRAME_CHECKSUM_UNDECLARED',
      'source-checksum.txt could not be read, so no frame checksum can be verified against what the package promised',
    );
  }

  const frames: VerifiedStoryboardFrame[] = [];
  const seenChecksums = new Map<string, string>();

  for (const frame of ordered) {
    const absolutePath = resolve(storyboardRoot, frame.sourceFramePath);
    if (!containedIn(storyboardRoot, absolutePath)) {
      fail(
        'PATH_ESCAPES_PACKAGE',
        `frame ${frame.frameId} resolves to ${absolutePath}, outside the storyboard package`,
      );
      continue;
    }

    let sizeBytes: number;
    try {
      // eslint-disable-next-line no-await-in-loop -- one frame at a time keeps the problem list ordered
      sizeBytes = (await stat(absolutePath)).size;
    } catch {
      fail(
        'FRAME_MISSING',
        `frame ${frame.frameId} is declared at ${frame.sourceFramePath} but is not on disk`,
      );
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- as above
    const checksumSha256 = await sha256OfFile(absolutePath);
    const expected = declared.get(`${frame.frameId}.png`);
    if (!expected) {
      fail(
        'FRAME_CHECKSUM_UNDECLARED',
        `frame ${frame.frameId} has no checksum in source-checksum.txt; an unverifiable frame is indistinguishable from a substituted one`,
      );
    } else if (expected !== checksumSha256) {
      fail(
        'FRAME_CHECKSUM_MISMATCH',
        `frame ${frame.frameId} hashes to ${checksumSha256.slice(0, 16)}… but the package declared ${expected.slice(0, 16)}…`,
      );
    }

    const duplicate = seenChecksums.get(checksumSha256);
    if (duplicate) {
      // Two identical panels are almost always a failed extraction rather than
      // a deliberate repeat, and a duplicated panel silently halves the
      // storyboard's coverage.
      fail(
        'FRAME_DUPLICATE_CONTENT',
        `frames ${duplicate} and ${frame.frameId} are byte-identical`,
      );
    }
    seenChecksums.set(checksumSha256, frame.frameId);

    frames.push({
      ...frame,
      absolutePath,
      relativePath: relative(storyboardRoot, absolutePath).split(sep).join('/'),
      checksumSha256,
      sizeBytes,
      usageClass: 'REFERENCE_ONLY',
    });
  }

  const contactSheetPath = resolve(storyboardRoot, manifest.sourceImage.packagedPath);
  let contactSheetChecksum = '';
  if (!containedIn(storyboardRoot, contactSheetPath)) {
    fail(
      'PATH_ESCAPES_PACKAGE',
      `the contact sheet resolves to ${contactSheetPath}, outside the storyboard package`,
    );
  } else {
    try {
      contactSheetChecksum = await sha256OfFile(contactSheetPath);
      if (contactSheetChecksum !== manifest.sourceChecksum.copy.toLowerCase()) {
        fail(
          'CONTACT_SHEET_MISMATCH',
          `the contact sheet hashes to ${contactSheetChecksum.slice(0, 16)}… but the manifest declared ${manifest.sourceChecksum.copy.slice(0, 16).toLowerCase()}…`,
        );
      }
    } catch {
      fail(
        'FRAME_MISSING',
        `the contact sheet ${manifest.sourceImage.packagedPath} is not on disk`,
      );
    }
  }

  if (problems.length > 0) throw new StoryboardPackageError(problems, storyboardRoot);

  return {
    storyboardRoot,
    storyboardId: manifest.storyboardId,
    campaign: manifest.campaign,
    objective: manifest.objective,
    creativeTerritory: manifest.creativeTerritory,
    durationSeconds: manifest.durationSeconds,
    usageClass: 'REFERENCE_ONLY',
    outputEligible: false,
    referenceRule: manifest.referenceRule,
    productAssetsRule: manifest.productAssetsRule,
    contactSheet: {
      absolutePath: contactSheetPath,
      checksumSha256: contactSheetChecksum,
      declaredChecksumSha256: manifest.sourceChecksum.copy.toLowerCase(),
    },
    frames,
    excludedChecksums: [
      ...frames.map((frame) => frame.checksumSha256),
      contactSheetChecksum,
    ].filter((checksum) => checksum.length > 0),
    claimsRequiringValidation: frames.flatMap((frame) =>
      frame.factualClaimsRequiringValidation.map((claim) => ({ frameId: frame.frameId, claim })),
    ),
  };
}

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { RenderManifest } from '@combat/media';

import type { VerifiedStoryboardPackage } from './storyboard-package';

/**
 * Proof, by content and by location, that no storyboard pixel reached the cut.
 *
 * The storyboard already declares itself `REFERENCE_ONLY`, and
 * `storyboard-package.ts` refuses a package that says otherwise. This module
 * exists because a declaration is a promise about intent and this milestone
 * needs evidence about bytes. It runs after the render manifest is built and
 * before FFmpeg is invoked, and it asks three separate questions:
 *
 * 1. Does any source in the manifest resolve to a path inside the storyboard
 *    package? (Location.)
 * 2. Does any source's file hash to the same bytes as a storyboard frame or
 *    the contact sheet? (Content — this is the one that catches a frame
 *    copied elsewhere and renamed.)
 * 3. Did every storyboard frame stay unaccounted for in the output? (The same
 *    question from the other side, so a frame added to the manifest under any
 *    name still fails.)
 *
 * A failure here throws. It is an integrity failure, never an availability
 * one: there is no mode in which a run proceeds having failed to show that
 * reference material stayed out.
 */

export interface StagingExclusionProof {
  readonly stagingRoot: string;
  readonly filesChecked: number;
  readonly referenceChecksumCount: number;
  readonly anyFileMatchesReference: false;
  readonly anyFileInsideStoryboardPackage: false;
  readonly method: string;
}

/**
 * The pre-render half of the proof: nothing FFmpeg *could* read is reference
 * material.
 *
 * Stronger than checking the manifest, and run earlier. The manifest names
 * what the renderer was asked for; the staging root bounds what it is able to
 * reach at all. Proving the root clean before a single frame is encoded means
 * a reference frame could not enter the output even through a manifest defect.
 */
export async function proveStagingRootExclusion(input: {
  readonly stagingRoot: string;
  readonly storyboard: VerifiedStoryboardPackage;
}): Promise<StagingExclusionProof> {
  const stagingRoot = resolve(input.stagingRoot);
  const storyboardRoot = resolve(input.storyboard.storyboardRoot);
  const referenceChecksums = new Set(input.storyboard.excludedChecksums);

  const violations: ReferenceExclusionViolation[] = [];
  let filesChecked = 0;

  const queue: string[] = [stagingRoot];
  while (queue.length > 0) {
    const directory = queue.shift() as string;
    // eslint-disable-next-line no-await-in-loop -- a directory walk is inherently sequential
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      filesChecked += 1;

      if (containedIn(storyboardRoot, absolutePath)) {
        violations.push({
          kind: 'PATH_INSIDE_STORYBOARD',
          sourceId: relative(stagingRoot, absolutePath),
          detail: 'a staged file resolves inside the storyboard package',
        });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- as above
      const checksum = createHash('sha256')
        .update(await readFile(absolutePath))
        .digest('hex');
      if (referenceChecksums.has(checksum)) {
        violations.push({
          kind: 'CHECKSUM_MATCHES_REFERENCE',
          sourceId: relative(stagingRoot, absolutePath),
          detail: 'a staged file is byte-identical to storyboard reference material',
        });
      }
    }
  }

  if (violations.length > 0) throw new ReferenceExclusionError(violations);

  return {
    stagingRoot,
    filesChecked,
    referenceChecksumCount: referenceChecksums.size,
    anyFileMatchesReference: false,
    anyFileInsideStoryboardPackage: false,
    method:
      'every file in the staging root — the only media root the renderer is permitted to read — was hashed and compared to every storyboard checksum before FFmpeg was invoked.',
  };
}

export interface ReferenceExclusionViolation {
  readonly kind:
    'PATH_INSIDE_STORYBOARD' | 'CHECKSUM_MATCHES_REFERENCE' | 'FRAME_PRESENT_IN_OUTPUT';
  readonly sourceId: string;
  readonly detail: string;
}

export class ReferenceExclusionError extends Error {
  constructor(public readonly violations: readonly ReferenceExclusionViolation[]) {
    super(
      `Reference material reached the production manifest:\n${violations
        .map((violation) => `  - ${violation.kind} (${violation.sourceId}): ${violation.detail}`)
        .join('\n')}`,
    );
    this.name = 'ReferenceExclusionError';
  }
}

export interface ReferenceExclusionProof {
  readonly storyboardRoot: string;
  readonly storyboardUsageClass: 'REFERENCE_ONLY';
  readonly storyboardOutputEligible: false;
  readonly referenceChecksumCount: number;
  readonly manifestSourceCount: number;
  /** Every source, with the checksum that was actually recomputed from disk. */
  readonly verifiedSources: readonly {
    readonly sourceId: string;
    readonly checksumSha256: string;
    readonly insideStoryboardPackage: false;
    readonly matchesReferenceChecksum: false;
  }[];
  readonly frames: readonly {
    readonly frameId: string;
    readonly checksumSha256: string;
    readonly presentInOutput: false;
    readonly referenceOnly: true;
    readonly outputEligible: false;
  }[];
  readonly anyReferenceOutputEligible: false;
  readonly method: string;
}

function containedIn(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

/**
 * Recomputes every manifest source's checksum from disk and compares it to
 * the storyboard's.
 *
 * Deliberately re-hashes rather than reading `expectedChecksum` off the
 * manifest: the manifest is the thing being checked, and a proof that trusts
 * its subject proves nothing.
 */
export async function proveReferenceExclusion(input: {
  readonly manifest: RenderManifest;
  readonly storyboard: VerifiedStoryboardPackage;
}): Promise<ReferenceExclusionProof> {
  const { manifest, storyboard } = input;
  const storyboardRoot = resolve(storyboard.storyboardRoot);
  const referenceChecksums = new Map<string, string>();
  for (const frame of storyboard.frames) {
    referenceChecksums.set(frame.checksumSha256, frame.frameId);
  }
  if (storyboard.contactSheet.checksumSha256) {
    referenceChecksums.set(storyboard.contactSheet.checksumSha256, 'contact-sheet');
  }

  const violations: ReferenceExclusionViolation[] = [];
  const verifiedSources: {
    sourceId: string;
    checksumSha256: string;
    insideStoryboardPackage: false;
    matchesReferenceChecksum: false;
  }[] = [];
  const framesInOutput = new Set<string>();

  for (const source of manifest.sources) {
    const absolutePath = resolve(source.path);
    if (containedIn(storyboardRoot, absolutePath)) {
      violations.push({
        kind: 'PATH_INSIDE_STORYBOARD',
        sourceId: source.id,
        detail: `resolves to ${absolutePath}, inside the storyboard package`,
      });
      continue;
    }

    let checksumSha256: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- ordered so the violation list is stable
      checksumSha256 = createHash('sha256')
        .update(await readFile(absolutePath))
        .digest('hex');
    } catch (error) {
      violations.push({
        kind: 'CHECKSUM_MATCHES_REFERENCE',
        sourceId: source.id,
        detail: `could not be re-hashed, so its exclusion cannot be shown: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const matched = referenceChecksums.get(checksumSha256);
    if (matched) {
      framesInOutput.add(matched);
      violations.push({
        kind: 'CHECKSUM_MATCHES_REFERENCE',
        sourceId: source.id,
        detail: `is byte-identical to storyboard ${matched}`,
      });
      continue;
    }

    verifiedSources.push({
      sourceId: source.id,
      checksumSha256,
      insideStoryboardPackage: false,
      matchesReferenceChecksum: false,
    });
  }

  for (const frame of storyboard.frames) {
    if (framesInOutput.has(frame.frameId)) {
      violations.push({
        kind: 'FRAME_PRESENT_IN_OUTPUT',
        sourceId: frame.frameId,
        detail: 'this storyboard frame is present in the render manifest',
      });
    }
  }

  if (violations.length > 0) throw new ReferenceExclusionError(violations);

  return {
    storyboardRoot,
    storyboardUsageClass: 'REFERENCE_ONLY',
    storyboardOutputEligible: false,
    referenceChecksumCount: referenceChecksums.size,
    manifestSourceCount: manifest.sources.length,
    verifiedSources: verifiedSources.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    frames: storyboard.frames.map((frame) => ({
      frameId: frame.frameId,
      checksumSha256: frame.checksumSha256,
      presentInOutput: false,
      referenceOnly: true,
      outputEligible: false,
    })),
    anyReferenceOutputEligible: false,
    method:
      'every render-manifest source was re-hashed from disk and compared to every storyboard frame checksum and to the contact sheet, and every source path was checked for containment in the storyboard package. Declarations were not trusted: the checksums were recomputed.',
  };
}

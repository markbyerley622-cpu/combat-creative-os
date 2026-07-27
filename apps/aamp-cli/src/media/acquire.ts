import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';
import {
  advanceCandidate,
  isInternalEvaluationOnly,
  type AcquiredProductionAsset,
  type MediaAcquisitionProvider,
  type MediaAcquisitionProviderId,
  type MediaAcquisitionRun,
  type MediaCandidate,
} from '@combat/providers';

import { usageForAcquisition, type AppliedApproval } from './approval';
import type { PrivateSourceLocation } from './pilot-pack';
import { evaluateSourceQuality, measureSourceMedia, sha256OfFile } from './source-quality';

/**
 * Fetching the approved bytes, then measuring them before believing anything.
 *
 * The order is the safety property, and it is the same one the ComfyUI adapter
 * settled on: **provider success never marks an asset usable**. Bytes are
 * downloaded, hashed, written, probed with ffprobe and scored against
 * `COMBAT_REVIEWS_PREMIUM_SOURCE_V1` — and only a file that survives all of
 * that reaches `INSPECTED`, and then `OUTPUT_ELIGIBLE`. A file that arrives
 * intact and measures below the profile is kept, reported and refused; it is
 * not silently promoted because the HTTP request returned 200.
 *
 * Two acquisition paths, one set of rules:
 *
 * - A **provider** candidate is downloaded through its adapter, which runs the
 *   approval gate first.
 * - An **external pack** candidate is already on disk. It is *copied* into the
 *   output directory rather than referenced in place, because a production
 *   manifest must not point at a path outside the repository that an operator
 *   could move, rename or delete without the manifest noticing. The original is
 *   never touched.
 */

export const ACQUISITION_FAILURE_KINDS = [
  'DOWNLOAD_FAILED',
  'SOURCE_FILE_MISSING',
  'MEASUREMENT_FAILED',
  'BELOW_SOURCE_PROFILE',
  'DUPLICATE_CONTENT',
  'NO_PROVIDER',
] as const;
export type AcquisitionFailureKind = (typeof ACQUISITION_FAILURE_KINDS)[number];

export interface AcquisitionFailure {
  readonly candidateId: string;
  readonly kind: AcquisitionFailureKind;
  readonly detail: string;
}

export interface AcquireOptions {
  readonly run: MediaAcquisitionRun;
  readonly approved: readonly AppliedApproval[];
  readonly providers: ReadonlyMap<MediaAcquisitionProviderId, MediaAcquisitionProvider>;
  /** Absolute paths into the operator's external folder, for pack candidates. */
  readonly privateLocations: readonly PrivateSourceLocation[];
  readonly outputDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries?: FfmpegBinaries;
  readonly now: Date;
  readonly signal?: AbortSignal;
  /**
   * Keep material that measures below the source profile. Recorded on the
   * asset, never inferred — an operator who wants a 720p clip for a small
   * overlay asks for it by name.
   */
  readonly acceptBelowProfile?: boolean;
  readonly onProgress?: (message: string) => void;
}

export interface AcquireResult {
  readonly run: MediaAcquisitionRun;
  readonly assets: readonly AcquiredProductionAsset[];
  readonly failures: readonly AcquisitionFailure[];
  /** Assets whose approval covers internal evaluation only, kept structurally apart. */
  readonly internalEvaluationOnly: readonly string[];
  readonly outputDirectory: string;
}

function extensionFor(
  candidate: MediaCandidate,
  renditionLabel: string,
  sourcePath?: string,
): string {
  if (sourcePath) {
    const existing = extname(sourcePath).toLowerCase();
    if (/^\.[a-z0-9]{2,5}$/.test(existing)) return existing;
  }
  const rendition = candidate.renditions.find((entry) => entry.label === renditionLabel);
  const declared = (rendition?.fileType ?? '').toLowerCase().replace(/^.*\//, '');
  if (/^[a-z0-9]{2,5}$/.test(declared)) return `.${declared}`;
  if (candidate.mediaKind === 'VIDEO') return '.mp4';
  if (candidate.mediaKind === 'AUDIO') return '.mp3';
  return '.jpg';
}

/**
 * The filename an acquired asset lands under.
 *
 * Content-addressed, exactly as captured screenshots are: `<candidateId>-<first
 * 16 of sha256><ext>`. Two acquisitions of the same bytes produce the same
 * name, so a re-run is idempotent rather than accumulating copies, and a file
 * whose name no longer matches its content is visibly wrong.
 */
export function acquiredFilename(candidateId: string, checksum: string, extension: string): string {
  const safeId = candidateId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  return `${safeId}-${checksum.slice(0, 16)}${extension}`;
}

export async function acquireApprovedAssets(options: AcquireOptions): Promise<AcquireResult> {
  await mkdir(options.outputDirectory, { recursive: true });

  const byId = new Map(
    options.run.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const locationsById = new Map(
    options.privateLocations.map((entry) => [entry.candidateId, entry]),
  );
  const assets: AcquiredProductionAsset[] = [];
  const failures: AcquisitionFailure[] = [];
  const internalOnly: string[] = [];
  const seenChecksums = new Map<string, string>();
  const updated = new Map<string, MediaCandidate>();

  for (const entry of options.approved) {
    const candidate = byId.get(entry.candidateId);
    if (!candidate) continue;

    const usage = usageForAcquisition(entry.selection.approval);
    let bytes: Uint8Array | null = null;
    let localSourcePath: string | null = null;
    let downloadHost = 'local';

    if (candidate.provider === 'EXTERNAL_PILOT_PACK') {
      const location = locationsById.get(candidate.candidateId);
      const exists = location ? await stat(location.absolutePath).catch(() => null) : null;
      if (!location || !exists?.isFile()) {
        failures.push({
          candidateId: candidate.candidateId,
          kind: 'SOURCE_FILE_MISSING',
          detail:
            'the imported candidate has no readable file at its recorded external location. The pack may have moved; re-run `aamp:media import-pack`.',
        });
        continue;
      }
      localSourcePath = location.absolutePath;
      downloadHost = 'external-pack';
    } else {
      const provider = options.providers.get(candidate.provider);
      if (!provider) {
        failures.push({
          candidateId: candidate.candidateId,
          kind: 'NO_PROVIDER',
          detail: `no configured adapter for ${candidate.provider}; check its API key`,
        });
        continue;
      }
      try {
        // The approval gate runs inside this call. There is no path that
        // downloads without passing it.
        const downloaded = await provider.downloadApprovedAsset(
          { candidate, selection: entry.selection, usage, now: options.now },
          { ...(options.signal ? { signal: options.signal } : {}) },
        );
        bytes = downloaded.bytes;
        downloadHost = downloaded.downloadHost;
      } catch (error) {
        failures.push({
          candidateId: candidate.candidateId,
          kind: 'DOWNLOAD_FAILED',
          detail: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    const checksum = bytes
      ? await sha256OfBytes(bytes)
      : await sha256OfFile(localSourcePath as string);

    const duplicateOwner = seenChecksums.get(checksum);
    if (duplicateOwner) {
      failures.push({
        candidateId: candidate.candidateId,
        kind: 'DUPLICATE_CONTENT',
        detail: `identical bytes to "${duplicateOwner}", already acquired in this run`,
      });
      continue;
    }

    const extension = extensionFor(
      candidate,
      entry.selection.renditionLabel,
      localSourcePath ?? undefined,
    );
    const filename = acquiredFilename(candidate.candidateId, checksum, extension);
    const destination = resolve(options.outputDirectory, filename);

    if (bytes) {
      await writeFile(destination, Buffer.from(bytes));
    } else {
      // Copied, never moved and never linked. The operator's folder is
      // read-only to this process, and a link would make the manifest depend on
      // a path outside the repository staying exactly where it is.
      await copyFile(localSourcePath as string, destination);
    }

    let measurements;
    try {
      measurements = await measureSourceMedia({
        filePath: destination,
        mediaKind: candidate.mediaKind,
        runner: options.runner,
        ...(options.binaries ? { binaries: options.binaries } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      failures.push({
        candidateId: candidate.candidateId,
        kind: 'MEASUREMENT_FAILED',
        detail: `the file was acquired but could not be measured, so nothing about it is established: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const qualityDecision = evaluateSourceQuality({
      measurements,
      mediaKind: candidate.mediaKind,
      ...(candidate.rightsDecision ? { rightsDecision: candidate.rightsDecision } : {}),
    });

    if (qualityDecision.outcome === 'BELOW_PROFILE' && !options.acceptBelowProfile) {
      failures.push({
        candidateId: candidate.candidateId,
        kind: 'BELOW_SOURCE_PROFILE',
        detail: `${qualityDecision.reasons.join('; ')}. The file was acquired and measured; it is not promoted. Pass --accept-below-profile to keep it deliberately.`,
      });
      // The bytes stay on disk so a person can look at them, but the candidate
      // does not advance and no manifest entry is built.
      continue;
    }

    seenChecksums.set(checksum, candidate.candidateId);

    const downloaded = advanceCandidate(candidate, 'DOWNLOADED');
    const inspected = advanceCandidate(downloaded, 'INSPECTED');
    const eligible = advanceCandidate(inspected, 'OUTPUT_ELIGIBLE');
    updated.set(eligible.candidateId, eligible);

    if (entry.internalEvaluationOnly || isInternalEvaluationOnly(entry.selection.approval)) {
      internalOnly.push(candidate.candidateId);
    }

    assets.push({
      assetId: candidate.candidateId.toLowerCase(),
      candidateId: candidate.candidateId,
      provider: candidate.provider,
      providerAssetId: candidate.providerAssetId,
      mediaKind: candidate.mediaKind,
      relativePath: `./${filename}`,
      checksumSha256: measurements.checksumSha256,
      fileSizeBytes: measurements.fileSizeBytes,
      measurements,
      qualityDecision,
      rights: candidate.rights,
      rightsDecision: entry.selection.rightsDecision,
      approval: entry.selection.approval,
      landingPageUrl: candidate.landingPageUrl,
      // A host, never the URL. A provider's direct file URL is frequently
      // signed or expiring, which makes it a credential rather than a link.
      downloadHost,
      downloadedAt: options.now.toISOString(),
      state: 'OUTPUT_ELIGIBLE',
    });

    options.onProgress?.(`${candidate.candidateId}: acquired, ${qualityDecision.outcome}`);
  }

  return {
    run: {
      ...options.run,
      candidates: options.run.candidates.map(
        (candidate) => updated.get(candidate.candidateId) ?? candidate,
      ),
    },
    assets,
    failures,
    internalEvaluationOnly: internalOnly,
    outputDirectory: options.outputDirectory,
  };
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

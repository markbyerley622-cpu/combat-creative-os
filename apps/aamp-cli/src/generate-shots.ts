import { NodeCommandRunner, probeMedia, type FfmpegBinaries } from '@combat/media';
import type {
  GeneratedCandidateRef,
  ReferenceImageInput,
  VideoGenerationProvider,
} from '@combat/providers';

import type { CampaignGenerationManifest, ManifestAsset } from './generation-manifest';
import type { GeneratedShotBrief } from './run-agents';

/**
 * Submits shot briefs to the configured generation provider, waits for real
 * output, and measures every produced file before it is allowed anywhere near
 * the renderer.
 *
 * The measurement is the point. A provider reporting `SUCCEEDED` is a claim;
 * ffprobe reading a 4.03-second h264 stream out of the file on disk is
 * evidence. Only the second one is allowed to reach the render manifest, which
 * is why `measuredDurationSeconds` — not the requested duration — is what the
 * timeline is later built from.
 */

export interface GeneratedShotResult {
  readonly brief: GeneratedShotBrief;
  readonly localPath: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly measuredDurationSeconds: number;
  readonly measuredWidthPx: number;
  readonly measuredHeightPx: number;
  readonly measuredVideoCodec: string;
  readonly measuredFrameRate: number;
  readonly provenance?: GeneratedCandidateRef['provenance'];
}

export interface GenerateShotsOptions {
  readonly manifest: CampaignGenerationManifest;
  readonly briefs: readonly GeneratedShotBrief[];
  readonly provider: VideoGenerationProvider;
  readonly binaries: FfmpegBinaries;
  readonly workflowRunId: string;
  /** Resolved absolute paths for reference-image assets, keyed by manifest asset id. */
  readonly referenceAssets: readonly { asset: ManifestAsset; absolutePath: string }[];
  readonly pollIntervalMs?: number;
  readonly onProgress?: (message: string) => void;
  /** Injected so tests need not sleep for real. */
  readonly delay?: (ms: number) => Promise<void>;
}

export class ShotGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShotGenerationError';
  }
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);

/**
 * The idempotency key for a CLI-driven attempt.
 *
 * Same construction the Activity uses — `(workflowRunId, stage, entityId,
 * attempt)` — so a re-run with the same run id lands on the same ComfyUI job
 * rather than paying for a second render.
 */
function idempotencyKey(workflowRunId: string, shotId: string, attempt: number): string {
  return `${workflowRunId}:GEN:${shotId}:${attempt}`;
}

function toReferenceInputs(
  referenceAssets: GenerateShotsOptions['referenceAssets'],
): ReferenceImageInput[] {
  return referenceAssets.map(({ asset, absolutePath }) => ({
    assetId: asset.id,
    role: 'STYLE' as const,
    localPath: absolutePath,
    mimeType: absolutePath.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    rights: {
      // ANALYSIS_ONLY was already rejected at manifest parse; anything that
      // reaches here is output-eligible, and the provider re-checks anyway.
      usageClass: asset.license.usageClass as 'OWNED' | 'LICENSED_FOR_OUTPUT' | 'GENERATED',
      rightsHolder: asset.license.rightsHolder,
      licenseType: asset.license.licenseType,
      ...(asset.license.expiresAt ? { expiresAt: asset.license.expiresAt } : {}),
    },
  }));
}

export async function generateShots(
  options: GenerateShotsOptions,
): Promise<readonly GeneratedShotResult[]> {
  const { manifest, briefs, provider, onProgress, binaries, workflowRunId, referenceAssets } =
    options;
  const delay = options.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? 3_000;
  const runner = new NodeCommandRunner();

  const references = toReferenceInputs(referenceAssets);
  const capabilities = provider.getCapabilities();
  const resolution = capabilities.supportedResolutions[0];
  const frameRate = capabilities.supportedFrameRates[0] ?? 24;

  const results: GeneratedShotResult[] = [];

  for (const brief of briefs) {
    const key = idempotencyKey(workflowRunId, brief.shotId, 1);
    onProgress?.(`submitting shot ${brief.index} (${brief.durationSeconds.toFixed(2)}s)`);

    // eslint-disable-next-line no-await-in-loop -- shots are generated one at a time so a single GPU is not oversubscribed
    const handle = await provider.submit({
      idempotencyKey: key,
      shotId: brief.shotId,
      mode: references.length > 0 ? 'IMAGE_TO_VIDEO' : 'TEXT_TO_VIDEO',
      promptText: brief.promptText,
      ...(brief.negativePrompt ? { negativePrompt: brief.negativePrompt } : {}),
      ...(references.length > 0 ? { referenceImages: references } : {}),
      candidateCount: manifest.generation.candidateCount,
      params: {
        durationSeconds: brief.durationSeconds,
        aspectRatio: '9:16',
        ...(resolution ? { resolution } : {}),
        frameRate,
        ...(manifest.generation.seed === undefined ? {} : { seed: manifest.generation.seed }),
      },
      creativeAttributes: brief.creativeAttributes,
    });

    let status = 'QUEUED';
    while (!TERMINAL.has(status)) {
      // eslint-disable-next-line no-await-in-loop -- polling is inherently sequential
      status = await provider.getStatus(handle);
      if (TERMINAL.has(status)) break;
      onProgress?.(`shot ${brief.index}: ${status}`);
      // eslint-disable-next-line no-await-in-loop -- same rationale
      await delay(pollIntervalMs);
    }

    if (status !== 'SUCCEEDED') {
      // eslint-disable-next-line no-await-in-loop -- only reached on the failure path
      const failure = await provider.getFailure(handle);
      throw new ShotGenerationError(
        `shot ${brief.index} ended in ${status}${failure ? `: ${failure.message}` : ''}`,
      );
    }

    // eslint-disable-next-line no-await-in-loop -- same rationale
    const candidates = await provider.fetchResult(handle);
    const candidate = candidates[0];
    if (!candidate) {
      throw new ShotGenerationError(`shot ${brief.index} succeeded but returned no candidate`);
    }
    if (!candidate.localPath) {
      throw new ShotGenerationError(
        `shot ${brief.index} returned a candidate with no local file — the configured provider produced no real media`,
      );
    }

    // eslint-disable-next-line no-await-in-loop -- same rationale
    const probe = await probeMedia(runner, candidate.localPath, {
      ffprobePath: binaries.ffprobe,
    });
    if (probe.mediaType !== 'VIDEO') {
      throw new ShotGenerationError(
        `shot ${brief.index} produced a ${probe.mediaType} file, not a video`,
      );
    }
    if (probe.durationSeconds <= 0 || (candidate.sizeBytes ?? 0) <= 0) {
      throw new ShotGenerationError(
        `shot ${brief.index} produced an empty clip (${candidate.sizeBytes ?? 0} bytes, ${probe.durationSeconds}s)`,
      );
    }

    onProgress?.(
      `shot ${brief.index}: ${probe.widthPx}x${probe.heightPx} ${probe.videoCodec} ${probe.durationSeconds.toFixed(3)}s`,
    );

    results.push({
      brief,
      localPath: candidate.localPath,
      checksumSha256: candidate.checksumSha256 ?? '',
      sizeBytes: candidate.sizeBytes ?? 0,
      measuredDurationSeconds: probe.durationSeconds,
      measuredWidthPx: probe.widthPx,
      measuredHeightPx: probe.heightPx,
      measuredVideoCodec: probe.videoCodec,
      measuredFrameRate: probe.frameRate,
      ...(candidate.provenance ? { provenance: candidate.provenance } : {}),
    });
  }

  return results;
}

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeclaredMediaType, MediaProvider } from '@combat/media';
import type { AssetDataSource } from '@combat/database';
import { getAsset, recordMediaInspectionResult } from '@combat/database';
import type { MediaMetadata } from '@combat/domain';
import type { StorageProvider } from '@combat/providers';

export class AssetNotFoundError extends Error {
  constructor(workspaceId: string, assetId: string) {
    super(`Asset ${assetId} not found in workspace ${workspaceId}`);
    this.name = 'AssetNotFoundError';
  }
}

export interface InspectMediaInput {
  readonly workspaceId: string;
  readonly assetId: string;
  readonly declaredMediaType: DeclaredMediaType;
  readonly maxBytes: number;
}

export type InspectMediaOutput =
  | { readonly ok: true; readonly mediaMetadata: MediaMetadata }
  | { readonly ok: false; readonly detail: string };

export interface InspectMediaActivityDeps {
  readonly storageProvider: StorageProvider;
  readonly mediaProvider: MediaProvider;
  readonly assetDb: AssetDataSource;
}

/**
 * Downloads the asset's bytes to a scratch temp file (ffprobe needs a local
 * path, not a stream) and probes it, persisting the typed result either way
 * via `recordMediaInspectionResult` — this Activity's job is exactly
 * "inspecting media" + "recording success or typed failure" (M5
 * requirement 5), nothing else. Not wired into any workflow yet, matching
 * ADR-0004/M3's own "the Activity exists before anything calls it" pattern
 * — see docs/architecture.md's M5 entry.
 */
export function createInspectMediaActivity(
  deps: InspectMediaActivityDeps,
): (input: InspectMediaInput) => Promise<InspectMediaOutput> {
  return async function inspectMediaActivity(
    input: InspectMediaInput,
  ): Promise<InspectMediaOutput> {
    const asset = await getAsset(deps.assetDb, input.workspaceId, input.assetId);
    if (!asset) {
      throw new AssetNotFoundError(input.workspaceId, input.assetId);
    }

    const { body } = await deps.storageProvider.getObject(asset.s3Key);
    const scratchDir = await mkdtemp(join(tmpdir(), 'combat-media-inspect-'));
    const scratchPath = join(scratchDir, `${randomUUID()}-${asset.originalFilename}`);

    try {
      await writeFile(scratchPath, body);
      const probeResult = await deps.mediaProvider.probe({
        filePath: scratchPath,
        declaredMediaType: input.declaredMediaType,
        actualSizeBytes: asset.sizeBytes,
        maxBytes: input.maxBytes,
      });
      await recordMediaInspectionResult(deps.assetDb, asset.id, {
        ok: true,
        mediaMetadata: probeResult,
      });
      return { ok: true, mediaMetadata: probeResult };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await recordMediaInspectionResult(deps.assetDb, asset.id, {
        ok: false,
        failureDetails: detail,
      });
      return { ok: false, detail };
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  };
}

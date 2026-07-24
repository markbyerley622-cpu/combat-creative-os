import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaProvider, ProxyProfile } from '@combat/media';
import type { AssetDataSource, AssetRecord } from '@combat/database';
import { createAssetWithProvenance, findAssetByChecksum, getAsset } from '@combat/database';
import type { StorageProvider } from '@combat/providers';

export class SourceAssetNotFoundError extends Error {
  constructor(workspaceId: string, assetId: string) {
    super(`Source asset ${assetId} not found in workspace ${workspaceId}`);
    this.name = 'SourceAssetNotFoundError';
  }
}

const ACTIVITY_NAME = 'generateMediaProxyActivity';

export interface GenerateMediaProxyInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly sourceAssetId: string;
  readonly kind: 'THUMBNAIL' | 'PROXY';
  readonly thumbnail?: { readonly timestampSeconds?: number; readonly widthPx?: number };
  readonly proxy?: { readonly profile: ProxyProfile };
}

export type GenerateMediaProxyOutput =
  | { readonly ok: true; readonly asset: AssetRecord; readonly deduped: boolean }
  | { readonly ok: false; readonly detail: string };

export interface GenerateMediaProxyActivityDeps {
  readonly storageProvider: StorageProvider;
  readonly mediaProvider: MediaProvider;
  readonly assetDb: AssetDataSource;
}

/**
 * Output object keys are content-addressed (sha256 of source checksum +
 * kind + profile/timestamp), matching docs/architecture.md §5's
 * `FfmpegService` doc comment: "idempotent output paths (content-addressed
 * by input hash + profile)". Two identical requests therefore write to the
 * same key and dedupe to the same Asset row via the usual checksum lookup —
 * no separate idempotency-key bookkeeping needed here.
 */
function buildDerivedS3Key(input: {
  workspaceId: string;
  campaignId: string;
  sourceChecksum: string;
  kind: 'THUMBNAIL' | 'PROXY';
  profileKey: string;
}): string {
  const addressHash = createHash('sha256')
    .update(`${input.sourceChecksum}:${input.kind}:${input.profileKey}`)
    .digest('hex')
    .slice(0, 32);
  const extension = input.kind === 'THUMBNAIL' ? 'jpg' : 'mp4';
  return `workspaces/${input.workspaceId}/campaigns/${input.campaignId}/derived/${input.kind.toLowerCase()}/${addressHash}.${extension}`;
}

/**
 * "generating a proxy/thumbnail through the injected media provider" (M5
 * requirement 5) — downloads the source asset, runs `MediaProvider`, uploads
 * the result, and records it as a new derived Asset with provenance back to
 * the source. `generatedByActivity` (not `createdByAgentInvocationId`/
 * `uploadedByUserId`) marks the actor, since this is a deterministic
 * pipeline step, not an agent reasoning call or a direct human upload — see
 * packages/domain's AssetSchema doc comment on the three-way XOR.
 */
export function createGenerateMediaProxyActivity(
  deps: GenerateMediaProxyActivityDeps,
): (input: GenerateMediaProxyInput) => Promise<GenerateMediaProxyOutput> {
  return async function generateMediaProxyActivity(
    input: GenerateMediaProxyInput,
  ): Promise<GenerateMediaProxyOutput> {
    const source = await getAsset(deps.assetDb, input.workspaceId, input.sourceAssetId);
    if (!source) {
      throw new SourceAssetNotFoundError(input.workspaceId, input.sourceAssetId);
    }

    const profileKey =
      input.kind === 'THUMBNAIL'
        ? `t=${input.thumbnail?.timestampSeconds ?? 1};w=${input.thumbnail?.widthPx ?? 640}`
        : `profile=${input.proxy?.profile ?? 'PREVIEW_720P'}`;

    const derivedS3Key = buildDerivedS3Key({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      sourceChecksum: source.checksum,
      kind: input.kind,
      profileKey,
    });

    const scratchDir = await mkdtemp(join(tmpdir(), 'combat-media-proxy-'));
    const sourcePath = join(scratchDir, `${randomUUID()}-source`);
    const outputPath = join(
      scratchDir,
      `${randomUUID()}-output.${input.kind === 'THUMBNAIL' ? 'jpg' : 'mp4'}`,
    );

    try {
      const { body } = await deps.storageProvider.getObject(source.s3Key);
      await writeFile(sourcePath, body);

      if (input.kind === 'THUMBNAIL') {
        await deps.mediaProvider.generateThumbnail({
          sourcePath,
          outputPath,
          timestampSeconds: input.thumbnail?.timestampSeconds,
          widthPx: input.thumbnail?.widthPx,
        });
      } else {
        await deps.mediaProvider.generateProxy({
          sourcePath,
          outputPath,
          profile: input.proxy?.profile ?? 'PREVIEW_720P',
        });
      }

      const outputBytes = await readFile(outputPath);
      const { checksum } = await deps.storageProvider.putObject({
        s3Key: derivedS3Key,
        body: outputBytes,
        contentType: input.kind === 'THUMBNAIL' ? 'image/jpeg' : 'video/mp4',
      });

      const existing = await findAssetByChecksum(
        deps.assetDb,
        input.workspaceId,
        checksum,
        input.kind,
      );
      if (existing) {
        return { ok: true, asset: existing, deduped: true };
      }

      const { asset } = await createAssetWithProvenance(deps.assetDb, input.workspaceId, {
        campaignId: input.campaignId,
        kind: input.kind,
        s3Key: derivedS3Key,
        checksum,
        mimeType: input.kind === 'THUMBNAIL' ? 'image/jpeg' : 'video/mp4',
        originalFilename: `${input.kind.toLowerCase()}${input.kind === 'THUMBNAIL' ? '.jpg' : '.mp4'}`,
        sizeBytes: outputBytes.byteLength,
        ingestionStatus: 'READY',
        generatedByActivity: ACTIVITY_NAME,
        derivedFromAssetIds: [source.id],
      });

      return { ok: true, asset, deduped: false };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, detail };
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  };
}

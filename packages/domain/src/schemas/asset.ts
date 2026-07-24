import { z } from 'zod';
import { AssetIngestionStatusSchema, AssetKindSchema } from './shared-enums';

/**
 * M5: the shape `inspectMediaActivity` (packages/workflows) persists onto
 * `Asset.mediaMetadata` after a successful probe. Defined independently
 * here (not imported from `@combat/media`) — `packages/domain` doesn't
 * depend on `packages/media` (CLAUDE.md dependency direction), and this is
 * the persistence-shape source of truth `packages/media`'s own
 * `MediaProbeResult` type is expected to stay structurally compatible with,
 * the same way agent output types mirror `@combat/domain` entities
 * elsewhere in this codebase.
 */
export const ImageMediaMetadataSchema = z.object({
  mediaType: z.literal('IMAGE'),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  format: z.string().min(1),
  colorSpace: z.string().optional(),
});
export type ImageMediaMetadata = z.infer<typeof ImageMediaMetadataSchema>;

export const VideoMediaMetadataSchema = z.object({
  mediaType: z.literal('VIDEO'),
  durationSeconds: z.number().nonnegative(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  frameRate: z.number().nonnegative(),
  videoCodec: z.string().min(1),
  hasAudio: z.boolean(),
  audioCodec: z.string().optional(),
});
export type VideoMediaMetadata = z.infer<typeof VideoMediaMetadataSchema>;

export const AudioMediaMetadataSchema = z.object({
  mediaType: z.literal('AUDIO'),
  durationSeconds: z.number().nonnegative(),
  codec: z.string().min(1),
  channels: z.number().int().nonnegative(),
  sampleRateHz: z.number().int().nonnegative(),
});
export type AudioMediaMetadata = z.infer<typeof AudioMediaMetadataSchema>;

export const MediaMetadataSchema = z.discriminatedUnion('mediaType', [
  ImageMediaMetadataSchema,
  VideoMediaMetadataSchema,
  AudioMediaMetadataSchema,
]);
export type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

export const AssetSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    /** The campaign this asset was originally ingested for. A workspace-wide checksum-deduped re-upload keeps the first campaign's id — see asset-repository.ts's `findAssetByChecksum` doc comment. */
    campaignId: z.string().uuid(),
    kind: AssetKindSchema,
    s3Key: z.string().min(1),
    checksum: z.string().min(1),
    mimeType: z.string().min(1),
    originalFilename: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    ingestionStatus: AssetIngestionStatusSchema.default('PENDING'),
    mediaMetadata: MediaMetadataSchema.optional(),
    inspectionFailureDetails: z.string().optional(),
    createdByAgentInvocationId: z.string().uuid().optional(),
    uploadedByUserId: z.string().uuid().optional(),
    /** M5: set (instead of the other two) for a derived asset an Activity produced deterministically — a thumbnail/proxy from generate-media-proxy-activity.ts, with no agent reasoning call and no direct human upload involved. Holds the producing activity's name for audit, mirroring how `createdByAgentInvocationId` names its own actor. */
    generatedByActivity: z.string().min(1).optional(),
    createdAt: z.date(),
  })
  .refine(
    (asset) =>
      [
        Boolean(asset.createdByAgentInvocationId),
        Boolean(asset.uploadedByUserId),
        Boolean(asset.generatedByActivity),
      ].filter(Boolean).length === 1,
    {
      message:
        'exactly one of createdByAgentInvocationId, uploadedByUserId, or generatedByActivity must be set',
    },
  );
export type Asset = z.infer<typeof AssetSchema>;

/**
 * Kept separate from Asset (rather than inlined) because provenance chains
 * are multi-hop — architecture.md §4.3. `derivedFromAssetIds` is empty only
 * for a root asset with no generative/compositing ancestry (e.g. a directly
 * uploaded brand asset).
 */
export const AssetProvenanceSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  assetId: z.string().uuid(),
  derivedFromAssetIds: z.array(z.string().uuid()).default([]),
  producedByInvocationId: z.string().uuid().optional(),
  providerJobRef: z.string().optional(),
  createdAt: z.date(),
});
export type AssetProvenance = z.infer<typeof AssetProvenanceSchema>;

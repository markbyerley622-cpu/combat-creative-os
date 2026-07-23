import { z } from 'zod';
import { AssetKindSchema } from './shared-enums';

export const AssetSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    kind: AssetKindSchema,
    s3Key: z.string().min(1),
    checksum: z.string().min(1),
    mimeType: z.string().min(1),
    createdByAgentInvocationId: z.string().uuid().optional(),
    uploadedByUserId: z.string().uuid().optional(),
    createdAt: z.date(),
  })
  .refine(
    (asset) => Boolean(asset.createdByAgentInvocationId) !== Boolean(asset.uploadedByUserId),
    {
      message: 'exactly one of createdByAgentInvocationId or uploadedByUserId must be set',
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

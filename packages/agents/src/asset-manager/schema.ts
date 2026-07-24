import { z } from 'zod';

/**
 * Intended input/output boundary per docs/architecture.md §6.1 ("Asset
 * Manager | Shot[], brand asset library refs | AssetManifest { shotId →
 * requiredAssets[], licensingFlags[] }"). Not yet implemented — see
 * `agent.ts`. Preserved so the eventual real implementation has an agreed
 * contract to build against rather than inventing one from scratch.
 */
export const AssetManagerInputSchema = z.object({
  shots: z.array(z.object({ index: z.number().int().nonnegative(), description: z.string().min(1) })).min(1),
  brandAssetLibraryRefs: z.array(z.string().min(1)).default([]),
});
export type AssetManagerInput = z.infer<typeof AssetManagerInputSchema>;

export const AssetManagerResultSchema = z.object({
  manifest: z.array(
    z.object({
      shotIndex: z.number().int().nonnegative(),
      requiredAssets: z.array(z.string().min(1)),
      licensingFlags: z.array(z.string()).default([]),
    }),
  ),
});
export type AssetManagerResult = z.infer<typeof AssetManagerResultSchema>;

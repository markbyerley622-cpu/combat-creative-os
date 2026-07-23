import { z } from 'zod';
import { CreativeVariantStatusSchema } from './shared-enums';

export const CreativeVariantSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  deliverySpecificationId: z.string().uuid(),
  durationSeconds: z.number().int().positive(),
  assetId: z.string().uuid().optional(),
  status: CreativeVariantStatusSchema,
  createdAt: z.date(),
});
export type CreativeVariant = z.infer<typeof CreativeVariantSchema>;

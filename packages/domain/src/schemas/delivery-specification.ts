import { z } from 'zod';
import { DeliveryPlatformSchema } from './shared-enums';

export const DeliverySpecificationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  platform: DeliveryPlatformSchema,
  aspectRatio: z.string().min(1),
  durationSeconds: z.number().int().positive(),
  safeArea: z.record(z.string(), z.unknown()).optional(),
  captionBurnRequired: z.boolean().default(false),
  format: z.string().min(1),
  createdAt: z.date(),
});
export type DeliverySpecification = z.infer<typeof DeliverySpecificationSchema>;

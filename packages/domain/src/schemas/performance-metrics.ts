import { z } from 'zod';
import { DeliveryPlatformSchema } from './shared-enums';

export const PerformanceMetricsSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  creativeVariantId: z.string().uuid(),
  platform: DeliveryPlatformSchema,
  impressions: z.number().int().nonnegative(),
  clicks: z.number().int().nonnegative(),
  conversions: z.number().int().nonnegative(),
  spendCents: z.number().int().nonnegative(),
  ctr: z.number().nonnegative(),
  collectedAt: z.date(),
});
export type PerformanceMetrics = z.infer<typeof PerformanceMetricsSchema>;

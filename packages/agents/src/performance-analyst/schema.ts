import { z } from 'zod';
import { DeliveryPlatformSchema } from '@combat/domain';

export const PerformanceAnalystInputSchema = z.object({
  metrics: z
    .array(
      z.object({
        platform: DeliveryPlatformSchema,
        impressions: z.number().int().nonnegative(),
        clicks: z.number().int().nonnegative(),
        conversions: z.number().int().nonnegative(),
        spendCents: z.number().int().nonnegative(),
        ctr: z.number().nonnegative(),
      }),
    )
    .min(1),
});
export type PerformanceAnalystInput = z.infer<typeof PerformanceAnalystInputSchema>;

/**
 * `Learning` is not yet a persisted `@combat/domain` entity (architecture.md
 * §4.1 names it as a future "Learning" store) — defined locally here rather
 * than in the domain package until a database milestone promotes it into a
 * real schema + Prisma table.
 */
export const LearningSchema = z.object({
  insight: z.string().min(1),
  appliesTo: z.enum(['strategy', 'concept', 'prompting']),
  tags: z.array(z.string().min(1)).default([]),
});
export type Learning = z.infer<typeof LearningSchema>;

export const PerformanceAnalystResultSchema = z.object({
  learnings: z.array(LearningSchema).min(1),
});
export type PerformanceAnalystResult = z.infer<typeof PerformanceAnalystResultSchema>;

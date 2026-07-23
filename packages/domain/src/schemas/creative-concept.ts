import { z } from 'zod';

export const CreativeConceptSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  version: z.number().int().positive(),
  logline: z.string().min(1),
  visualDirection: z.string().min(1),
  narrativeArc: z.string().min(1),
  referenceNotes: z.array(z.string()).default([]),
  createdAt: z.date(),
});
export type CreativeConcept = z.infer<typeof CreativeConceptSchema>;

export const VisualLanguageSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  creativeConceptId: z.string().uuid(),
  colorPalette: z.array(z.string().min(1)).default([]),
  typography: z.record(z.string(), z.unknown()).default({}),
  motionPrinciples: z.array(z.string().min(1)).default([]),
  brandAssetRefs: z.array(z.string().min(1)).default([]),
  createdAt: z.date(),
});
export type VisualLanguage = z.infer<typeof VisualLanguageSchema>;

import { z } from 'zod';
import {
  DeliveryPlatformSchema,
  ShotBeatSchema,
  TextSafeAreaSchema,
  TransitionTypeSchema,
} from './shared-enums';

/**
 * M9 — the canonical, versioned rough-edit / timeline specification the Edit
 * Director produces from a human-approved `ShotSelectionSet`. Immutable and
 * versioned per campaign (a re-composition produces a new version); every
 * clip pins the exact SELECTED source asset, so the spec is a complete,
 * self-contained recipe a real compositing worker could render. The timeline
 * (tracks / clip instances / transitions) and overlays are modeled as
 * validated nested structures (canonical, not free-form JSON) — the same
 * "validated JSON structure on a versioned row" approach `ShotSpecification`
 * uses for its params/requirements.
 */
export const RoughEditClipSchema = z.object({
  order: z.number().int().nonnegative(),
  shotId: z.string().uuid(),
  shotIndex: z.number().int().nonnegative(),
  /** The SELECTED candidate's registered source asset. */
  sourceAssetId: z.string().uuid(),
  sourceInFrame: z.number().int().nonnegative(),
  sourceOutFrame: z.number().int().positive(),
  timelineStartFrame: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
  transitionIn: TransitionTypeSchema.optional(),
  continuityNote: z.string().optional(),
});
export type RoughEditClip = z.infer<typeof RoughEditClipSchema>;

export const ROUGH_EDIT_TRACK_TYPES = ['VIDEO', 'OVERLAY', 'AUDIO'] as const;
export const RoughEditTrackTypeSchema = z.enum(ROUGH_EDIT_TRACK_TYPES);
export type RoughEditTrackType = z.infer<typeof RoughEditTrackTypeSchema>;

export const RoughEditTrackSchema = z.object({
  trackType: RoughEditTrackTypeSchema,
  clips: z.array(RoughEditClipSchema).default([]),
});
export type RoughEditTrack = z.infer<typeof RoughEditTrackSchema>;

export const ROUGH_EDIT_OVERLAY_KINDS = [
  'GRAPHIC',
  'APP_INTERFACE',
  'TYPOGRAPHY',
  'CTA',
  'CAPTION',
] as const;
export const RoughEditOverlayKindSchema = z.enum(ROUGH_EDIT_OVERLAY_KINDS);
export type RoughEditOverlayKind = z.infer<typeof RoughEditOverlayKindSchema>;

export const RoughEditOverlaySchema = z.object({
  kind: RoughEditOverlayKindSchema,
  shotIndex: z.number().int().nonnegative().optional(),
  description: z.string().min(1),
  /** Optional design-provider asset ref (a Figma export handoff) — never a storage key. */
  designAssetRef: z.string().optional(),
});
export type RoughEditOverlay = z.infer<typeof RoughEditOverlaySchema>;

export const RoughEditSpecificationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  creativeConceptId: z.string().uuid(),
  creativeConceptVersion: z.number().int().positive(),
  scriptId: z.string().uuid(),
  scriptVersion: z.number().int().positive(),
  shotSelectionSetId: z.string().uuid(),
  shotSelectionSetVersion: z.number().int().positive(),
  version: z.number().int().positive(),

  // --- Output format ---
  outputFormat: z.string().min(1),
  aspectRatio: z.string().min(1),
  resolutionWidth: z.number().int().positive(),
  resolutionHeight: z.number().int().positive(),
  frameRate: z.number().int().positive(),
  targetDurationFrames: z.number().int().positive(),

  // --- Timeline (ordered tracks -> clip instances -> transitions) ---
  tracks: z.array(RoughEditTrackSchema).min(1),

  // --- Overlays: graphic / app-interface / typography / CTA / caption ---
  overlays: z.array(RoughEditOverlaySchema).default([]),

  // --- Creative direction ---
  pacingNotes: z.string(),
  beatStructure: z
    .array(z.object({ beat: ShotBeatSchema, shotIndices: z.array(z.number().int().nonnegative()) }))
    .default([]),
  continuityNotes: z.array(z.string()).default([]),
  textSafeAreas: z.array(TextSafeAreaSchema).default([]),
  brandTokens: z.array(z.string()).default([]),

  // --- Downstream-stage placeholders (M10+ fills these) ---
  captionPlaceholder: z.string(),
  musicPlaceholder: z.string(),
  sfxPlaceholder: z.string(),

  // --- Delivery ---
  platform: DeliveryPlatformSchema,
  platformDeliveryNotes: z.string(),

  // --- Rationale / QA / provenance ---
  editRationale: z.string().min(1),
  qualityRubric: z.array(z.string()).default([]),
  promptVersionId: z.string().uuid(),
  createdByAgentInvocationId: z.string().uuid(),
  createdAt: z.date(),
});
export type RoughEditSpecification = z.infer<typeof RoughEditSpecificationSchema>;

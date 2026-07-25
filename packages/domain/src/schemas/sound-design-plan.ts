import { z } from 'zod';

/**
 * M10 — the Sound Director's canonical, versioned sound-design plan for one
 * campaign's rough edit. The music brief + mix notes live here; the concrete
 * cues are `SoundCue` rows attached to the plan's `Timeline` (each cue may
 * carry a `SOUND_STEM` asset once a stem is produced). Immutable and versioned
 * per campaign (a SOUND_DESIGN revision writes a new version); workspace-scoped.
 * `WorkflowRun ||--|| SoundDesignPlan` in docs/architecture.md §4's ER.
 */
export const SoundDesignPlanSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  /** The Timeline the SoundCues are attached to (built from the rough edit). */
  timelineId: z.string().uuid(),
  /** The rough edit this plan scores. */
  roughEditSpecificationId: z.string().uuid(),
  version: z.number().int().positive(),
  musicBrief: z.string().min(1),
  mixNotes: z.string().min(1),
  brandAudioGuidelines: z.array(z.string()).default([]),
  qualityRubric: z.array(z.string()).default([]),
  promptVersionId: z.string().uuid(),
  createdByAgentInvocationId: z.string().uuid(),
  createdAt: z.date(),
});
export type SoundDesignPlan = z.infer<typeof SoundDesignPlanSchema>;

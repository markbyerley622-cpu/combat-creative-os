import { readFile } from 'node:fs/promises';

import { z } from 'zod';

/**
 * The approved production treatment — the document a person signs off before
 * anything is staged, and the one place the creative thinking behind this cut
 * is written down.
 *
 * It is authored, validated and versioned, never generated. Every field here
 * is a judgement: what the idea is, what tension it works on, how the product
 * carries it, how the picture is built, how the sound is meant to behave, what
 * the cut may not imply. Application code that produced any of these would be
 * writing the advertisement, which is the failure the launch and finishing
 * milestones both exist to prevent.
 *
 * The schema's job is narrow and worth being precise about: it makes the
 * treatment *complete*. A treatment missing its prohibited implications, or
 * missing a feasibility note for a beat, is one that has not actually been
 * thought through — and the artefact that records it would imply otherwise.
 */

export const PRODUCTION_TREATMENT_VERSION = 1 as const;

const NonEmpty = (max: number) => z.string().min(1).max(max);

/** Every transition names the narrative or visual reason it exists. */
export const TransitionMotivationSchema = z
  .object({
    fromBeatId: NonEmpty(60),
    toBeatId: NonEmpty(60),
    family: z.enum([
      'IMPACT_CUT',
      'ACTION_MATCH',
      'GRAPHIC_MATCH',
      'SOUND_BRIDGE',
      'CAMERA_WIPE',
      'UI_TO_WORLD',
    ]),
    /** Why this cut happens here. A transition with no motivation is a template. */
    motivation: NonEmpty(400),
  })
  .strict();

export const AudioCueSheetEntrySchema = z
  .object({
    moment: z.enum([
      'OPENING_NOTIFICATION',
      'BREADTH_ACCELERATION',
      'PRODUCT_REVEAL',
      'FIGHT_IMPACT',
      'PREDICTION_CONFIRMATION',
      'SOCIAL_REACTION_LIFT',
      'DISCUSSION_TRANSITION',
      'CTA_RESOLVE',
    ]),
    atSeconds: z.number().min(0).max(60),
    intent: NonEmpty(300),
    /** What actually plays there today, which is not the same thing. */
    suppliedBy: NonEmpty(200),
    isTemporary: z.boolean(),
  })
  .strict();

export const BeatFeasibilitySchema = z
  .object({
    beatId: NonEmpty(60),
    storyboardFrameId: z.string().regex(/^FRAME-(0[1-9]|10)$/),
    /** What the storyboard asked for. */
    requiredAsset: NonEmpty(400),
    /** What exists, and whether it is the thing that was asked for. */
    feasibility: z.enum(['AS_STORYBOARDED', 'SUBSTITUTED', 'REDESIGNED', 'OMITTED']),
    note: NonEmpty(600),
  })
  .strict();

export const ProductAttentionEntrySchema = z
  .object({
    beatId: NonEmpty(60),
    /** What the viewer's eye is meant to be on, and what it is meant to read. */
    focus: NonEmpty(300),
    productVisible: z.boolean(),
    comprehensionGoal: NonEmpty(300),
  })
  .strict();

export const ProductionTreatmentSchema = z
  .object({
    treatmentVersion: z.literal(PRODUCTION_TREATMENT_VERSION),
    campaignId: z.string().uuid(),
    storyboardId: NonEmpty(120),
    approvedBy: NonEmpty(200),
    approvedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
    /**
     * How many storyboard panels this treatment has to answer for.
     *
     * Defaults to eight, which is what every treatment written before the
     * locked ten-panel storyboard existed declares by omission. A treatment
     * that says ten must answer for ten: the completeness check below reads
     * this rather than a constant, so a longer storyboard cannot quietly pass
     * with two panels nobody decided about.
     */
    storyboardFrameCount: z.number().int().min(1).max(24).default(8),

    /** One sentence. If it needs two, the idea is not finished. */
    strategicIdea: z.string().min(1).max(300),
    audienceTension: NonEmpty(800),
    productMechanism: NonEmpty(800),
    emotionalProgression: z.array(NonEmpty(300)).min(3).max(12),

    cameraGrammar: NonEmpty(1200),
    lightingAndColourGrammar: NonEmpty(1200),
    motionGrammar: NonEmpty(1200),
    transitionGrammar: z.array(TransitionMotivationSchema).min(1).max(24),
    typographyGrammar: NonEmpty(1200),

    audioCueSheet: z.array(AudioCueSheetEntrySchema).min(1).max(16),
    productAttentionMap: z.array(ProductAttentionEntrySchema).min(1).max(24),
    assetFeasibility: z.array(BeatFeasibilitySchema).min(1).max(24),

    /** What this cut must never be read as saying. */
    prohibitedImplications: z.array(NonEmpty(400)).min(1).max(24),
    /**
     * Which approved benchmark material informed the craft, by profile and
     * reference id only. Never copy, never a frame, never a path.
     */
    benchmarkEvidenceReferences: z
      .array(
        z
          .object({
            benchmarkProfileKey: NonEmpty(120),
            referenceId: NonEmpty(120),
            observationUsed: NonEmpty(400),
          })
          .strict(),
      )
      .max(24)
      .default([]),
    originalityStatement: NonEmpty(1200),
  })
  .strict()
  .superRefine((treatment, ctx) => {
    const addIssue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };

    // Every one of the eight storyboard frames needs a feasibility answer. A
    // beat with no answer is one nobody decided about.
    const frames = new Set(treatment.assetFeasibility.map((entry) => entry.storyboardFrameId));
    for (let index = 1; index <= treatment.storyboardFrameCount; index += 1) {
      const frameId = `FRAME-${String(index).padStart(2, '0')}`;
      if (!frames.has(frameId)) {
        addIssue(
          `no asset feasibility entry for ${frameId}; every storyboard frame needs an answer, including "OMITTED"`,
          ['assetFeasibility'],
        );
      }
    }

    // The audio cue sheet has to cover every moment the brief named, so a
    // silent gap is a decision rather than an oversight.
    const moments = new Set(treatment.audioCueSheet.map((entry) => entry.moment));
    for (const moment of AudioCueSheetEntrySchema.shape.moment.options) {
      if (!moments.has(moment)) {
        addIssue(`the audio cue sheet has no entry for ${moment}`, ['audioCueSheet']);
      }
    }

    const substituted = treatment.assetFeasibility.filter(
      (entry) => entry.feasibility !== 'AS_STORYBOARDED',
    );
    if (substituted.length > 0 && treatment.prohibitedImplications.length === 0) {
      addIssue(
        'this treatment substitutes for the storyboard but names nothing the cut must not imply',
        ['prohibitedImplications'],
      );
    }
  });

export type ProductionTreatment = z.infer<typeof ProductionTreatmentSchema>;

export class ProductionTreatmentError extends Error {
  constructor(
    public readonly issues: readonly { path: string; message: string }[],
    public readonly treatmentPath?: string,
  ) {
    super(
      `The production treatment is incomplete${treatmentPath ? ` (${treatmentPath})` : ''}:\n${issues
        .map((issue) => `  - ${issue.path || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'ProductionTreatmentError';
  }
}

export function parseProductionTreatment(value: unknown, path?: string): ProductionTreatment {
  const result = ProductionTreatmentSchema.safeParse(value);
  if (result.success) return result.data;
  throw new ProductionTreatmentError(
    result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
    path,
  );
}

/** Reads a treatment and proves it belongs to this campaign and this storyboard. */
export async function loadProductionTreatment(
  treatmentPath: string,
  expected: { readonly campaignId: string; readonly storyboardId: string },
): Promise<ProductionTreatment> {
  const treatment = parseProductionTreatment(
    JSON.parse(await readFile(treatmentPath, 'utf8')),
    treatmentPath,
  );
  const mismatches: { path: string; message: string }[] = [];
  if (treatment.campaignId !== expected.campaignId) {
    mismatches.push({
      path: 'campaignId',
      message: `this treatment was approved for campaign ${treatment.campaignId}, the run is for ${expected.campaignId}`,
    });
  }
  if (treatment.storyboardId !== expected.storyboardId) {
    mismatches.push({
      path: 'storyboardId',
      message: `this treatment was approved against storyboard "${treatment.storyboardId}", the run resolved "${expected.storyboardId}"`,
    });
  }
  if (mismatches.length > 0) throw new ProductionTreatmentError(mismatches, treatmentPath);
  return treatment;
}

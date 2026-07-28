import { readFile } from 'node:fs/promises';

import {
  CAPTION_ENTRANCE_KEYS,
  CTA_ENTRANCE_KEYS,
  DECORATION_TREATMENT_KEYS,
  GRADE_TREATMENT_KEYS,
  SCENE_TREATMENT_KEYS,
  TRANSITION_TREATMENT_KEYS,
} from '@combat/media';
import { z } from 'zod';

import type { CampaignRequest } from '../campaign-request';
import { AUDIO_CUE_ROLE_KEYS } from './audio-plan';
import { STORY_BEATS } from '../production-assets';

/**
 * The human-authored creative plan — the whole input to
 * `HUMAN_ASSISTED_PREVIEW`.
 *
 * Everything the four planning agents would have decided is stated here
 * instead: strategy, creative direction, the hook, the script and its beat
 * timing, per-shot specifications, transitions, motion, captions, CTA timing,
 * audio intentions, the factual constraints and the brand constraints. The
 * pipeline then executes it deterministically, having called no reasoning
 * model and no generation provider at all.
 *
 * Three properties this schema exists to guarantee:
 *
 * - **It fails closed.** `.strict()` throughout, contiguous beat indices, a
 *   timeline that must sum to the requested duration, a CTA that must fit
 *   inside it. A half-specified plan is refused before anything is resolved,
 *   rendered or measured — an under-specified plan that renders is how a
 *   preview quietly becomes a different advertisement from the one that was
 *   approved.
 * - **It is bound to one brief.** `campaignPromptSha256` must match the
 *   request's own prompt hash. A plan written against a different brief is
 *   refused by name rather than executed against whatever request it was
 *   pointed at.
 * - **It is attributable.** `authoredBy` is required, because the entire
 *   claim of this mode is that a person made these decisions. A plan with no
 *   author is a plan nobody is accountable for.
 */

export const HUMAN_PLAN_VERSION = 1 as const;

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colour must be #RRGGBB');
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256');
const IsoDateStringSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

export const PlanStrategySchema = z
  .object({
    audienceName: z.string().min(1).max(120),
    painPoints: z.array(z.string().min(1).max(300)).min(1).max(8),
    positioning: z.string().min(1).max(600),
    targetAudienceSummary: z.string().min(1).max(600),
    keyMessages: z.array(z.string().min(1).max(200)).min(1).max(8),
    toneGuidelines: z.array(z.string().min(1).max(200)).min(1).max(8),
  })
  .strict();

export const PlanCreativeDirectionSchema = z
  .object({
    logline: z.string().min(1).max(400),
    visualDirection: z.string().min(1).max(1200),
    narrativeArc: z.string().min(1).max(1200),
    /**
     * Craft notes in the author's own words. Deliberately *not* a place to
     * name an agency, a studio or an existing campaign — the same prohibition
     * every planning prompt carries, enforced here because there is no prompt
     * in this mode to carry it.
     */
    referenceNotes: z.array(z.string().min(1).max(300)).max(8).default([]),
  })
  .strict();

export const PlanHookSchema = z
  .object({
    strategy: z.string().min(1).max(400),
    /** How long the viewer waits before the hook lands. */
    latencySeconds: z.number().min(0).max(10),
    onScreenLine: z.string().min(1).max(120),
  })
  .strict();

/** How a beat finds its footage. Ids bind exactly; the rest is a preference. */
export const PlanSourceSelectorSchema = z
  .object({
    /** Binds this beat to one asset by id. The strongest, and the usual, form. */
    assetId: z.string().min(1).max(80).optional(),
    /** Otherwise, prefer this role. */
    preferredRole: z.enum(['SOURCE_CLIP', 'APP_SCREENSHOT', 'BRAND_CARD']).optional(),
    /** And these tags, all of which must be present. */
    requiredTags: z.array(z.string().min(1).max(60)).max(8).default([]),
    /**
     * Pin the in-point rather than letting segment selection choose one.
     *
     * Left absent, the deterministic selector picks a legal segment using the
     * clip's measured scene boundaries — which is the point of this milestone.
     * Present, the author has decided, and the selector verifies the choice is
     * legal rather than overriding it.
     */
    inSeconds: z.number().min(0).max(3600).optional(),
  })
  .strict();

export const PlanMotionSchema = z
  .object({
    treatment: z.enum(SCENE_TREATMENT_KEYS),
    intensity: z.number().min(0).max(1).default(0.5),
  })
  .strict();

/**
 * Optional, and deliberately so: a product screen is usually left ungraded,
 * because legibility of the real interface outranks palette unity. Absent
 * means "this shot is shown as it was captured", which is a decision worth
 * being able to make explicitly.
 */
export const PlanGradeSchema = z
  .object({
    key: z.enum(GRADE_TREATMENT_KEYS),
    intensity: z.number().min(0).max(1).default(0.5),
  })
  .strict();

export const PlanTransitionSchema = z
  .object({
    kind: z.enum(TRANSITION_TREATMENT_KEYS),
    durationSeconds: z
      .number()
      .min(1 / 30)
      .max(2),
  })
  .strict();

export const PlanCaptionSchema = z
  .object({
    text: z.string().min(1).max(200),
    entrance: z.enum(CAPTION_ENTRANCE_KEYS).default('FADE'),
  })
  .strict();

export const PlanDecorationSchema = z
  .object({
    key: z.enum(DECORATION_TREATMENT_KEYS),
    /** `PRIMARY` and `ACCENT` resolve from the brand constraints, never from a literal. */
    colour: z.enum(['PRIMARY', 'ACCENT']).default('ACCENT'),
    opacity: z.number().min(0).max(1).default(0.9),
    xPx: z.number().int().min(0).max(1080),
    yPx: z.number().int().min(0).max(1920),
    widthPx: z.number().int().positive().max(1080),
    heightPx: z.number().int().positive().max(1920),
    thicknessPx: z.number().int().min(1).max(40).default(6),
  })
  .strict();

export const PlanAudioCueSchema = z
  .object({
    role: z.enum(AUDIO_CUE_ROLE_KEYS),
    /** Offset from the start of this beat. */
    atOffsetSeconds: z.number().min(0).max(60).default(0),
    gainDb: z.number().min(-40).max(6).default(-6),
    ducksMusic: z.boolean().default(false),
  })
  .strict();

export const PlanBeatSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'beat ids are lowercase, kebab-case and filesystem-safe'),
    index: z.number().int().min(0).max(63),
    /** The story beat this shot serves, from the existing closed vocabulary. */
    role: z.enum(STORY_BEATS),
    description: z.string().min(1).max(600),
    /** On the timeline, before this beat's own transition overlap is subtracted. */
    durationSeconds: z.number().positive().max(60),
    source: PlanSourceSelectorSchema,
    motion: PlanMotionSchema,
    /** Colour grade over the motion treatment. Absent leaves the shot as captured. */
    grade: PlanGradeSchema.optional(),
    /** Absent on the first beat; required on every later one. */
    transitionIn: PlanTransitionSchema.optional(),
    caption: PlanCaptionSchema.optional(),
    decorations: z.array(PlanDecorationSchema).max(4).default([]),
    audioCues: z.array(PlanAudioCueSchema).max(6).default([]),
    useSourceAudio: z.boolean().default(false),
  })
  .strict();
export type PlanBeat = z.infer<typeof PlanBeatSchema>;

export const PlanCtaSchema = z
  .object({
    headline: z.string().min(1).max(80),
    subline: z.string().min(1).max(120).optional(),
    /** How long the card is on screen. */
    durationSeconds: z.number().positive().max(10),
    /** How long of that it must sit fully settled. QA measures this. */
    holdSeconds: z.number().min(0).max(10),
    entrance: z.enum(CTA_ENTRANCE_KEYS).default('RISE_AND_SCALE'),
  })
  .strict();

export const PlanAudioSchema = z
  .object({
    /** Asset id of the music bed. Absent renders a deliberately silent master. */
    musicAssetId: z.string().min(1).max(80).optional(),
    musicGainDb: z.number().min(-40).max(6).default(-8),
    sourceAudioGainDb: z.number().min(-60).max(6).default(-14),
    cueDuckingDb: z.number().min(0).max(30).default(6),
    musicCrossfadeSeconds: z.number().min(0).max(3).default(0.25),
    peakCeilingDbtp: z.number().min(-9).max(-0.1).default(-1.5),
    targetLufs: z.number().min(-30).max(-6).default(-14),
    /** Asset id per cue role, so a bell and a crowd bed are distinct files. */
    cueAssetIds: z.record(z.enum(AUDIO_CUE_ROLE_KEYS), z.string().min(1).max(80)).default({}),
  })
  .strict();

export const PlanBrandConstraintsSchema = z
  .object({
    logoAssetId: z.string().min(1).max(80),
    primaryColorHex: HexColorSchema,
    accentColorHex: HexColorSchema,
    captionFontFamily: z.string().min(1).max(80),
    safeAreaTopPx: z.number().int().min(0).max(600),
    safeAreaBottomPx: z.number().int().min(0).max(900),
    /**
     * When the mark is on screen. Absent, or empty, keeps the existing
     * behaviour: the whole cut.
     *
     * Worth being able to say, because a persistent mark over a product
     * screenshot obscures the interface's own header — the corner of the
     * screen a real app puts its own identity in. The end card carries the
     * mark regardless, so dropping it across the product beats costs no brand
     * presence and buys back the one part of the frame a viewer is reading.
     */
    logoWindows: z
      .array(
        z
          .object({
            startSeconds: z.number().min(0).max(120),
            endSeconds: z.number().positive().max(120),
          })
          .strict()
          .refine((window) => window.endSeconds > window.startSeconds, {
            message: 'a logo window must end after it starts',
          }),
      )
      .max(16)
      .default([]),
  })
  .strict();

const HumanCreativePlanObjectSchema = z
  .object({
    planVersion: z.literal(HUMAN_PLAN_VERSION),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    /** Who made these decisions. Required — this mode's whole claim rests on it. */
    authoredBy: z.string().min(1).max(200),
    authoredAt: IsoDateStringSchema,
    /** Binds the plan to one brief. Checked against the request at load time. */
    campaignPromptSha256: Sha256Schema,
    /** The cut this plan is for. Checked against the request at load time. */
    targetDurationSeconds: z.number().positive().max(120),

    strategy: PlanStrategySchema,
    creativeDirection: PlanCreativeDirectionSchema,
    hook: PlanHookSchema,
    beats: z.array(PlanBeatSchema).min(2).max(64),
    cta: PlanCtaSchema,
    audio: PlanAudioSchema,
    factualConstraints: z.array(z.string().min(1).max(600)).min(1).max(32),
    brandConstraints: PlanBrandConstraintsSchema,
  })
  .strict();

/**
 * Phrases that would make a plan an imitation brief rather than a creative one.
 *
 * The same prohibition every planning prompt carries. It has to live here in
 * this mode because there is no prompt: a person writing "make it look like
 * <agency>'s campaign" would otherwise sail straight through into a render.
 */
const IMITATION_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\b(?:in the style of|styled after|a\s+copy\s+of)\b/i, why: 'names a style to copy' },
  { pattern: /\b(?:agency|ad\s*agency|advertising\s+agency)\b/i, why: 'names an agency' },
  { pattern: /\brecreate\s+(?:the\s+)?(?:campaign|ad|advert)/i, why: 'asks for a recreation' },
  { pattern: /\bshot[- ]for[- ]shot\b/i, why: 'asks for a shot-for-shot copy' },
];

export const HumanCreativePlanV1Schema = HumanCreativePlanObjectSchema.superRefine((plan, ctx) => {
  const addIssue = (message: string, path: (string | number)[]): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  };

  // ---- beats form one contiguous, ordered timeline -------------------------
  const beatIds = new Set<string>();
  plan.beats.forEach((beat, index) => {
    if (beatIds.has(beat.id)) addIssue(`duplicate beat id "${beat.id}"`, ['beats', index, 'id']);
    beatIds.add(beat.id);
    if (beat.index !== index) {
      addIssue(
        `beat "${beat.id}" declares index ${beat.index} but sits at position ${index}; indices must be contiguous from 0`,
        ['beats', index, 'index'],
      );
    }
    if (index === 0 && beat.transitionIn) {
      addIssue('the first beat cannot have a transitionIn', ['beats', 0, 'transitionIn']);
    }
    if (index > 0 && !beat.transitionIn) {
      addIssue('every beat after the first must declare a transitionIn', [
        'beats',
        index,
        'transitionIn',
      ]);
    }
    if (beat.transitionIn && beat.transitionIn.durationSeconds >= beat.durationSeconds) {
      addIssue('a transition cannot be as long as the beat it enters', [
        'beats',
        index,
        'transitionIn',
        'durationSeconds',
      ]);
    }
    for (const cue of beat.audioCues) {
      if (cue.atOffsetSeconds > beat.durationSeconds) {
        addIssue(
          `audio cue ${cue.role} lands ${cue.atOffsetSeconds}s into a ${beat.durationSeconds}s beat`,
          ['beats', index, 'audioCues'],
        );
      }
      if (!plan.audio.cueAssetIds[cue.role]) {
        addIssue(
          `audio cue ${cue.role} has no asset in audio.cueAssetIds — a cue with no source is a cue that will not sound`,
          ['beats', index, 'audioCues'],
        );
      }
    }
  });

  // ---- the timeline lands exactly on the requested duration ----------------
  const beatTotal = plan.beats.reduce((sum, beat) => sum + beat.durationSeconds, 0);
  const overlapTotal = plan.beats.reduce(
    (sum, beat) => sum + (beat.transitionIn?.durationSeconds ?? 0),
    0,
  );
  const timeline = beatTotal - overlapTotal;
  if (Math.abs(timeline - plan.targetDurationSeconds) > 1e-6) {
    addIssue(
      `beats (${beatTotal}s) minus transition overlaps (${overlapTotal}s) is ${timeline.toFixed(3)}s, but targetDurationSeconds is ${plan.targetDurationSeconds}s`,
      ['beats'],
    );
  }

  // ---- the CTA and the hook fit inside it ----------------------------------
  if (plan.cta.durationSeconds >= plan.targetDurationSeconds) {
    addIssue('the CTA cannot be as long as the whole cut', ['cta', 'durationSeconds']);
  }
  if (plan.cta.holdSeconds > plan.cta.durationSeconds) {
    addIssue('the CTA hold cannot outlast the card itself', ['cta', 'holdSeconds']);
  }
  if (plan.hook.latencySeconds >= plan.targetDurationSeconds) {
    addIssue('the hook cannot land after the cut has ended', ['hook', 'latencySeconds']);
  }

  // ---- a plan must actually end on the call to action ----------------------
  const lastBeat = plan.beats[plan.beats.length - 1];
  if (lastBeat && lastBeat.role !== 'CTA') {
    addIssue(
      `the final beat is ${lastBeat.role}; a plan must end on its CTA beat so the card has a shot to sit on`,
      ['beats', plan.beats.length - 1, 'role'],
    );
  }

  // ---- no imitation ---------------------------------------------------------
  const proseFields: readonly [string, (string | number)[]][] = [
    [plan.creativeDirection.visualDirection, ['creativeDirection', 'visualDirection']],
    [plan.creativeDirection.narrativeArc, ['creativeDirection', 'narrativeArc']],
    [plan.creativeDirection.logline, ['creativeDirection', 'logline']],
    [plan.hook.strategy, ['hook', 'strategy']],
    ...plan.creativeDirection.referenceNotes.map(
      (note, index) =>
        [note, ['creativeDirection', 'referenceNotes', index]] as [string, (string | number)[]],
    ),
  ];
  for (const [text, path] of proseFields) {
    for (const { pattern, why } of IMITATION_PATTERNS) {
      if (pattern.test(text)) {
        addIssue(
          `this ${why}. Express creative intent as explicit properties — pacing, contrast, framing, typography, rhythm — never by naming or imitating an agency, studio or existing campaign.`,
          path,
        );
      }
    }
  }
});

export type HumanCreativePlan = z.infer<typeof HumanCreativePlanV1Schema>;

export class HumanPlanValidationError extends Error {
  constructor(
    public readonly issues: readonly { path: string; message: string }[],
    public readonly planPath?: string,
  ) {
    const where = planPath ? ` (${planPath})` : '';
    super(
      `Creative plan is invalid${where}:\n${issues
        .map((issue) => `  - ${issue.path || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'HumanPlanValidationError';
  }
}

export function parseHumanPlan(value: unknown, planPath?: string): HumanCreativePlan {
  const result = HumanCreativePlanV1Schema.safeParse(value);
  if (result.success) return result.data;
  throw new HumanPlanValidationError(
    result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
    planPath,
  );
}

/**
 * Reads a plan and proves it belongs to this campaign.
 *
 * The three identity checks are the difference between "a valid plan" and
 * "the plan for this brief". A plan that validates but was written for a
 * different prompt, a different campaign or a different duration would render
 * perfectly and be the wrong advertisement.
 */
export async function loadHumanPlan(
  planPath: string,
  request: CampaignRequest,
): Promise<HumanCreativePlan> {
  const plan = parseHumanPlan(JSON.parse(await readFile(planPath, 'utf8')), planPath);
  const mismatches: { path: string; message: string }[] = [];

  if (plan.campaignPromptSha256 !== request.promptSha256) {
    mismatches.push({
      path: 'campaignPromptSha256',
      message: `this plan was written against prompt ${plan.campaignPromptSha256.slice(0, 16)}… but the request's prompt hashes to ${request.promptSha256.slice(0, 16)}…. Re-author the plan against the current brief rather than rendering it against a different one.`,
    });
  }
  if (plan.campaignId !== request.campaignId) {
    mismatches.push({
      path: 'campaignId',
      message: `plan is for campaign ${plan.campaignId}, request is for ${request.campaignId}`,
    });
  }
  if (plan.workspaceId !== request.workspaceId) {
    mismatches.push({
      path: 'workspaceId',
      message: `plan is for workspace ${plan.workspaceId}, request is for ${request.workspaceId}`,
    });
  }
  if (Math.abs(plan.targetDurationSeconds - request.targetDurationSeconds) > 1e-6) {
    mismatches.push({
      path: 'targetDurationSeconds',
      message: `plan is cut for ${plan.targetDurationSeconds}s, request asks for ${request.targetDurationSeconds}s`,
    });
  }
  if (Math.abs(plan.cta.durationSeconds - request.cta.durationSeconds) > 1e-6) {
    mismatches.push({
      path: 'cta.durationSeconds',
      message: `plan's CTA runs ${plan.cta.durationSeconds}s, request asks for ${request.cta.durationSeconds}s`,
    });
  }
  if (plan.brandConstraints.logoAssetId !== request.brandKit.logoAssetId) {
    mismatches.push({
      path: 'brandConstraints.logoAssetId',
      message: `plan uses logo "${plan.brandConstraints.logoAssetId}", request declares "${request.brandKit.logoAssetId}"`,
    });
  }

  if (mismatches.length > 0) throw new HumanPlanValidationError(mismatches, planPath);
  return plan;
}

/**
 * A deterministic starting plan for a request.
 *
 * Emitted by `aamp:generate --emit-plan-template`, and deliberately a
 * *skeleton the author must edit* rather than a plan that would render as-is:
 * every prose field says what belongs there. A template that quietly produced
 * a finished advertisement would make the mode's whole claim — that a person
 * made these decisions — untrue on first use.
 *
 * Pure: derived only from the request, with no clock and no randomness, so the
 * same request always emits the same template.
 */
export function buildHumanPlanTemplate(
  request: CampaignRequest,
  authoredAt: string,
): Record<string, unknown> {
  const ctaSeconds = request.cta.durationSeconds;
  const bodySeconds = request.targetDurationSeconds - ctaSeconds;
  const transitionSeconds = Number((9 / 30).toFixed(6));
  // Four body beats plus the CTA beat, with the transition overlaps folded in
  // so the emitted skeleton already satisfies the exact-duration rule.
  const bodyBeatCount = 4;
  const overlapTotal = Number((transitionSeconds * bodyBeatCount).toFixed(6));
  const perBody = Number(
    ((bodySeconds + overlapTotal - transitionSeconds) / bodyBeatCount).toFixed(6),
  );
  const lastBody = Number(
    (bodySeconds + overlapTotal - transitionSeconds - perBody * (bodyBeatCount - 1)).toFixed(6),
  );

  const bodyRoles = ['HOOK', 'EVENT_DETAIL', 'INFORMATION', 'DISCUSSION'] as const;
  const beats = bodyRoles.map((role, index) => ({
    id: `${role.toLowerCase().replace(/_/g, '-')}-${index}`,
    index,
    role,
    description: `TODO — what this ${role} beat shows, in your own words.`,
    durationSeconds: index === bodyBeatCount - 1 ? lastBody : perBody,
    source: {
      preferredRole: index === 0 ? 'SOURCE_CLIP' : 'APP_SCREENSHOT',
      requiredTags: [],
    },
    motion: {
      treatment: index === 0 ? 'PUSH_IN' : 'APP_SCREENSHOT_PARALLAX',
      intensity: 0.45,
    },
    ...(index === 0 ? {} : { transitionIn: { kind: 'CUT', durationSeconds: transitionSeconds } }),
    caption: { text: 'TODO — the on-screen line for this beat.', entrance: 'RISE' },
    decorations: [],
    audioCues: [],
    useSourceAudio: false,
  }));

  beats.push({
    id: 'cta',
    index: bodyBeatCount,
    role: 'CTA' as (typeof bodyRoles)[number],
    description: 'TODO — what the end card sits on.',
    durationSeconds: Number((ctaSeconds + transitionSeconds).toFixed(6)),
    source: { preferredRole: 'BRAND_CARD', requiredTags: [] },
    motion: { treatment: 'STATIC_HOLD', intensity: 0 },
    transitionIn: { kind: 'DIP_TO_BLACK', durationSeconds: transitionSeconds },
    caption: { text: 'TODO — or remove this field entirely.', entrance: 'FADE' },
    decorations: [],
    audioCues: [],
    useSourceAudio: false,
  } as (typeof beats)[number]);

  return {
    planVersion: HUMAN_PLAN_VERSION,
    workspaceId: request.workspaceId,
    campaignId: request.campaignId,
    authoredBy: 'TODO — your name. This mode claims a person made these decisions.',
    authoredAt,
    campaignPromptSha256: request.promptSha256,
    targetDurationSeconds: request.targetDurationSeconds,
    strategy: {
      audienceName: 'TODO — name the audience.',
      painPoints: ['TODO — what this audience finds difficult today.'],
      positioning: 'TODO — where the product sits against the alternatives.',
      targetAudienceSummary: request.targetAudience,
      keyMessages:
        request.keyMessages.length > 0
          ? request.keyMessages
          : ['TODO — the message this cut has to land.'],
      toneGuidelines: ['TODO — how it should feel.'],
    },
    creativeDirection: {
      logline: 'TODO — the cut in one sentence.',
      visualDirection:
        'TODO — pacing, contrast, framing, typography and rhythm, as explicit properties.',
      narrativeArc: 'TODO — how the beats build.',
      referenceNotes: [],
    },
    hook: {
      strategy: 'TODO — what makes someone stop.',
      latencySeconds: 1,
      onScreenLine: 'TODO — the first line on screen.',
    },
    beats,
    cta: {
      headline: request.cta.headline,
      ...(request.cta.subline ? { subline: request.cta.subline } : {}),
      durationSeconds: ctaSeconds,
      holdSeconds: Number(Math.max(0, ctaSeconds - 0.6).toFixed(6)),
      entrance: 'RISE_AND_SCALE',
    },
    audio: {
      musicGainDb: -8,
      sourceAudioGainDb: -14,
      cueDuckingDb: 6,
      musicCrossfadeSeconds: 0.25,
      peakCeilingDbtp: -1.5,
      targetLufs: -14,
      cueAssetIds: {},
    },
    factualConstraints: [
      ...request.productFacts.map((fact) => `PRODUCT — ${fact.label}: ${fact.detail}`),
      ...request.eventFacts.map((fact) => `EVENT — ${fact.label}: ${fact.detail}`),
    ],
    brandConstraints: {
      logoAssetId: request.brandKit.logoAssetId,
      primaryColorHex: request.brandKit.primaryColorHex,
      accentColorHex: request.brandKit.accentColorHex,
      captionFontFamily: request.brandKit.captionFontFamily,
      safeAreaTopPx: request.brandKit.safeAreaTopPx,
      safeAreaBottomPx: request.brandKit.safeAreaBottomPx,
    },
  };
}

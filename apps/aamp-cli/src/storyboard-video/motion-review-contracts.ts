import { createHash } from 'node:crypto';

import { z } from 'zod';

import { StoryboardVideoError } from './failures';
import type { SceneManifestEntry } from './scene-manifest';
import { SOURCE_TYPES } from './source-precedence';

/**
 * What a human decision about one scene's motion is bound to.
 *
 * A decision is a statement about a *specific* piece of footage judged against
 * a *specific* brief. Four things can change underneath it, and every one of
 * them makes the earlier judgement describe something that no longer exists:
 *
 * - the clip's bytes — a regeneration, a re-download, a re-trim;
 * - the authoritative keyframe — the approved art changed;
 * - the generation prompt — the scene was asked for differently;
 * - the scene contract — its slot, its mode, its camera motion, the roles it
 *   accepts, its typography and product-UI preservation flags.
 *
 * So an approval is not stored against a scene number. It is stored against
 * the digest of all four, and it applies only while that digest still matches
 * what is on disk. Anything else would let an approval granted for one clip
 * silently authorise a different one, which is precisely the failure a review
 * gate exists to prevent.
 *
 * The identity is deliberately *not* a hash of the inspection. Measurements
 * move with the FFmpeg build; the four inputs above do not. An approval that
 * evaporated because a patch release changed a frame-rate rounding would train
 * reviewers to click through the gate.
 */

export const MOTION_REVIEW_LEDGER_VERSION = 1 as const;

/** The scene-contract fields a reviewer's judgement is bound to, in a fixed order. */
export const REVIEWED_SCENE_CONTRACT_FIELDS = [
  'sceneNumber',
  'sourceFrame',
  'lastFrame',
  'outputStartSeconds',
  'outputEndSeconds',
  'generationMode',
  'cameraMotion',
  'preserveExactTypography',
  'preserveExactProductUi',
  'acceptableFootageRoles',
] as const;

/**
 * A stable digest built from an ordered `name=value` list rather than from
 * `JSON.stringify` of an object, for the same reason the generation cache key
 * is: key order in a serialised object is an implementation detail, and an
 * identity that changed under an innocent refactor would invalidate every
 * standing approval in the repository at once.
 */
export function sceneContractSha256(scene: SceneManifestEntry): string {
  const parts = REVIEWED_SCENE_CONTRACT_FIELDS.map((field) => {
    const value = (scene as unknown as Record<string, unknown>)[field];
    if (Array.isArray(value)) return `${field}=${[...value].map(String).sort().join('|')}`;
    return `${field}=${value === undefined ? 'none' : String(value)}`;
  });
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex digest');

export const SceneReviewIdentitySchema = z
  .object({
    sceneNumber: z.number().int().min(1).max(64),
    /** The bytes of the moving source as it was inspected. */
    clipChecksumSha256: Sha256,
    /** The authoritative FRAME-NN this scene is bound to. */
    keyframeChecksumSha256: Sha256,
    /** The generation prompt as submitted, or as it would be submitted. */
    motionPromptSha256: Sha256,
    /** The scene's own production contract. */
    sceneContractSha256: Sha256,
    sourceType: z.enum(SOURCE_TYPES),
    generationProvenance: z.string().min(1).max(80).nullable(),
  })
  .strict();
export type SceneReviewIdentity = z.infer<typeof SceneReviewIdentitySchema>;

export function reviewIdentitySha256(identity: SceneReviewIdentity): string {
  const parts = [
    `v=${MOTION_REVIEW_LEDGER_VERSION}`,
    `scene=${identity.sceneNumber}`,
    `clip=${identity.clipChecksumSha256}`,
    `keyframe=${identity.keyframeChecksumSha256}`,
    `prompt=${identity.motionPromptSha256}`,
    `contract=${identity.sceneContractSha256}`,
    `source=${identity.sourceType}`,
    `provenance=${identity.generationProvenance ?? 'none'}`,
  ];
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

export const MOTION_REVIEW_VERDICTS = ['APPROVED', 'REJECTED'] as const;
export type MotionReviewVerdict = (typeof MOTION_REVIEW_VERDICTS)[number];

/**
 * Phrases that are a mood and not a direction.
 *
 * The rule fires only when the *whole* feedback field is one of these, the same
 * shape the finishing path uses: a reviewer writing prose that happens to
 * contain "punchier" is never blocked, but "make it punchier" cannot become the
 * recorded reason a scene was refused. A rejection an author cannot act on is
 * one they work around.
 */
export const VAGUE_FEEDBACK_PHRASES: readonly string[] = [
  'bad',
  'wrong',
  'no',
  'nope',
  'rubbish',
  'not good',
  'not great',
  'looks off',
  'looks wrong',
  'looks bad',
  'doesn’t work',
  "doesn't work",
  'needs work',
  'make it better',
  'make it punchier',
  'punchier',
  'more energy',
  'not premium',
  'meh',
];

export const MINIMUM_REJECTION_FEEDBACK_CHARACTERS = 30;

const FeedbackSchema = z.string().min(1).max(2000);

export const MotionReviewDecisionSchema = z
  .object({
    ledgerVersion: z.literal(MOTION_REVIEW_LEDGER_VERSION),
    /** Content-addressed: the digest of everything below it except itself. */
    decisionId: Sha256,
    recordedAt: z.string().datetime(),
    /** A named person. There is no default and no "system" reviewer. */
    reviewer: z.string().min(2).max(200),
    sceneNumber: z.number().int().min(1).max(64),
    verdict: z.enum(MOTION_REVIEW_VERDICTS),
    /** Why, in the reviewer's own words. Required for both verdicts. */
    feedback: FeedbackSchema,
    identity: SceneReviewIdentitySchema,
    identitySha256: Sha256,
    /** The inspection this judgement was made against. */
    inspectionSha256: Sha256,
    /**
     * Fidelity findings the reviewer named when approving despite them. An
     * approval may not be recorded while a finding is open and unnamed.
     */
    acknowledgedFindings: z.array(z.string().min(1).max(80)).max(16).default([]),
    /** The decision this one replaces, when the scene had one that still applied. */
    supersedesDecisionId: Sha256.nullable(),
    /** Why it superseded: the reviewer changed their mind, or the clip changed. */
    supersedesReason: z.string().min(1).max(300).nullable(),
  })
  .strict();
export type MotionReviewDecision = z.infer<typeof MotionReviewDecisionSchema>;

export type UnsignedMotionReviewDecision = Omit<MotionReviewDecision, 'decisionId'>;

/**
 * The decision's own id is the digest of its content.
 *
 * That makes a ledger line self-verifying: a decision whose recorded id does
 * not match its content was edited after it was written, and the store refuses
 * to read it rather than treating a tampered approval as an approval.
 */
export function computeDecisionId(decision: UnsignedMotionReviewDecision): string {
  const parts = [
    `v=${decision.ledgerVersion}`,
    `at=${decision.recordedAt}`,
    `reviewer=${decision.reviewer}`,
    `scene=${decision.sceneNumber}`,
    `verdict=${decision.verdict}`,
    `feedback=${decision.feedback}`,
    `identity=${decision.identitySha256}`,
    `inspection=${decision.inspectionSha256}`,
    `findings=${[...decision.acknowledgedFindings].sort().join('|')}`,
    `supersedes=${decision.supersedesDecisionId ?? 'none'}`,
    `supersedesReason=${decision.supersedesReason ?? 'none'}`,
  ];
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

/**
 * Refuses feedback that cannot be acted on.
 *
 * An approval's feedback is a reason and may be short — "the framing matches
 * the approved plate and the move is the one the scene asks for" is a complete
 * thought. A rejection has to say what must change, because it is an
 * instruction to spend money regenerating, and "wrong" is not one.
 */
export function assertFeedbackIsActionable(
  verdict: MotionReviewVerdict,
  feedback: string,
  sceneNumber: number,
): void {
  const trimmed = feedback.trim();
  const normalised = trimmed.toLowerCase().replace(/[.!]+$/, '');
  if (VAGUE_FEEDBACK_PHRASES.includes(normalised)) {
    throw new StoryboardVideoError(
      'MOTION_REVIEW_BLOCKED',
      `scene ${sceneNumber}: "${trimmed}" is a mood, not a direction, and it cannot become the recorded reason for a decision. Say what was observed and what must change instead.`,
      sceneNumber,
    );
  }
  if (verdict === 'REJECTED' && trimmed.length < MINIMUM_REJECTION_FEEDBACK_CHARACTERS) {
    throw new StoryboardVideoError(
      'MOTION_REVIEW_BLOCKED',
      `scene ${sceneNumber}: a rejection needs at least ${MINIMUM_REJECTION_FEEDBACK_CHARACTERS} characters saying what was observed and what must change — a rejection is an instruction to regenerate at cost, and the next person has to know what to change. Got ${trimmed.length}.`,
      sceneNumber,
    );
  }
}

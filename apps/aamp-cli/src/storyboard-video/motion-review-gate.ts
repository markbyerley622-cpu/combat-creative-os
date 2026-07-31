import { StoryboardVideoError } from './failures';
import type { SceneMotionInspection } from './motion-inspection';
import {
  reviewIdentitySha256,
  type MotionReviewDecision,
  type SceneReviewIdentity,
} from './motion-review-contracts';
import type { MotionReviewLedger } from './motion-review-store';
import type { SceneSourceDecision, SourceType } from './source-precedence';

/**
 * The gate: no required moving scene reaches FFmpeg without a standing human
 * approval of the exact clip that will be used.
 *
 * It runs after the sources are resolved and before anything is trimmed,
 * staged or composited, so a blocked run has produced no timeline and no file
 * — the same ordering discipline the cost ceiling follows. There is no
 * `--skip-review`, no `--force` and no environment variable, because a gate
 * with a bypass is a gate that gets bypassed on the afternoon somebody needs
 * the file quickly, which is exactly the afternoon it exists for.
 *
 * Six statuses, and they are six genuinely different operator actions rather
 * than shades of "not ready". A message that said only "not ready" would get
 * the condition removed rather than met, so every scene names what happened
 * and what to do about it.
 */

export const MOTION_GATE_STATUSES = [
  'APPROVED',
  'REJECTED',
  'NOT_REVIEWED',
  'APPROVAL_SUPERSEDED_BY_CHANGE',
  'TECHNICALLY_INVALID',
  'MISSING_SOURCE',
] as const;
export type MotionGateStatus = (typeof MOTION_GATE_STATUSES)[number];

/**
 * Source types that put moving picture on screen and therefore need a motion
 * judgement.
 *
 * A deterministic-graphics scene and a real product capture are stills the
 * render path animates itself; there is no generated motion to review, and
 * asking a reviewer to approve one would train them to approve without
 * looking.
 */
export const REVIEWABLE_SOURCE_TYPES: readonly SourceType[] = [
  'ACQUIRED_PRODUCTION_FOOTAGE',
  'PRE_GENERATED_MANUAL_CLIP',
  'LTX_GENERATED',
];

export function sceneNeedsMotionReview(decision: SceneSourceDecision): boolean {
  return REVIEWABLE_SOURCE_TYPES.includes(decision.selectedSourceType);
}

export interface SceneGateRow {
  readonly sceneNumber: number;
  readonly sceneRole: string;
  readonly sourceType: SourceType;
  readonly status: MotionGateStatus;
  readonly identitySha256: string | null;
  readonly clipChecksumSha256: string | null;
  readonly inspectionVerdict: SceneMotionInspection['verdict'] | null;
  readonly openFidelityFindings: readonly string[];
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionId: string | null;
  readonly feedback: string | null;
  /** What a person does next, in one sentence. Empty when the scene clears. */
  readonly remedy: string;
}

export interface MotionGateReport {
  readonly evaluatedAt: string;
  readonly rows: readonly SceneGateRow[];
  readonly blockingScenes: readonly number[];
  readonly technicallyInvalidScenes: readonly number[];
  readonly clears: boolean;
  readonly notice: string;
}

export interface EvaluateMotionGateInput {
  readonly decisions: readonly SceneSourceDecision[];
  /** Inspections by scene number. A reviewable scene with none is unproven. */
  readonly inspections: ReadonlyMap<number, SceneMotionInspection>;
  /** Review identities by scene number, computed from what is on disk now. */
  readonly identities: ReadonlyMap<number, SceneReviewIdentity>;
  readonly ledger: MotionReviewLedger;
  readonly now: Date;
}

export function evaluateMotionGate(input: EvaluateMotionGateInput): MotionGateReport {
  const rows: SceneGateRow[] = [];

  for (const decision of [...input.decisions].sort((a, b) => a.sceneNumber - b.sceneNumber)) {
    if (!sceneNeedsMotionReview(decision)) continue;

    const inspection = input.inspections.get(decision.sceneNumber);
    const identity = input.identities.get(decision.sceneNumber);
    const base = {
      sceneNumber: decision.sceneNumber,
      sceneRole: decision.sceneRole,
      sourceType: decision.selectedSourceType,
      openFidelityFindings: inspection?.openFidelityFindings ?? [],
    };

    if (!inspection || !identity) {
      rows.push({
        ...base,
        status: 'MISSING_SOURCE',
        identitySha256: null,
        clipChecksumSha256: null,
        inspectionVerdict: null,
        decidedBy: null,
        decidedAt: null,
        decisionId: null,
        feedback: null,
        remedy: `scene ${decision.sceneNumber} has no inspected moving source. Produce or supply a clip for it, then run "aamp:motion-review inspect".`,
      });
      continue;
    }

    const identitySha256 = reviewIdentitySha256(identity);

    if (inspection.verdict !== 'TECHNICALLY_SOUND') {
      const failed = inspection.checks
        .filter((check) => check.tier === 'BINDING_TECHNICAL')
        .filter((check) => check.status === 'FAIL' || check.status === 'NOT_MEASURED')
        .map((check) => `${check.id} (${check.status.toLowerCase()})`);
      rows.push({
        ...base,
        status: 'TECHNICALLY_INVALID',
        identitySha256,
        clipChecksumSha256: inspection.clipChecksumSha256,
        inspectionVerdict: inspection.verdict,
        decidedBy: null,
        decidedAt: null,
        decisionId: null,
        feedback: null,
        remedy: `scene ${decision.sceneNumber} failed local inspection on ${failed.join(', ')}. No approval clears this — supply a different clip, or regenerate it with "aamp:storyboard-video --regenerate-scene ${decision.sceneNumber}".`,
      });
      continue;
    }

    const applicable = input.ledger.latestApplicable(decision.sceneNumber, identitySha256);
    if (applicable) {
      rows.push({
        ...base,
        status: applicable.verdict === 'APPROVED' ? 'APPROVED' : 'REJECTED',
        identitySha256,
        clipChecksumSha256: inspection.clipChecksumSha256,
        inspectionVerdict: inspection.verdict,
        decidedBy: applicable.reviewer,
        decidedAt: applicable.recordedAt,
        decisionId: applicable.decisionId,
        feedback: applicable.feedback,
        remedy:
          applicable.verdict === 'APPROVED'
            ? ''
            : `scene ${decision.sceneNumber} was rejected by ${applicable.reviewer}: "${applicable.feedback}". Regenerate it with "aamp:storyboard-video --regenerate-scene ${decision.sceneNumber}", or supply a replacement clip, then review the new one.`,
      });
      continue;
    }

    // Nothing applies. Whether that is "never looked at" or "looked at
    // something else" is a different sentence to a reviewer, so it is a
    // different status.
    const stale = staleApproval(input.ledger.forScene(decision.sceneNumber), identitySha256);
    rows.push({
      ...base,
      status: stale ? 'APPROVAL_SUPERSEDED_BY_CHANGE' : 'NOT_REVIEWED',
      identitySha256,
      clipChecksumSha256: inspection.clipChecksumSha256,
      inspectionVerdict: inspection.verdict,
      decidedBy: stale?.reviewer ?? null,
      decidedAt: stale?.recordedAt ?? null,
      decisionId: stale?.decisionId ?? null,
      feedback: stale?.feedback ?? null,
      remedy: stale
        ? `scene ${decision.sceneNumber} was approved by ${stale.reviewer} on ${stale.recordedAt}, but ${describeChange(stale.identity, input.identities.get(decision.sceneNumber) as SceneReviewIdentity)}. Review the current clip: "aamp:motion-review approve --scene ${decision.sceneNumber}".`
        : `scene ${decision.sceneNumber} has never been reviewed. Open the gallery, then record a decision with "aamp:motion-review approve --scene ${decision.sceneNumber}" or "… reject --scene ${decision.sceneNumber}".`,
    });
  }

  const blockingScenes = rows
    .filter((row) => row.status !== 'APPROVED')
    .map((row) => row.sceneNumber);
  const technicallyInvalidScenes = rows
    .filter((row) => row.status === 'TECHNICALLY_INVALID' || row.status === 'MISSING_SOURCE')
    .map((row) => row.sceneNumber);

  return {
    evaluatedAt: input.now.toISOString(),
    rows,
    blockingScenes,
    technicallyInvalidScenes,
    clears: blockingScenes.length === 0,
    notice:
      "Every measurement behind this gate is a technical fact taken from the file on this machine. None of them is evidence about creative quality, face or hand rendering, or whether the story works — those are the reviewer's judgement, and they are recorded as a named person's decision rather than computed.",
  };
}

/** The most recent approval for a scene that no longer applies. */
function staleApproval(
  decisions: readonly MotionReviewDecision[],
  currentIdentitySha256: string,
): MotionReviewDecision | null {
  return (
    [...decisions]
      .filter((decision) => decision.verdict === 'APPROVED')
      .filter((decision) => decision.identitySha256 !== currentIdentitySha256)
      .pop() ?? null
  );
}

/**
 * Names the one thing that moved.
 *
 * "The clip changed" and "the prompt changed" send a reviewer to completely
 * different places, and an invalidation that will not say which is one they
 * learn to clear without reading.
 */
export function describeChange(before: SceneReviewIdentity, after: SceneReviewIdentity): string {
  const changes: string[] = [];
  if (before.clipChecksumSha256 !== after.clipChecksumSha256) changes.push('the clip changed');
  if (before.keyframeChecksumSha256 !== after.keyframeChecksumSha256)
    changes.push('the authoritative keyframe changed');
  if (before.motionPromptSha256 !== after.motionPromptSha256)
    changes.push('the generation prompt changed');
  if (before.sceneContractSha256 !== after.sceneContractSha256)
    changes.push("the scene's production contract changed");
  if (before.sourceType !== after.sourceType)
    changes.push(`the source moved from ${before.sourceType} to ${after.sourceType}`);
  return changes.length > 0 ? changes.join(', and ') : 'the reviewed inputs no longer match';
}

/**
 * Throws unless every reviewable scene clears.
 *
 * The failure kind separates the two operator actions: a scene that needs a
 * person is `MOTION_REVIEW_BLOCKED`, a scene that needs a different clip is
 * `MOTION_INSPECTION_FAILED`. When both are present the technical one wins,
 * because reviewing a clip that is about to be replaced is wasted attention.
 */
/**
 * The half of the gate an internal review candidate must still clear.
 *
 * The two inspection tiers already draw exactly this line, and it is worth
 * being explicit about why the split is legitimate rather than a bypass with a
 * different name.
 *
 * `BINDING_TECHNICAL` means the file is *unusable* — wrong geometry, no
 * motion, a broken download. No approval clears it, and it cannot be in a
 * review candidate either, because a reviewer looking at a broken clip is
 * being asked the wrong question.
 *
 * `NOT_REVIEWED` means nobody has decided yet. A full-length review candidate
 * is the artefact that decision is made *from*: scene-to-scene continuity,
 * pacing and the transitions between shots are not visible in ten isolated
 * clips, and requiring the approval first would mean approving the parts
 * before anyone could see the whole. So the review candidate proceeds and
 * records every scene as pending, while the production master
 * (`assertMotionGateClears`) still refuses without a standing approval.
 *
 * The distinction is enforced by which entry point the operator ran, never by
 * a flag: there is no option on either command that changes its intent.
 */
export function assertReviewCandidateTechnicallySound(report: MotionGateReport): void {
  if (report.technicallyInvalidScenes.length === 0) return;

  const blocked = report.rows.filter(
    (row) => row.status === 'TECHNICALLY_INVALID' || row.status === 'MISSING_SOURCE',
  );
  const lines = blocked.map(
    (row) => `  - scene ${row.sceneNumber} (${row.sceneRole}) — ${row.status}\n      ${row.remedy}`,
  );

  throw new StoryboardVideoError(
    'MOTION_INSPECTION_FAILED',
    `${blocked.length} moving scene(s) failed local technical inspection and cannot be put in front of a reviewer: ${blocked
      .map((row) => row.sceneNumber)
      .join(
        ', ',
      )}. No FFmpeg composition has started.\n\n${lines.join('\n')}\n\nA review candidate may carry unreviewed motion — that is what it is for — but it may not carry a clip that is technically broken, because a reviewer looking at one is being asked the wrong question.`,
    blocked[0]?.sceneNumber,
  );
}

export function assertMotionGateClears(report: MotionGateReport): void {
  if (report.clears) return;

  const blocked = report.rows.filter((row) => row.status !== 'APPROVED');
  const lines = blocked.map(
    (row) => `  - scene ${row.sceneNumber} (${row.sceneRole}) — ${row.status}\n      ${row.remedy}`,
  );

  throw new StoryboardVideoError(
    report.technicallyInvalidScenes.length > 0
      ? 'MOTION_INSPECTION_FAILED'
      : 'MOTION_REVIEW_BLOCKED',
    `${blocked.length} moving scene(s) are not cleared for rendering: ${blocked
      .map((row) => row.sceneNumber)
      .join(
        ', ',
      )}. No FFmpeg composition has started and no master exists.\n\n${lines.join('\n')}\n\nA scene that silently rendered without a standing approval would produce a technically perfect file nobody had agreed to.`,
    blocked[0]?.sceneNumber,
  );
}

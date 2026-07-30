import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { StoryboardVideoError } from '../storyboard-video/failures';
import {
  assertFeedbackIsActionable,
  SceneReviewIdentitySchema,
  reviewIdentitySha256,
  type MotionReviewVerdict,
} from '../storyboard-video/motion-review-contracts';
import {
  DEFAULT_MOTION_REVIEW_DIRECTORY,
  MotionReviewLedger,
} from '../storyboard-video/motion-review-store';

/**
 * Recording a named person's decision about an acceptance clip.
 *
 * The acceptance run produces a `PENDING` record and stops; this is the only
 * thing that closes it, and it needs a person's name, their verdict and their
 * reasons in their own words. It writes to the **same** append-only ledger the
 * production gate reads, against the **same** `reviewIdentitySha256` — so a
 * decision made here is the same kind of object as one made during a full run,
 * bound to the same four inputs, and it stops applying the moment any of them
 * moves.
 *
 * It reads the identity out of the run's own `human-review-record.json` rather
 * than recomputing it. Recomputing would mean this command could record a
 * judgement about a clip that no longer exists, or about different bytes from
 * the ones the reviewer was shown; reading it back binds the decision to the
 * artefact the person actually looked at.
 *
 * Nothing here constructs a provider, reads a credential or makes a request.
 * Recording a rejection must never be able to spend money — the regeneration
 * it implies is a separate, deliberate act.
 */

export const REVIEW_RECORD_FILENAME = 'human-review-record.json';

export interface RecordDecisionInput {
  /** The acceptance run directory holding `human-review-record.json`. */
  readonly runDirectory: string;
  readonly reviewer: string;
  readonly verdict: MotionReviewVerdict;
  readonly feedback: string;
  /** Fidelity findings the reviewer named when deciding despite them. */
  readonly acknowledgedFindings?: readonly string[];
  readonly reviewDirectory?: string;
  readonly now: Date;
}

export interface RecordedDecision {
  readonly decisionId: string;
  readonly ledgerPath: string;
  readonly sceneNumber: number;
  readonly verdict: MotionReviewVerdict;
  readonly reviewer: string;
  readonly recordedAt: string;
  readonly supersedesDecisionId: string | null;
}

export async function recordSceneAcceptanceDecision(
  input: RecordDecisionInput,
): Promise<RecordedDecision> {
  const runDirectory = resolve(input.runDirectory);
  const recordPath = join(runDirectory, REVIEW_RECORD_FILENAME);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(recordPath, 'utf8'));
  } catch (error) {
    throw new StoryboardVideoError(
      'MOTION_REVIEW_BLOCKED',
      `no review record could be read at ${recordPath}: ${
        error instanceof Error ? error.message : String(error)
      }. A decision is a judgement about specific bytes, so there is nothing to decide about until a run has produced them.`,
    );
  }

  const record = raw as {
    identity?: unknown;
    identitySha256?: unknown;
    inspectionSha256?: unknown;
    sceneNumber?: unknown;
  };
  const identity = SceneReviewIdentitySchema.safeParse(record.identity);
  if (!identity.success) {
    throw new StoryboardVideoError(
      'MOTION_REVIEW_BLOCKED',
      `${recordPath} does not carry a usable review identity: ${identity.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'} ${issue.message}`)
        .join('; ')}`,
    );
  }
  if (typeof record.inspectionSha256 !== 'string') {
    throw new StoryboardVideoError(
      'MOTION_REVIEW_BLOCKED',
      `${recordPath} carries no inspectionSha256, so the decision could not say what it was made against`,
    );
  }

  // Recomputed rather than trusted: a record whose stored digest disagrees with
  // its own identity was edited, and a decision recorded against it would be
  // attributed to a person who never saw those inputs.
  const identitySha256 = reviewIdentitySha256(identity.data);
  if (record.identitySha256 !== identitySha256) {
    throw new StoryboardVideoError(
      'MOTION_REVIEW_BLOCKED',
      `${recordPath} was edited after it was written: its recorded identity digest does not match its own identity.`,
    );
  }

  assertFeedbackIsActionable(input.verdict, input.feedback, identity.data.sceneNumber);

  const ledger = await MotionReviewLedger.open(
    input.reviewDirectory ?? join(runDirectory, DEFAULT_MOTION_REVIEW_DIRECTORY),
  );

  // A decision that still applies is superseded by name rather than replaced.
  // The ledger is append-only; a changed mind is a new line citing the old one.
  const standing = ledger.latestApplicable(identity.data.sceneNumber, identitySha256);

  const decision = await ledger.append({
    decision: {
      ledgerVersion: 1,
      recordedAt: input.now.toISOString(),
      reviewer: input.reviewer,
      sceneNumber: identity.data.sceneNumber,
      verdict: input.verdict,
      feedback: input.feedback,
      identity: identity.data,
      identitySha256,
      inspectionSha256: record.inspectionSha256,
      acknowledgedFindings: [...(input.acknowledgedFindings ?? [])],
      supersedesDecisionId: standing?.decisionId ?? null,
      supersedesReason: standing
        ? 'the reviewer recorded a new judgement about the same clip'
        : null,
    },
  });

  return {
    decisionId: decision.decisionId,
    ledgerPath: ledger.filePath,
    sceneNumber: decision.sceneNumber,
    verdict: decision.verdict,
    reviewer: decision.reviewer,
    recordedAt: decision.recordedAt,
    supersedesDecisionId: decision.supersedesDecisionId,
  };
}

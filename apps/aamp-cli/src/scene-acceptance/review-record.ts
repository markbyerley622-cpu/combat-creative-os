import {
  reviewIdentitySha256,
  sceneContractSha256,
  type SceneReviewIdentity,
} from '../storyboard-video/motion-review-contracts';
import { DEFAULT_MOTION_REVIEW_DIRECTORY } from '../storyboard-video/motion-review-store';
import type { SceneManifestEntry } from '../storyboard-video/scene-manifest';

/**
 * The human review this run produces: a request, in `PENDING`, and nothing else.
 *
 * A generated clip is never approved by the thing that generated it. This
 * record states precisely what a reviewer would be deciding about — the clip's
 * bytes, the authoritative plate, the prompt as submitted and the scene
 * contract — and stops there. It carries no verdict field that could default,
 * and there is no flag anywhere on this path that writes one.
 *
 * The identity is computed with the *existing* `reviewIdentitySha256`, so a
 * decision later recorded against it through `aamp:motion-review` binds to the
 * same four inputs the production gate binds to. That is deliberate: a Scene-1
 * acceptance approval must be the same kind of object as a production
 * approval, or the gate would be reviewing something else.
 */

export const REVIEW_REQUEST_VERSION = 1 as const;

export interface PendingReviewRecord {
  readonly recordVersion: typeof REVIEW_REQUEST_VERSION;
  readonly status: 'PENDING';
  readonly sceneNumber: number;
  readonly sceneRole: string;
  readonly identity: SceneReviewIdentity;
  readonly identitySha256: string;
  readonly inspectionSha256: string;
  readonly reviewer: null;
  readonly verdict: null;
  readonly decidedAt: null;
  /** Where a decision is recorded, and by which command. */
  readonly decideWith: string;
  readonly reviewDirectory: string;
  readonly questionsForTheReviewer: readonly string[];
  readonly notice: string;
}

export const REVIEW_PENDING_NOTICE =
  "This run produced a clip and a measurement. It did not approve anything, and it cannot: an approval is a named person's recorded judgement about specific bytes, and none has been made. Until one is recorded, this clip is not a production source for Scene 1.";

export interface BuildPendingReviewInput {
  readonly scene: SceneManifestEntry;
  readonly sceneRole: string;
  readonly clipChecksumSha256: string;
  readonly plateChecksumSha256: string;
  readonly motionPromptSha256: string;
  readonly inspectionSha256: string;
  readonly reviewDirectory?: string;
  readonly openHumanJudgementQuestions: readonly string[];
}

export function buildPendingReviewRecord(input: BuildPendingReviewInput): PendingReviewRecord {
  const identity: SceneReviewIdentity = {
    sceneNumber: input.scene.sceneNumber,
    clipChecksumSha256: input.clipChecksumSha256,
    keyframeChecksumSha256: input.plateChecksumSha256,
    motionPromptSha256: input.motionPromptSha256,
    sceneContractSha256: sceneContractSha256(input.scene),
    sourceType: 'LTX_GENERATED',
    generationProvenance: 'AAMP_LTX_HOSTED_PROVIDER',
  };

  return {
    recordVersion: REVIEW_REQUEST_VERSION,
    status: 'PENDING',
    sceneNumber: input.scene.sceneNumber,
    sceneRole: input.sceneRole,
    identity,
    identitySha256: reviewIdentitySha256(identity),
    inspectionSha256: input.inspectionSha256,
    reviewer: null,
    verdict: null,
    decidedAt: null,
    decideWith:
      'pnpm aamp:motion-review decide --scene 1 --reviewer "<name>" --verdict APPROVED|REJECTED --feedback "<what you observed>"',
    reviewDirectory: input.reviewDirectory ?? DEFAULT_MOTION_REVIEW_DIRECTORY,
    questionsForTheReviewer: input.openHumanJudgementQuestions,
    notice: REVIEW_PENDING_NOTICE,
  };
}

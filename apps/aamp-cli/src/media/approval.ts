import {
  advanceCandidate,
  approvalCoversUsage,
  isInternalEvaluationOnly,
  MediaApprovalSubmissionSchema,
  selectBestRendition,
  type ApprovedUsage,
  type MediaAcquisitionRun,
  type MediaAcquisitionSelection,
  type MediaApprovalRecord,
  type MediaApprovalSubmission,
  type MediaCandidate,
} from '@combat/providers';

/**
 * Applying a human's decision to a run.
 *
 * The single rule this module enforces, in as many places as it takes: **no
 * code path here produces, suggests, defaults or infers an approval.** It reads
 * one a person wrote, checks it against the run, and either advances a
 * candidate or refuses with a reason. There is no `--approve-all`, no
 * `--assume-eligible`, no confidence threshold above which approval is
 * automatic, and no argument that turns any of the checks off.
 *
 * `writeApprovalTemplate`'s output is deliberately *not* a runnable approval:
 * every prose field says `TODO`, exactly as the preview plan template does. A
 * template that worked as-is would make the attribution untrue on first use.
 */

export class MediaApprovalError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`The approval submission was refused:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'MediaApprovalError';
  }
}

export function parseApprovalSubmission(value: unknown, path?: string): MediaApprovalSubmission {
  const result = MediaApprovalSubmissionSchema.safeParse(value);
  if (result.success) return result.data;
  throw new MediaApprovalError(
    result.error.issues.map(
      (issue) => `${path ? `${path}: ` : ''}${issue.path.join('.') || '<root>'}: ${issue.message}`,
    ),
  );
}

export interface ApplyApprovalsInput {
  readonly run: MediaAcquisitionRun;
  readonly submission: MediaApprovalSubmission;
  /** Supplied by the caller. Nothing here reads a clock. */
  readonly now: Date;
  /** Ceiling for rendition selection; the largest that fits is chosen. */
  readonly maxDownloadBytes: number;
}

export interface AppliedApproval {
  readonly candidateId: string;
  readonly selection: MediaAcquisitionSelection;
  readonly internalEvaluationOnly: boolean;
}

export interface ApplyApprovalsResult {
  readonly run: MediaAcquisitionRun;
  readonly approved: readonly AppliedApproval[];
  /** Approvals that were refused, each with the reason. Never silently dropped. */
  readonly refused: readonly {
    readonly candidateId: string;
    readonly reasons: readonly string[];
  }[];
}

/**
 * Checks one approval against its candidate.
 *
 * Returns reasons rather than throwing so a submission covering twenty
 * candidates reports all twenty verdicts. An operator fixing one refusal at a
 * time, discovering the next only after re-running, is the failure mode this
 * shape avoids — the same argument the doctor makes for reporting everything.
 */
function checkApproval(
  candidate: MediaCandidate,
  approval: MediaApprovalRecord,
  now: Date,
): readonly string[] {
  const reasons: string[] = [];

  if (!candidate.rightsDecision) {
    reasons.push(
      'the candidate carries no rights decision, so it never passed rights review. Re-run the inspection before approving it.',
    );
  } else if (candidate.rightsDecision.outcome === 'REJECTED') {
    reasons.push(
      `the rights policy rejected it (${candidate.rightsDecision.reasons.join('; ')}). A rejection is terminal: no approval overrides a licence that forbids the use.`,
    );
  }

  if (candidate.state !== 'RIGHTS_REVIEW_REQUIRED') {
    reasons.push(
      `it is ${candidate.state}; only a candidate at RIGHTS_REVIEW_REQUIRED can be approved for download. Every station is mandatory.`,
    );
  }

  for (const usage of approval.approvedUsages) {
    const coverage = approvalCoversUsage(approval, usage, now);
    if (!coverage.covered) reasons.push(coverage.reason);
  }

  const permitted = candidate.rightsDecision?.candidateUsages ?? [];
  const overreach = approval.approvedUsages.filter((usage) => !permitted.includes(usage));
  if (overreach.length > 0 && candidate.rightsDecision) {
    // Not a refusal of the reviewer's judgement — a refusal of an approval that
    // silently exceeds what the policy said was open. If the reviewer means it,
    // the policy reading has to change, not the approval.
    reasons.push(
      `the approval claims ${overreach.join(', ')}, which the rights policy did not leave open (it allowed: ${permitted.join(', ') || 'nothing'}). Reconcile the policy reading rather than the approval.`,
    );
  }

  if (approval.approvedPlatforms.length === 0) {
    reasons.push('the approval names no platform');
  }

  if (
    approval.approvedUsages.includes('PAID_SOCIAL') &&
    candidate.rights.paidAdvertisingUse !== 'PERMITTED'
  ) {
    reasons.push(
      `paid social was approved but the source states paid advertising permission is ${candidate.rights.paidAdvertisingUse}. Record the written permission that settles it, or approve organic only.`,
    );
  }

  return reasons;
}

/**
 * Applies a submission, advancing what it legitimately approves.
 *
 * Advancement goes through `advanceCandidate`, which refuses a skip — so the
 * lifecycle rule is enforced by the same function the providers use rather than
 * re-implemented here.
 */
export function applyApprovals(input: ApplyApprovalsInput): ApplyApprovalsResult {
  if (input.submission.runId !== input.run.runId) {
    throw new MediaApprovalError([
      `the submission is for run "${input.submission.runId}" but this is run "${input.run.runId}". An approval written against one run's evidence must not apply to another run's candidates.`,
    ]);
  }

  const byId = new Map(input.run.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const approved: AppliedApproval[] = [];
  const refused: { candidateId: string; reasons: readonly string[] }[] = [];
  const updated = new Map<string, MediaCandidate>();

  for (const approval of input.submission.approvals) {
    const candidate = byId.get(approval.candidateId);
    if (!candidate) {
      refused.push({
        candidateId: approval.candidateId,
        reasons: [`run "${input.run.runId}" has no candidate with this id`],
      });
      continue;
    }

    const reasons = checkApproval(candidate, approval, input.now);
    if (reasons.length > 0) {
      refused.push({ candidateId: approval.candidateId, reasons });
      continue;
    }

    const rendition = selectBestRendition(candidate, input.maxDownloadBytes);
    if (!rendition && candidate.provider !== 'EXTERNAL_PILOT_PACK') {
      refused.push({
        candidateId: approval.candidateId,
        reasons: [
          `no rendition fits the ${input.maxDownloadBytes}-byte ceiling, so there is nothing to download`,
        ],
      });
      continue;
    }

    const advanced = advanceCandidate(candidate, 'APPROVED_FOR_DOWNLOAD');
    updated.set(advanced.candidateId, advanced);
    approved.push({
      candidateId: approval.candidateId,
      selection: {
        candidateId: candidate.candidateId,
        provider: candidate.provider,
        providerAssetId: candidate.providerAssetId,
        // An imported pack candidate has no remote rendition; its bytes are
        // already on disk, and `local` names that rather than inventing a URL.
        renditionLabel: rendition?.label ?? 'local',
        approval,
        rightsDecision: candidate.rightsDecision as NonNullable<MediaCandidate['rightsDecision']>,
      },
      internalEvaluationOnly: isInternalEvaluationOnly(approval),
    });
  }

  return {
    run: {
      ...input.run,
      candidates: input.run.candidates.map(
        (candidate) => updated.get(candidate.candidateId) ?? candidate,
      ),
    },
    approved,
    refused,
  };
}

/**
 * The approval template.
 *
 * Every prose field is `TODO`, `approvedBy` is a placeholder that no reviewer
 * would leave in place, and the whole document fails its own schema's intent if
 * submitted unedited — `notes` is required and the placeholder says so out
 * loud. This is a form to fill in, not a decision to accept.
 */
export function buildApprovalTemplate(
  run: MediaAcquisitionRun,
  now: Date,
): Record<string, unknown> {
  const reviewable = run.candidates.filter(
    (candidate) => candidate.rightsDecision && candidate.rightsDecision.outcome !== 'REJECTED',
  );

  return {
    submissionVersion: 1,
    runId: run.runId,
    _instructions: [
      'This is a TEMPLATE, not an approval. Nothing in it has been approved.',
      'For each candidate you intend to use: open its landingPageUrl, read the licence, and satisfy yourself about the people, marks and releases named in _policyReasons.',
      'Replace approvedBy with your own name. Replace every TODO. Delete every candidate you are not approving — a candidate left in this file with a TODO is not an approval and will be refused.',
      'approvedUsages must be a subset of _policyAllowedUsages. INTERNAL_EVALUATION-only material produces a labelled demonstration and can never become a campaign asset.',
    ],
    approvals: reviewable.map((candidate) => ({
      candidateId: candidate.candidateId,
      approvedBy: 'TODO — your name',
      approvedUsages: ['INTERNAL_EVALUATION'],
      approvedPlatforms: ['TODO — e.g. instagram-reels'],
      effectiveDate: now.toISOString(),
      evidenceReferences: [],
      notes: 'TODO — what you read, and why you are satisfied',
      approvedAt: now.toISOString(),
      _title: candidate.title,
      _landingPageUrl: candidate.landingPageUrl,
      _declaredLicence: candidate.rights.declaredLicence,
      _policyOutcome: candidate.rightsDecision?.outcome,
      _policyAllowedUsages: candidate.rightsDecision?.candidateUsages ?? [],
      _policyReasons: candidate.rightsDecision?.reasons ?? [],
      _qualityOutcome: candidate.qualityDecision?.outcome ?? 'NOT_MEASURED',
      _humanChecksRequired: candidate.qualityDecision?.humanChecksRequired ?? [],
    })),
  };
}

/**
 * The usage an acquisition is recorded against.
 *
 * The widest usage the reviewer actually wrote down — not a default, and not an
 * inference. A reviewer who approved paid social meant it, and recording the
 * download as internal-only would quietly discard a permission they took the
 * trouble to grant.
 *
 * The isolation that matters runs the other way and is decided elsewhere:
 * `isInternalEvaluationOnly` is true when internal evaluation is the *only*
 * usage approved, and that is what routes the material into a labelled
 * demonstration instead of a campaign manifest.
 */
export function usageForAcquisition(approval: MediaApprovalRecord): ApprovedUsage {
  if (approval.approvedUsages.includes('PAID_SOCIAL')) return 'PAID_SOCIAL';
  if (approval.approvedUsages.includes('ORGANIC_SOCIAL')) return 'ORGANIC_SOCIAL';
  return 'INTERNAL_EVALUATION';
}

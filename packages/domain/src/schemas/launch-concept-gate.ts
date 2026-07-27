import { z } from 'zod';

import { LaunchConceptSchema } from './launch-concept';

/**
 * The human concept gate — immutable concept versions, an attributed decision,
 * and the guard that decides whether a selection may stand.
 *
 * This mirrors `HumanApprovalSchema`'s discipline rather than inventing a
 * second one: a record is written once and never edited, a revised decision is
 * a new record, and the audit trail of "who decided what, when" cannot be
 * altered afterwards. What it adds is the thing the workflow gates do not have
 * — a *set* of competing candidates, each of which can be revised into a new
 * immutable version that supersedes the one before it.
 *
 * Nothing here can be reached without a named reviewer, and nothing downstream
 * runs without a selection: script planning, shot planning and rendering all
 * refuse until `LaunchConceptSelectionSchema` validates.
 */

export const LAUNCH_CONCEPT_ORIGINS = ['INITIAL_COMPETITION', 'REVISION'] as const;
export const LaunchConceptOriginSchema = z.enum(LAUNCH_CONCEPT_ORIGINS);
export type LaunchConceptOrigin = z.infer<typeof LaunchConceptOriginSchema>;

/**
 * One immutable version of one concept.
 *
 * `supersedesVersion` is what makes the chain auditable without a mutation log
 * that does not exist: version 2 records that it replaced version 1, version 1
 * is still on disk exactly as the agent produced it, and a reviewer can read
 * both.
 */
export const LaunchConceptVersionSchema = z
  .object({
    recordVersion: z.literal(1),
    conceptId: z.string().min(1).max(80),
    version: z.number().int().positive(),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    /** The run that produced this version. A concept never crosses runs. */
    launchRunId: z.string().min(1).max(120),
    origin: LaunchConceptOriginSchema,
    supersedesVersion: z.number().int().positive().optional(),
    /** `agent-name@vN`, so a concept records which prompt version authored it. */
    authoredByAgent: z.string().min(1).max(120),
    createdAt: z.string().min(1).max(40),
    /** The reviewer feedback this version was produced in response to. */
    revisionFeedback: z.string().min(1).max(4000).optional(),
    /** sha256 of the canonically-serialised concept. Pins the version to its content. */
    conceptChecksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** The campaign brief this concept was authored against. */
    campaignPromptSha256: z.string().regex(/^[0-9a-f]{64}$/),
    concept: LaunchConceptSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.origin === 'REVISION' && record.supersedesVersion === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a revision must name the version it supersedes',
        path: ['supersedesVersion'],
      });
    }
    if (record.origin === 'INITIAL_COMPETITION' && record.supersedesVersion !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an initial candidate supersedes nothing',
        path: ['supersedesVersion'],
      });
    }
    if (record.origin === 'REVISION' && !record.revisionFeedback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a revision exists because a reviewer asked for one — the feedback that caused it is part of the record',
        path: ['revisionFeedback'],
      });
    }
  });
export type LaunchConceptVersion = z.infer<typeof LaunchConceptVersionSchema>;

export const LAUNCH_GATE_DECISIONS = ['SELECTED', 'REVISION_REQUESTED', 'ALL_REJECTED'] as const;
export const LaunchGateDecisionKindSchema = z.enum(LAUNCH_GATE_DECISIONS);
export type LaunchGateDecisionKind = z.infer<typeof LaunchGateDecisionKindSchema>;

export const LaunchGateDecisionSchema = z
  .object({
    recordVersion: z.literal(1),
    decisionId: z.string().min(1).max(120),
    launchRunId: z.string().min(1).max(120),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    gate: z.literal('CONCEPT'),
    decision: LaunchGateDecisionKindSchema,
    reviewerId: z.string().min(1).max(200),
    decidedAt: z.string().min(1).max(40),
    /** Present for SELECTED and REVISION_REQUESTED; absent for ALL_REJECTED. */
    conceptId: z.string().min(1).max(80).optional(),
    conceptVersion: z.number().int().positive().optional(),
    /** Required for anything other than a selection: a rejection without a reason is not reviewable. */
    feedback: z.string().min(1).max(4000).optional(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    const needsConcept = decision.decision !== 'ALL_REJECTED';
    if (
      needsConcept &&
      (decision.conceptId === undefined || decision.conceptVersion === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a ${decision.decision} decision must name the concept version it applies to`,
        path: ['conceptId'],
      });
    }
    if (decision.decision !== 'SELECTED' && !decision.feedback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'written feedback is required for a revision request or a rejection',
        path: ['feedback'],
      });
    }
  });
export type LaunchGateDecision = z.infer<typeof LaunchGateDecisionSchema>;

export const LAUNCH_SELECTION_NOTICE =
  'One named reviewer selected this concept version. Selection authorises script planning, shot planning and rendering for this concept only; it is not final approval of the finished advertisement, which remains a separate human decision.' as const;

export const LaunchConceptSelectionSchema = z
  .object({
    selectionVersion: z.literal(1),
    launchRunId: z.string().min(1).max(120),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    conceptId: z.string().min(1).max(80),
    conceptVersion: z.number().int().positive(),
    /** Pins the selection to exact concept bytes, so an edited file is detectable. */
    conceptChecksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    campaignPromptSha256: z.string().regex(/^[0-9a-f]{64}$/),
    benchmarkProfileName: z.string().min(1).max(120),
    reviewerId: z.string().min(1).max(200),
    selectedAt: z.string().min(1).max(40),
    decisionId: z.string().min(1).max(120),
    requiresHumanApproval: z.literal(true),
    notice: z.literal(LAUNCH_SELECTION_NOTICE),
  })
  .strict();
export type LaunchConceptSelection = z.infer<typeof LaunchConceptSelectionSchema>;

/**
 * Every reason a selection is refused, as a closed vocabulary.
 *
 * A caller branches on these rather than on prose, and each names a different
 * operator response: a superseded version means "select the revision", a stale
 * prompt means "the brief changed, re-plan", and a cross-workspace attempt
 * means something is wrong that is not a typo.
 */
export const LAUNCH_SELECTION_REFUSALS = [
  'UNKNOWN_CONCEPT',
  'UNKNOWN_VERSION',
  'SUPERSEDED_VERSION',
  'STALE_CAMPAIGN_PROMPT',
  'CROSS_WORKSPACE',
  'WRONG_CAMPAIGN',
  'NOT_SELECTABLE',
  'REVIEWER_NOT_APPROVED',
  'ALREADY_SELECTED',
] as const;
export const LaunchSelectionRefusalSchema = z.enum(LAUNCH_SELECTION_REFUSALS);
export type LaunchSelectionRefusal = z.infer<typeof LaunchSelectionRefusalSchema>;

export interface LaunchSelectionCandidateState {
  readonly conceptId: string;
  /** Every version of this concept that exists, ascending. */
  readonly versions: readonly number[];
  /** The highest version. Anything below it is superseded. */
  readonly latestVersion: number;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly campaignPromptSha256: string;
  /** From the concept's assessment. False blocks selection. */
  readonly selectable: boolean;
  readonly blockingReasons: readonly string[];
}

export interface LaunchSelectionRequest {
  readonly conceptId: string;
  /** Absent means "the latest version". Present is checked exactly. */
  readonly conceptVersion?: number;
  readonly reviewerId: string;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly campaignPromptSha256: string;
  readonly approvedReviewerIds: readonly string[];
  readonly alreadySelected: boolean;
}

export type LaunchSelectionOutcome =
  | { readonly ok: true; readonly conceptId: string; readonly conceptVersion: number }
  | { readonly ok: false; readonly refusal: LaunchSelectionRefusal; readonly detail: string };

/**
 * Whether this reviewer may select this concept version, and if not, exactly why.
 *
 * Pure, so the refusals are testable without a filesystem, and ordered from the
 * most fundamental outward — a cross-workspace attempt is reported as that,
 * never as "unknown concept", because the two mean very different things.
 */
export function evaluateConceptSelection(
  request: LaunchSelectionRequest,
  candidates: readonly LaunchSelectionCandidateState[],
): LaunchSelectionOutcome {
  if (!request.approvedReviewerIds.includes(request.reviewerId)) {
    return {
      ok: false,
      refusal: 'REVIEWER_NOT_APPROVED',
      detail: `"${request.reviewerId}" is not one of this campaign's approved reviewers`,
    };
  }
  if (request.alreadySelected) {
    return {
      ok: false,
      refusal: 'ALREADY_SELECTED',
      detail:
        'this run already has a recorded selection; a changed decision is a new run, not an overwritten record',
    };
  }

  const candidate = candidates.find((entry) => entry.conceptId === request.conceptId);
  if (!candidate) {
    return {
      ok: false,
      refusal: 'UNKNOWN_CONCEPT',
      detail: `no concept "${request.conceptId}" exists in this run`,
    };
  }
  if (candidate.workspaceId !== request.workspaceId) {
    return {
      ok: false,
      refusal: 'CROSS_WORKSPACE',
      detail: `concept "${request.conceptId}" belongs to another workspace`,
    };
  }
  if (candidate.campaignId !== request.campaignId) {
    return {
      ok: false,
      refusal: 'WRONG_CAMPAIGN',
      detail: `concept "${request.conceptId}" belongs to another campaign`,
    };
  }

  const version = request.conceptVersion ?? candidate.latestVersion;
  if (!candidate.versions.includes(version)) {
    return {
      ok: false,
      refusal: 'UNKNOWN_VERSION',
      detail: `concept "${request.conceptId}" has no version ${version}`,
    };
  }
  if (version < candidate.latestVersion) {
    return {
      ok: false,
      refusal: 'SUPERSEDED_VERSION',
      detail: `version ${version} was superseded by version ${candidate.latestVersion}; select that one or request a further revision`,
    };
  }
  if (candidate.campaignPromptSha256 !== request.campaignPromptSha256) {
    return {
      ok: false,
      refusal: 'STALE_CAMPAIGN_PROMPT',
      detail:
        'this concept was authored against a different campaign brief; re-plan before selecting, because the concept answers a question that is no longer being asked',
    };
  }
  if (!candidate.selectable) {
    return {
      ok: false,
      refusal: 'NOT_SELECTABLE',
      detail:
        candidate.blockingReasons.join('; ') || 'the assessment marked this concept unselectable',
    };
  }

  return { ok: true, conceptId: candidate.conceptId, conceptVersion: version };
}

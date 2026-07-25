import type {
  CampaignStage,
  GenerationCandidate,
  QualityAssessment,
  QualityFailure,
} from '@combat/domain';

export type QualityAssessmentRecord = QualityAssessment;
export type QualityFailureRecord = QualityFailure;

/**
 * M7: persistence for the Visual Quality Controller / Continuity Controller
 * agents' output — one immutable `QualityAssessment` per (GenerationCandidate,
 * subjectStage), with zero or more `QualityFailure` children. Only the
 * candidate-assessment shape (`generationCandidateId` set, `assetId` unset)
 * is exercised by this milestone; asset-based assessments (COMPOSITING/
 * ROUGH_CUT/SOUND_DESIGN/FINAL_QA) remain a future milestone's concern, even
 * though `TransitionFactsDataSource`'s `qualityAssessment`/`qualityFailure`
 * fields (packages/database/src/repositories/transition-facts.ts) already
 * read both shapes.
 */
export interface QualityAssessmentDataSource {
  qualityAssessment: {
    create(args: {
      data: Omit<QualityAssessmentRecord, 'id' | 'createdAt'>;
    }): Promise<QualityAssessmentRecord>;
    findFirst(args: {
      where: { generationCandidateId: string; subjectStage: CampaignStage; workspaceId: string };
    }): Promise<QualityAssessmentRecord | null>;
    findMany(args: {
      where: { generationCandidateId: { in: string[] }; workspaceId: string };
    }): Promise<QualityAssessmentRecord[]>;
  };
  qualityFailure: {
    create(args: {
      data: Omit<QualityFailureRecord, 'id' | 'createdAt'>;
    }): Promise<QualityFailureRecord>;
    findMany(args: { where: { qualityAssessmentId: string } }): Promise<QualityFailureRecord[]>;
  };
}

export type QualityFindingInput = Omit<
  QualityFailureRecord,
  'id' | 'workspaceId' | 'qualityAssessmentId' | 'createdAt'
>;

/**
 * Thrown when a candidate belongs to a different workspace than the one
 * requesting the assessment — never assess (or leak the existence of) another
 * tenant's candidate (CLAUDE.md: "Every ... repository function that touches a
 * workspace-owned table ... folds [workspaceId] into the query").
 */
export class CrossWorkspaceQualityAssessmentError extends Error {
  constructor(candidateId: string, candidateWorkspaceId: string, requestedWorkspaceId: string) {
    super(
      `Candidate ${candidateId} belongs to workspace ${candidateWorkspaceId}, not ${requestedWorkspaceId}`,
    );
    this.name = 'CrossWorkspaceQualityAssessmentError';
  }
}

/** Thrown when a candidate belongs to a different campaign than the assessment being recorded — a mismatched candidate. */
export class CampaignMismatchError extends Error {
  constructor(candidateId: string, candidateCampaignId: string, requestedCampaignId: string) {
    super(
      `Candidate ${candidateId} belongs to campaign ${candidateCampaignId}, not ${requestedCampaignId}`,
    );
    this.name = 'CampaignMismatchError';
  }
}

/**
 * Thrown when a candidate is not a currently-assessable generation output:
 * either it never reached `SUCCEEDED` (nothing usable to review) or it has
 * been superseded by a newer candidate for the same shot (a stale candidate
 * from an earlier generation attempt). Assessing a stale candidate would let
 * an out-of-date pass/fail drive a stage transition, so it is refused at the
 * persistence boundary rather than silently recorded.
 */
export class StaleCandidateError extends Error {
  constructor(candidateId: string, detail: string) {
    super(`Candidate ${candidateId} is not assessable: ${detail}`);
    this.name = 'StaleCandidateError';
  }
}

export interface AssessableCandidateContext {
  readonly candidate: Pick<GenerationCandidate, 'id' | 'workspaceId' | 'status'>;
  /** The candidate's true owning campaign, resolved from its ShotGenerationJob by the caller. */
  readonly candidateCampaignId: string;
  /** The latest candidate id for the candidate's shot — anything else is a superseded (stale) candidate. */
  readonly latestCandidateId: string;
  readonly workspaceId: string;
  readonly campaignId: string;
}

/**
 * Pure guard enforcing the three "never assess this candidate" invariants
 * (cross-workspace, mismatched campaign, stale/unusable). Exported so it can
 * be unit-tested directly and reused by any future asset-based assessment
 * path, and called by `createQualityAssessmentForCandidate` before any insert.
 */
export function assertCandidateAssessable(ctx: AssessableCandidateContext): void {
  const { candidate, candidateCampaignId, latestCandidateId, workspaceId, campaignId } = ctx;
  if (candidate.workspaceId !== workspaceId) {
    throw new CrossWorkspaceQualityAssessmentError(
      candidate.id,
      candidate.workspaceId,
      workspaceId,
    );
  }
  if (candidateCampaignId !== campaignId) {
    throw new CampaignMismatchError(candidate.id, candidateCampaignId, campaignId);
  }
  if (candidate.status !== 'SUCCEEDED') {
    throw new StaleCandidateError(candidate.id, `status is ${candidate.status}, not SUCCEEDED`);
  }
  if (candidate.id !== latestCandidateId) {
    throw new StaleCandidateError(
      candidate.id,
      `superseded by a newer candidate (${latestCandidateId}) for the same shot`,
    );
  }
}

export interface CreateQualityAssessmentInput extends AssessableCandidateContext {
  readonly subjectStage: CampaignStage;
  readonly pass: boolean;
  readonly overallScore: number;
  readonly scores: Record<string, number>;
  readonly assessedBy: QualityAssessmentRecord['assessedBy'];
  readonly createdByAgentInvocationId?: string;
  readonly failures: readonly QualityFindingInput[];
}

/**
 * Immutable + idempotent: at most one `QualityAssessment` per
 * (generationCandidateId, subjectStage) ever exists. A replayed Activity call
 * — including the case where `executeSpecialistAgentActivity` itself already
 * returned a cached, `replayed: true` agent result — finds the existing
 * assessment (with its failures already persisted) and returns it rather than
 * inserting a duplicate row, matching CLAUDE.md's "exact retries must be
 * idempotent." A fresh assessment is only recorded after
 * `assertCandidateAssessable` clears the candidate — so a cross-workspace,
 * mismatched, or stale candidate is rejected before any row is written.
 */
export async function createQualityAssessmentForCandidate(
  db: QualityAssessmentDataSource,
  input: CreateQualityAssessmentInput,
): Promise<{ assessment: QualityAssessmentRecord; alreadyExisted: boolean }> {
  const { workspaceId, campaignId, candidate, subjectStage } = input;

  // Idempotency first: an exact retry returns the prior row and never
  // re-runs the guard (a candidate that was valid at first assessment must
  // stay returnable even if a later generation attempt has since superseded
  // it — the recorded assessment is immutable history).
  const existing = await db.qualityAssessment.findFirst({
    where: { generationCandidateId: candidate.id, subjectStage, workspaceId },
  });
  if (existing) return { assessment: existing, alreadyExisted: true };

  assertCandidateAssessable(input);

  const assessment = await db.qualityAssessment.create({
    data: {
      workspaceId,
      campaignId,
      generationCandidateId: candidate.id,
      subjectStage,
      pass: input.pass,
      scores: input.scores,
      overallScore: input.overallScore,
      assessedBy: input.assessedBy,
      createdByAgentInvocationId: input.createdByAgentInvocationId,
    },
  });

  for (const failure of input.failures) {
    // eslint-disable-next-line no-await-in-loop -- small, per-assessment set; sequential keeps ordering deterministic and this only runs once per fresh assessment (the idempotency check above skips it on replay)
    await db.qualityFailure.create({
      data: { workspaceId, qualityAssessmentId: assessment.id, ...failure },
    });
  }

  return { assessment, alreadyExisted: false };
}

export async function getQualityAssessmentForCandidate(
  db: QualityAssessmentDataSource,
  workspaceId: string,
  generationCandidateId: string,
  subjectStage: CampaignStage,
): Promise<QualityAssessmentRecord | undefined> {
  return (
    (await db.qualityAssessment.findFirst({
      where: { generationCandidateId, subjectStage, workspaceId },
    })) ?? undefined
  );
}

export async function listQualityAssessmentsForCandidates(
  db: QualityAssessmentDataSource,
  workspaceId: string,
  generationCandidateIds: string[],
): Promise<QualityAssessmentRecord[]> {
  if (generationCandidateIds.length === 0) return [];
  return db.qualityAssessment.findMany({
    where: { generationCandidateId: { in: generationCandidateIds }, workspaceId },
  });
}

export async function listQualityFailuresForAssessment(
  db: QualityAssessmentDataSource,
  qualityAssessmentId: string,
): Promise<QualityFailureRecord[]> {
  return db.qualityFailure.findMany({ where: { qualityAssessmentId } });
}

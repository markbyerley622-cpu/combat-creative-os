import type { ShotSelection, ShotSelectionReplacement, ShotSelectionSet } from '@combat/domain';

export type ShotSelectionSetRecord = ShotSelectionSet;
export type ShotSelectionRecord = ShotSelection;
export type ShotSelectionReplacementRecord = ShotSelectionReplacement;

/**
 * M8 persistence for the human Shot Selection at HUMAN_SHOT_SELECTION. A
 * `ShotSelectionSet` is one versioned revision of a reviewer's choices; its
 * child `ShotSelection` rows hold one choice per required shot. Mutations use
 * optimistic concurrency (a `revision` compare-and-swap) and are refused once
 * the set is APPROVED — an approved set is immutable (CLAUDE.md: human gates
 * require immutable records). Every method is workspace-scoped.
 */
export interface ShotSelectionDataSource {
  shotSelectionSet: {
    create(args: {
      data: Omit<ShotSelectionSetRecord, 'id' | 'createdAt' | 'updatedAt'>;
    }): Promise<ShotSelectionSetRecord>;
    findFirst(args: {
      where:
        | { id: string; workspaceId: string }
        | { campaignId: string; version: number; workspaceId: string };
    }): Promise<ShotSelectionSetRecord | null>;
    findMany(args: {
      where: { campaignId: string; workspaceId: string };
    }): Promise<ShotSelectionSetRecord[]>;
    updateMany(args: {
      where: { id: string; workspaceId: string; revision: number; status: 'DRAFT' };
      data: Partial<
        Pick<ShotSelectionSetRecord, 'status' | 'reviewerUserId' | 'rationale' | 'approvedAt'>
      > & { revision: { increment: number } };
    }): Promise<{ count: number }>;
  };
  shotSelection: {
    create(args: {
      data: Omit<ShotSelectionRecord, 'id' | 'createdAt' | 'updatedAt'>;
    }): Promise<ShotSelectionRecord>;
    findMany(args: { where: { shotSelectionSetId: string } }): Promise<ShotSelectionRecord[]>;
    updateMany(args: {
      where: { shotSelectionSetId: string; shotId: string };
      data: Partial<
        Pick<
          ShotSelectionRecord,
          | 'status'
          | 'selectedCandidateId'
          | 'visualQaAssessmentId'
          | 'continuityQaAssessmentId'
          | 'rationale'
          | 'regenerationFeedback'
        >
      >;
    }): Promise<{ count: number }>;
  };
  shotSelectionReplacement: {
    create(args: {
      data: Omit<ShotSelectionReplacementRecord, 'id' | 'createdAt'>;
    }): Promise<ShotSelectionReplacementRecord>;
    findMany(args: {
      where: { shotSelectionSetId: string };
    }): Promise<ShotSelectionReplacementRecord[]>;
  };
}

export interface RequiredShotInput {
  shotId: string;
  sequencePosition: number;
  shotSpecificationId: string;
  shotSpecificationVersion: number;
}

/**
 * Idempotent by `(campaignId, version)`: a replayed create for the same
 * revision returns the existing set with its PENDING per-shot rows rather than
 * inserting a duplicate. Every required shot gets a PENDING `ShotSelection`
 * immediately, so completeness is always "every row SELECTED", never "some
 * rows missing".
 */
export async function createDraftShotSelectionSet(
  db: ShotSelectionDataSource,
  workspaceId: string,
  input: {
    campaignId: string;
    scriptId: string;
    scriptVersion: number;
    creativeConceptId: string;
    creativeConceptVersion: number;
    version: number;
    createdByUserId: string;
    idempotencyKey?: string;
    requiredShots: readonly RequiredShotInput[];
  },
): Promise<{ set: ShotSelectionSetRecord; alreadyExisted: boolean }> {
  const existing = await db.shotSelectionSet.findFirst({
    where: { campaignId: input.campaignId, version: input.version, workspaceId },
  });
  if (existing) return { set: existing, alreadyExisted: true };

  const set = await db.shotSelectionSet.create({
    data: {
      workspaceId,
      campaignId: input.campaignId,
      scriptId: input.scriptId,
      scriptVersion: input.scriptVersion,
      creativeConceptId: input.creativeConceptId,
      creativeConceptVersion: input.creativeConceptVersion,
      version: input.version,
      status: 'DRAFT',
      createdByUserId: input.createdByUserId,
      revision: 0,
      idempotencyKey: input.idempotencyKey,
    },
  });

  for (const shot of input.requiredShots) {
    // eslint-disable-next-line no-await-in-loop -- small, per-set set; sequential keeps ordering deterministic and this only runs once per fresh set
    await db.shotSelection.create({
      data: {
        workspaceId,
        shotSelectionSetId: set.id,
        shotId: shot.shotId,
        sequencePosition: shot.sequencePosition,
        shotSpecificationId: shot.shotSpecificationId,
        shotSpecificationVersion: shot.shotSpecificationVersion,
        status: 'PENDING',
      },
    });
  }

  return { set, alreadyExisted: false };
}

export async function getShotSelectionSet(
  db: ShotSelectionDataSource,
  workspaceId: string,
  setId: string,
): Promise<ShotSelectionSetRecord | null> {
  return db.shotSelectionSet.findFirst({ where: { id: setId, workspaceId } });
}

export async function getLatestShotSelectionSet(
  db: ShotSelectionDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<ShotSelectionSetRecord | undefined> {
  const sets = await db.shotSelectionSet.findMany({ where: { campaignId, workspaceId } });
  return [...sets].sort((a, b) => b.version - a.version)[0];
}

export async function listShotSelections(
  db: ShotSelectionDataSource,
  shotSelectionSetId: string,
): Promise<ShotSelectionRecord[]> {
  const rows = await db.shotSelection.findMany({ where: { shotSelectionSetId } });
  return [...rows].sort((a, b) => a.sequencePosition - b.sequencePosition);
}

export async function listShotSelectionReplacements(
  db: ShotSelectionDataSource,
  shotSelectionSetId: string,
): Promise<ShotSelectionReplacementRecord[]> {
  return db.shotSelectionReplacement.findMany({ where: { shotSelectionSetId } });
}

export type ShotSelectionMutationError =
  'SET_NOT_FOUND' | 'NOT_DRAFT' | 'STALE_REVISION' | 'SHOT_NOT_IN_SET';

async function casSetRevision(
  db: ShotSelectionDataSource,
  workspaceId: string,
  setId: string,
  expectedRevision: number,
): Promise<{ count: number }> {
  return db.shotSelectionSet.updateMany({
    where: { id: setId, workspaceId, revision: expectedRevision, status: 'DRAFT' },
    data: { revision: { increment: 1 } },
  });
}

/**
 * Selects (or replaces) a candidate for one shot in a DRAFT set, under
 * optimistic concurrency. A stale `expectedRevision` or an APPROVED set is
 * refused. Replacing a previously-selected candidate appends a
 * `ShotSelectionReplacement` (replacement history). The caller is responsible
 * for having verified the candidate is eligible (see
 * `gatherCandidateEligibility`) — this function only enforces set state and
 * concurrency.
 */
export async function setShotSelectionCandidate(
  db: ShotSelectionDataSource,
  workspaceId: string,
  input: {
    setId: string;
    shotId: string;
    candidateId: string;
    expectedRevision: number;
    userId: string;
    rationale?: string;
    visualQaAssessmentId?: string;
    continuityQaAssessmentId?: string;
  },
): Promise<
  { ok: true; set: ShotSelectionSetRecord } | { ok: false; reason: ShotSelectionMutationError }
> {
  const set = await db.shotSelectionSet.findFirst({ where: { id: input.setId, workspaceId } });
  if (!set) return { ok: false, reason: 'SET_NOT_FOUND' };
  if (set.status !== 'DRAFT') return { ok: false, reason: 'NOT_DRAFT' };

  const selections = await db.shotSelection.findMany({ where: { shotSelectionSetId: set.id } });
  const selection = selections.find((s) => s.shotId === input.shotId);
  if (!selection) return { ok: false, reason: 'SHOT_NOT_IN_SET' };

  const cas = await casSetRevision(db, workspaceId, set.id, input.expectedRevision);
  if (cas.count === 0) return { ok: false, reason: 'STALE_REVISION' };

  const previousCandidateId = selection.selectedCandidateId;
  await db.shotSelection.updateMany({
    where: { shotSelectionSetId: set.id, shotId: input.shotId },
    data: {
      status: 'SELECTED',
      selectedCandidateId: input.candidateId,
      visualQaAssessmentId: input.visualQaAssessmentId,
      continuityQaAssessmentId: input.continuityQaAssessmentId,
      rationale: input.rationale,
      regenerationFeedback: undefined,
    },
  });

  if (previousCandidateId && previousCandidateId !== input.candidateId) {
    await db.shotSelectionReplacement.create({
      data: {
        workspaceId,
        shotSelectionSetId: set.id,
        shotId: input.shotId,
        previousCandidateId,
        newCandidateId: input.candidateId,
        replacedByUserId: input.userId,
        reason: input.rationale,
      },
    });
  }

  const updated = await db.shotSelectionSet.findFirst({ where: { id: set.id, workspaceId } });
  return { ok: true, set: updated! };
}

/** Marks a shot REJECTED with regeneration feedback, under optimistic concurrency. */
export async function rejectShotSelection(
  db: ShotSelectionDataSource,
  workspaceId: string,
  input: {
    setId: string;
    shotId: string;
    regenerationFeedback: string;
    expectedRevision: number;
    userId: string;
  },
): Promise<
  { ok: true; set: ShotSelectionSetRecord } | { ok: false; reason: ShotSelectionMutationError }
> {
  const set = await db.shotSelectionSet.findFirst({ where: { id: input.setId, workspaceId } });
  if (!set) return { ok: false, reason: 'SET_NOT_FOUND' };
  if (set.status !== 'DRAFT') return { ok: false, reason: 'NOT_DRAFT' };

  const selections = await db.shotSelection.findMany({ where: { shotSelectionSetId: set.id } });
  const selection = selections.find((s) => s.shotId === input.shotId);
  if (!selection) return { ok: false, reason: 'SHOT_NOT_IN_SET' };

  const cas = await casSetRevision(db, workspaceId, set.id, input.expectedRevision);
  if (cas.count === 0) return { ok: false, reason: 'STALE_REVISION' };

  const previousCandidateId = selection.selectedCandidateId;
  await db.shotSelection.updateMany({
    where: { shotSelectionSetId: set.id, shotId: input.shotId },
    data: {
      status: 'REJECTED',
      selectedCandidateId: undefined,
      regenerationFeedback: input.regenerationFeedback,
    },
  });
  if (previousCandidateId) {
    await db.shotSelectionReplacement.create({
      data: {
        workspaceId,
        shotSelectionSetId: set.id,
        shotId: input.shotId,
        previousCandidateId,
        newCandidateId: undefined,
        replacedByUserId: input.userId,
        reason: input.regenerationFeedback,
      },
    });
  }

  const updated = await db.shotSelectionSet.findFirst({ where: { id: set.id, workspaceId } });
  return { ok: true, set: updated! };
}

export type ApproveShotSelectionError =
  'SET_NOT_FOUND' | 'NOT_DRAFT' | 'STALE_REVISION' | 'INCOMPLETE' | 'INELIGIBLE_CANDIDATE';

/**
 * Freezes a DRAFT set into an immutable APPROVED one. Fails unless every
 * required shot is SELECTED (no PENDING/REJECTED — "incomplete"), every
 * selected candidate id is in `eligibleCandidateIds` (the caller supplies the
 * currently-eligible set, so a candidate that has since gone ineligible cannot
 * be approved), and the `expectedRevision` still matches (no concurrent edit).
 * The APPROVED status is written via the same DRAFT-guarded compare-and-swap,
 * so two concurrent approvals cannot both win.
 */
export async function approveShotSelectionSet(
  db: ShotSelectionDataSource,
  workspaceId: string,
  input: {
    setId: string;
    reviewerUserId: string;
    expectedRevision: number;
    eligibleCandidateIds: ReadonlySet<string>;
    approvedAt: Date;
  },
): Promise<
  | { ok: true; set: ShotSelectionSetRecord }
  | { ok: false; reason: ApproveShotSelectionError; detail?: string }
> {
  const set = await db.shotSelectionSet.findFirst({ where: { id: input.setId, workspaceId } });
  if (!set) return { ok: false, reason: 'SET_NOT_FOUND' };
  if (set.status !== 'DRAFT') return { ok: false, reason: 'NOT_DRAFT' };
  if (set.revision !== input.expectedRevision) return { ok: false, reason: 'STALE_REVISION' };

  const selections = await db.shotSelection.findMany({ where: { shotSelectionSetId: set.id } });
  const incomplete = selections.filter((s) => s.status !== 'SELECTED' || !s.selectedCandidateId);
  if (selections.length === 0 || incomplete.length > 0) {
    return {
      ok: false,
      reason: 'INCOMPLETE',
      detail: `${incomplete.length} of ${selections.length} required shots are not resolved`,
    };
  }
  const ineligible = selections.filter(
    (s) => !s.selectedCandidateId || !input.eligibleCandidateIds.has(s.selectedCandidateId),
  );
  if (ineligible.length > 0) {
    return {
      ok: false,
      reason: 'INELIGIBLE_CANDIDATE',
      detail: `shots ${ineligible.map((s) => s.shotId).join(', ')} reference an ineligible candidate`,
    };
  }

  const cas = await db.shotSelectionSet.updateMany({
    where: { id: set.id, workspaceId, revision: input.expectedRevision, status: 'DRAFT' },
    data: {
      status: 'APPROVED',
      reviewerUserId: input.reviewerUserId,
      approvedAt: input.approvedAt,
      revision: { increment: 1 },
    },
  });
  if (cas.count === 0) return { ok: false, reason: 'STALE_REVISION' };

  const updated = await db.shotSelectionSet.findFirst({ where: { id: set.id, workspaceId } });
  return { ok: true, set: updated! };
}

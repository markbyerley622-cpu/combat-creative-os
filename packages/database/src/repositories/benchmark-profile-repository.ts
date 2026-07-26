import { createHash } from 'node:crypto';

import {
  BenchmarkGovernanceProfileSchema,
  benchmarkProfileChecksumInput,
  benchmarkProfileRejection,
  type BenchmarkGovernanceProfile,
  type BenchmarkProfileApplicability,
  type BenchmarkProfileRejection,
  type BenchmarkProfileReviewStatus,
  type CreativeMemoryAgentRole,
  type ReferenceBusinessRole,
} from '@combat/domain';

/**
 * Persistence for agency benchmark governance profiles.
 *
 * A profile row is written once and never rewritten. A changed decision is a
 * **new version** carrying `supersedesProfileId`; the only mutation this
 * repository performs is withdrawal, which flips `active`/`reviewStatus` and
 * touches no governing field. That is why `governingChecksumSha256` covers the
 * governing fields alone — it stays valid for the lifetime of the row, so a
 * mismatch means tampering rather than ordinary operation.
 *
 * Deliberately on the reference side of the rights wall. Nothing here names an
 * asset, a path or a licence, and no function returns something a render
 * manifest could consume: a benchmark profile authorises influence on planning
 * and can never make reference material renderable.
 *
 * Every function takes `workspaceId` first and folds it into the query, per
 * CLAUDE.md's repository rule.
 */

/** Flat row, matching the Prisma model's columns. */
export interface BenchmarkGovernanceProfileRecord {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  agentRole: CreativeMemoryAgentRole;
  applicablePlatforms: string[];
  applicableCampaignIds: string[];
  active: boolean;
  reviewStatus: BenchmarkProfileReviewStatus;
  requiredReferenceRoles: ReferenceBusinessRole[];
  allowedCollections: string[];
  maxTopK: number;
  maxContextCharacters: number;
  maxItemsPerReference: number;
  minDistinctReferences: number;
  requireOriginalTransformation: boolean;
  prohibitedSimilarityRules: string[];
  activationValidForDays?: number | null;
  annotationValidForDays?: number | null;
  reviewerId?: string | null;
  approvedAt?: Date | null;
  activatedBy: string;
  activatedAt: Date;
  supersedesProfileId?: string | null;
  governingChecksumSha256: string;
  notes?: string | null;
  createdAt: Date;
}

/** The Prisma-shaped surface this repository needs. */
export interface BenchmarkProfileDataSource {
  benchmarkGovernanceProfile: {
    create(args: { data: Record<string, unknown> }): Promise<BenchmarkGovernanceProfileRecord>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<BenchmarkGovernanceProfileRecord>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
    }): Promise<BenchmarkGovernanceProfileRecord[]>;
  };
}

export class BenchmarkProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkProfileError';
  }
}

/** The governing-field checksum. Hashing lives here because domain has no Node dependency. */
export function computeBenchmarkProfileChecksum(
  profile: Parameters<typeof benchmarkProfileChecksumInput>[0],
): string {
  return createHash('sha256').update(benchmarkProfileChecksumInput(profile), 'utf8').digest('hex');
}

/** Row → validated domain profile. Parsed, not cast: a malformed row is a hard error. */
export function toBenchmarkGovernanceProfile(
  row: BenchmarkGovernanceProfileRecord,
): BenchmarkGovernanceProfile {
  return BenchmarkGovernanceProfileSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    version: row.version,
    agentRole: row.agentRole,
    applicablePlatforms: row.applicablePlatforms,
    applicableCampaignIds: row.applicableCampaignIds,
    active: row.active,
    reviewStatus: row.reviewStatus,
    requiredReferenceRoles: row.requiredReferenceRoles,
    allowedCollections: row.allowedCollections,
    maxTopK: row.maxTopK,
    maxContextCharacters: row.maxContextCharacters,
    maxItemsPerReference: row.maxItemsPerReference,
    minDistinctReferences: row.minDistinctReferences,
    requireOriginalTransformation: row.requireOriginalTransformation,
    prohibitedSimilarityRules: row.prohibitedSimilarityRules,
    ...(row.activationValidForDays === null || row.activationValidForDays === undefined
      ? {}
      : { activationValidForDays: row.activationValidForDays }),
    ...(row.annotationValidForDays === null || row.annotationValidForDays === undefined
      ? {}
      : { annotationValidForDays: row.annotationValidForDays }),
    ...(row.reviewerId ? { reviewerId: row.reviewerId } : {}),
    ...(row.approvedAt ? { approvedAt: row.approvedAt } : {}),
    activationProvenance: {
      activatedBy: row.activatedBy,
      activatedAt: row.activatedAt,
      ...(row.supersedesProfileId ? { supersedesProfileId: row.supersedesProfileId } : {}),
      governingChecksumSha256: row.governingChecksumSha256,
    },
    ...(row.notes ? { notes: row.notes } : {}),
    createdAt: row.createdAt,
  });
}

export interface CreateBenchmarkProfileInput {
  readonly name: string;
  readonly agentRole: CreativeMemoryAgentRole;
  readonly applicablePlatforms?: readonly string[];
  readonly applicableCampaignIds?: readonly string[];
  readonly requiredReferenceRoles: readonly ReferenceBusinessRole[];
  readonly allowedCollections?: readonly string[];
  readonly maxTopK: number;
  readonly maxContextCharacters: number;
  readonly maxItemsPerReference: number;
  readonly minDistinctReferences: number;
  readonly requireOriginalTransformation?: boolean;
  readonly prohibitedSimilarityRules: readonly string[];
  readonly activationValidForDays?: number;
  readonly annotationValidForDays?: number;
  readonly reviewStatus: BenchmarkProfileReviewStatus;
  readonly reviewerId?: string;
  readonly approvedAt?: Date;
  readonly active: boolean;
  readonly activatedBy: string;
  readonly activatedAt: Date;
  readonly notes?: string;
}

/**
 * Writes the next version of a profile.
 *
 * Activating a new version deactivates the one it replaces and records the
 * replacement on the new row, so "which profile governed this campaign, and
 * what did it replace" is answerable from the rows alone.
 */
export async function createBenchmarkProfileVersion(
  db: BenchmarkProfileDataSource,
  workspaceId: string,
  input: CreateBenchmarkProfileInput,
): Promise<BenchmarkGovernanceProfileRecord> {
  if (input.active && input.reviewStatus !== 'APPROVED') {
    throw new BenchmarkProfileError(
      `cannot activate profile "${input.name}" while its review status is ${input.reviewStatus} — only an approved profile may influence a campaign`,
    );
  }
  if (input.reviewStatus === 'APPROVED' && (!input.reviewerId || !input.approvedAt)) {
    throw new BenchmarkProfileError(
      `approving profile "${input.name}" requires a reviewerId and an approval instant — an unattributed approval is not an approval`,
    );
  }

  const existing = await db.benchmarkGovernanceProfile.findMany({
    where: { workspaceId, name: input.name, agentRole: input.agentRole },
    orderBy: { version: 'desc' },
  });
  const version = (existing[0]?.version ?? 0) + 1;
  const superseded = input.active ? existing.find((row) => row.active) : undefined;

  const governing = {
    workspaceId,
    name: input.name,
    version,
    agentRole: input.agentRole,
    applicablePlatforms: [...(input.applicablePlatforms ?? [])],
    applicableCampaignIds: [...(input.applicableCampaignIds ?? [])],
    active: input.active,
    reviewStatus: input.reviewStatus,
    requiredReferenceRoles: [...input.requiredReferenceRoles],
    allowedCollections: [...(input.allowedCollections ?? [])],
    maxTopK: input.maxTopK,
    maxContextCharacters: input.maxContextCharacters,
    maxItemsPerReference: input.maxItemsPerReference,
    minDistinctReferences: input.minDistinctReferences,
    requireOriginalTransformation: input.requireOriginalTransformation ?? true,
    prohibitedSimilarityRules: [...input.prohibitedSimilarityRules],
    ...(input.activationValidForDays === undefined
      ? {}
      : { activationValidForDays: input.activationValidForDays }),
    ...(input.annotationValidForDays === undefined
      ? {}
      : { annotationValidForDays: input.annotationValidForDays }),
    ...(input.reviewerId ? { reviewerId: input.reviewerId } : {}),
    ...(input.approvedAt ? { approvedAt: input.approvedAt } : {}),
  };

  const created = await db.benchmarkGovernanceProfile.create({
    data: {
      ...governing,
      activatedBy: input.activatedBy,
      activatedAt: input.activatedAt,
      ...(superseded ? { supersedesProfileId: superseded.id } : {}),
      governingChecksumSha256: computeBenchmarkProfileChecksum(governing),
      ...(input.notes ? { notes: input.notes } : {}),
    },
  });

  if (superseded) {
    await db.benchmarkGovernanceProfile.update({
      where: { id: superseded.id },
      data: { active: false },
    });
  }

  return created;
}

/** Withdraws a profile. The only mutation permitted, and it touches no governing field. */
export async function withdrawBenchmarkProfile(
  db: BenchmarkProfileDataSource,
  workspaceId: string,
  profileId: string,
): Promise<BenchmarkGovernanceProfileRecord> {
  const [row] = await db.benchmarkGovernanceProfile.findMany({
    where: { workspaceId, id: profileId },
  });
  if (!row) {
    throw new BenchmarkProfileError(`profile ${profileId} not found in workspace ${workspaceId}`);
  }
  return db.benchmarkGovernanceProfile.update({
    where: { id: profileId },
    data: { active: false, reviewStatus: 'WITHDRAWN' },
  });
}

export async function listBenchmarkProfiles(
  db: BenchmarkProfileDataSource,
  workspaceId: string,
  filter: { agentRole?: CreativeMemoryAgentRole; active?: boolean } = {},
): Promise<BenchmarkGovernanceProfileRecord[]> {
  return db.benchmarkGovernanceProfile.findMany({
    where: {
      workspaceId,
      ...(filter.agentRole ? { agentRole: filter.agentRole } : {}),
      ...(filter.active === undefined ? {} : { active: filter.active }),
    },
    orderBy: { version: 'desc' },
  });
}

export type BenchmarkProfileResolution =
  | { readonly kind: 'RESOLVED'; readonly profile: BenchmarkGovernanceProfile }
  | { readonly kind: 'REJECTED'; readonly rejections: readonly BenchmarkProfileRejection[] };

/**
 * The single question the injection pipeline asks: may anything govern this
 * role, for this campaign, right now?
 *
 * When several versions are active — which the write path prevents but a manual
 * database edit could produce — the highest version wins, so behaviour stays
 * deterministic rather than depending on row order. Every rejection reason
 * encountered is returned, because "not approved" and "wrong platform" call for
 * different operator responses and reporting only the first would hide one.
 */
export async function resolveActiveBenchmarkProfile(
  db: BenchmarkProfileDataSource,
  applicability: BenchmarkProfileApplicability,
): Promise<BenchmarkProfileResolution> {
  const rows = await db.benchmarkGovernanceProfile.findMany({
    where: { workspaceId: applicability.workspaceId, agentRole: applicability.agentRole },
    orderBy: { version: 'desc' },
  });

  const rejections: BenchmarkProfileRejection[] = [];
  for (const row of rows) {
    const profile = toBenchmarkGovernanceProfile(row);
    const rejection = benchmarkProfileRejection(profile, applicability);
    if (rejection) {
      rejections.push(rejection);
      continue;
    }
    // Recomputed rather than trusted: the checksum is only worth storing if
    // something actually compares against it.
    const expected = computeBenchmarkProfileChecksum(profile);
    if (expected !== profile.activationProvenance.governingChecksumSha256) {
      rejections.push('CHECKSUM_MISMATCH');
      continue;
    }
    return { kind: 'RESOLVED', profile };
  }

  return { kind: 'REJECTED', rejections: [...new Set(rejections)] };
}

import {
  createBenchmarkProfileVersion,
  listBenchmarkProfiles,
  resolveActiveBenchmarkProfile,
  withdrawBenchmarkProfile,
  type ReferenceDataSource,
} from '@combat/database';
import {
  CREATIVE_MEMORY_AGENT_ROLES,
  CREATIVE_MEMORY_RETRIEVAL_PLANS,
  type CreativeMemoryAgentRole,
} from '@combat/domain';

/**
 * The operator surface for agency benchmark governance.
 *
 * Deliberately a CLI rather than a dashboard: this milestone's requirement is
 * that an approval be **attributable, versioned and auditable**, not that it be
 * clickable, and a typed repository plus these four commands satisfies that
 * without adding a UI boundary that would then have to be authorised, tested
 * and kept in step.
 *
 * No command here can approve on someone's behalf. `--reviewer` and
 * `--activated-by` are required for an approval, and a profile that names no
 * reviewer is refused by the repository, not by a prompt.
 */

export const BENCHMARK_EXIT_CODES = {
  SUCCESS: 0,
  INVALID_ARGUMENTS: 2,
  NO_APPROVED_PROFILE: 17,
  WRITE_FAILED: 18,
} as const;

export interface BenchmarkCommandContext {
  readonly db: ReferenceDataSource;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Caller-supplied instant, so a seeded fixture is reproducible. */
  readonly now: () => Date;
}

/**
 * The default limits a fixture profile is created with: whatever the role's
 * retrieval plan already asks for.
 *
 * Governance may only tighten a plan, so seeding a profile that matches the
 * plan exactly is the neutral starting point — it authorises the role without
 * silently changing what the engineering policy asked for.
 */
export function fixtureProfileLimits(agentRole: CreativeMemoryAgentRole): {
  readonly maxTopK: number;
  readonly maxContextCharacters: number;
  readonly maxItemsPerReference: number;
  readonly minDistinctReferences: number;
  readonly requiredReferenceRoles: readonly string[];
} {
  const plan = CREATIVE_MEMORY_RETRIEVAL_PLANS[agentRole];
  return {
    maxTopK: plan.topK,
    maxContextCharacters: plan.maxContextCharacters,
    maxItemsPerReference: plan.maxItemsPerReference,
    minDistinctReferences: plan.minDistinctReferences,
    requiredReferenceRoles: plan.referenceRoles,
  };
}

export const DEFAULT_PROHIBITED_SIMILARITY_RULES: readonly string[] = [
  'No reference wording, caption copy or voiceover line may be reproduced.',
  'No reference shot sequence or ordered beat length pattern may be reproduced.',
  'No reference music, logo or branded asset may be used in any output.',
  'No agency, studio, creator or existing campaign may be named or imitated.',
  'Every retrieved principle must be transformed into an original, campaign-specific application.',
];

export interface SeedBenchmarkProfilesOptions {
  readonly workspaceId: string;
  readonly name: string;
  readonly reviewerId: string;
  readonly activatedBy: string;
  readonly at: Date;
  readonly platforms?: readonly string[];
  readonly campaignIds?: readonly string[];
}

/**
 * Creates one approved, active profile per specialist role.
 *
 * Used by the acceptance fixture and by `aamp:reference benchmark-seed`. It is
 * a *fixture* path, not an auto-approval path: it still records a named
 * reviewer and a named activator, and it refuses to run without them.
 */
export async function seedBenchmarkProfiles(
  db: ReferenceDataSource,
  options: SeedBenchmarkProfilesOptions,
): Promise<readonly { agentRole: CreativeMemoryAgentRole; id: string; version: number }[]> {
  if (!options.reviewerId.trim() || !options.activatedBy.trim()) {
    throw new Error(
      'seeding a benchmark profile requires a reviewer and an activator — an unattributed approval is not an approval',
    );
  }

  const created: { agentRole: CreativeMemoryAgentRole; id: string; version: number }[] = [];
  for (const agentRole of CREATIVE_MEMORY_AGENT_ROLES) {
    const limits = fixtureProfileLimits(agentRole);
    // eslint-disable-next-line no-await-in-loop -- seeded in declared role order for determinism
    const row = await createBenchmarkProfileVersion(db, options.workspaceId, {
      name: options.name,
      agentRole,
      applicablePlatforms: [...(options.platforms ?? [])],
      applicableCampaignIds: [...(options.campaignIds ?? [])],
      requiredReferenceRoles: [...limits.requiredReferenceRoles] as Parameters<
        typeof createBenchmarkProfileVersion
      >[2]['requiredReferenceRoles'],
      maxTopK: limits.maxTopK,
      maxContextCharacters: limits.maxContextCharacters,
      maxItemsPerReference: limits.maxItemsPerReference,
      minDistinctReferences: limits.minDistinctReferences,
      requireOriginalTransformation: true,
      prohibitedSimilarityRules: [...DEFAULT_PROHIBITED_SIMILARITY_RULES],
      reviewStatus: 'APPROVED',
      reviewerId: options.reviewerId,
      approvedAt: options.at,
      active: true,
      activatedBy: options.activatedBy,
      activatedAt: options.at,
      notes: 'Seeded benchmark governance profile. Grants no output rights.',
    });
    created.push({ agentRole, id: row.id, version: row.version });
  }
  return created;
}

export async function runBenchmarkSeedCommand(
  values: Readonly<Record<string, string>>,
  context: BenchmarkCommandContext,
): Promise<number> {
  const workspaceId = values.workspace;
  const reviewerId = values.reviewer;
  const activatedBy = values['activated-by'] ?? values.reviewer;
  if (!workspaceId || !reviewerId) {
    context.stderr(
      'benchmark-seed requires --workspace <uuid> --reviewer <id> [--activated-by <id>] [--name <name>] [--platform <PLATFORM>]\n',
    );
    return BENCHMARK_EXIT_CODES.INVALID_ARGUMENTS;
  }

  try {
    const created = await seedBenchmarkProfiles(context.db, {
      workspaceId,
      name: values.name ?? 'combat-reviews-benchmark',
      reviewerId,
      activatedBy: activatedBy as string,
      at: context.now(),
      ...(values.platform ? { platforms: [values.platform] } : {}),
    });
    context.stdout(
      `${JSON.stringify(
        {
          workspaceId,
          profiles: created,
          notice:
            'A benchmark profile authorises influence on planning only. It grants no output rights and cannot make reference material renderable.',
        },
        null,
        2,
      )}\n`,
    );
    return BENCHMARK_EXIT_CODES.SUCCESS;
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return BENCHMARK_EXIT_CODES.WRITE_FAILED;
  }
}

export async function runBenchmarkListCommand(
  values: Readonly<Record<string, string>>,
  context: BenchmarkCommandContext,
): Promise<number> {
  const workspaceId = values.workspace;
  if (!workspaceId) {
    context.stderr('benchmark-list requires --workspace <uuid>\n');
    return BENCHMARK_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const rows = await listBenchmarkProfiles(context.db, workspaceId, {
    ...(values.role ? { agentRole: values.role as CreativeMemoryAgentRole } : {}),
  });
  context.stdout(
    `${JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        agentRole: row.agentRole,
        reviewStatus: row.reviewStatus,
        active: row.active,
        reviewerId: row.reviewerId ?? null,
        approvedAt: row.approvedAt ?? null,
        activatedBy: row.activatedBy,
        activatedAt: row.activatedAt,
        supersedesProfileId: row.supersedesProfileId ?? null,
        governingChecksumSha256: row.governingChecksumSha256,
      })),
      null,
      2,
    )}\n`,
  );
  return BENCHMARK_EXIT_CODES.SUCCESS;
}

export async function runBenchmarkWithdrawCommand(
  values: Readonly<Record<string, string>>,
  context: BenchmarkCommandContext,
): Promise<number> {
  const workspaceId = values.workspace;
  const profileId = values.profile;
  if (!workspaceId || !profileId) {
    context.stderr('benchmark-withdraw requires --workspace <uuid> --profile <uuid>\n');
    return BENCHMARK_EXIT_CODES.INVALID_ARGUMENTS;
  }
  try {
    const row = await withdrawBenchmarkProfile(context.db, workspaceId, profileId);
    context.stdout(
      `${JSON.stringify({ id: row.id, reviewStatus: row.reviewStatus, active: row.active }, null, 2)}\n`,
    );
    return BENCHMARK_EXIT_CODES.SUCCESS;
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return BENCHMARK_EXIT_CODES.WRITE_FAILED;
  }
}

/** Answers "what would govern this campaign right now, and if nothing, why not". */
export async function runBenchmarkResolveCommand(
  values: Readonly<Record<string, string>>,
  context: BenchmarkCommandContext,
): Promise<number> {
  const workspaceId = values.workspace;
  const campaignId = values.campaign;
  const role = values.role as CreativeMemoryAgentRole | undefined;
  if (!workspaceId || !campaignId || !role) {
    context.stderr(
      'benchmark-resolve requires --workspace <uuid> --campaign <uuid> --role <AGENT_ROLE> [--platform <PLATFORM>]\n',
    );
    return BENCHMARK_EXIT_CODES.INVALID_ARGUMENTS;
  }

  const resolution = await resolveActiveBenchmarkProfile(context.db, {
    workspaceId,
    campaignId,
    agentRole: role,
    platform: values.platform ?? 'TIKTOK',
    now: context.now(),
  });

  context.stdout(`${JSON.stringify(resolution, null, 2)}\n`);
  return resolution.kind === 'RESOLVED'
    ? BENCHMARK_EXIT_CODES.SUCCESS
    : BENCHMARK_EXIT_CODES.NO_APPROVED_PROFILE;
}

import { describe, expect, it } from 'vitest';

import { InMemoryReferenceStore } from './in-memory-reference-store';
import {
  computeBenchmarkProfileChecksum,
  createBenchmarkProfileVersion,
  listBenchmarkProfiles,
  resolveActiveBenchmarkProfile,
  toBenchmarkGovernanceProfile,
  withdrawBenchmarkProfile,
  type CreateBenchmarkProfileInput,
} from './benchmark-profile-repository';

/**
 * Benchmark governance persistence.
 *
 * The properties under test are the ones an auditor would ask about: who
 * approved this, what did it replace, could it have been edited afterwards, and
 * could another workspace's profile have influenced this campaign.
 */

const WORKSPACE_A = '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e';
const WORKSPACE_B = '11111111-2222-4333-8444-555555555555';
const CAMPAIGN = '99999999-9999-4999-8999-999999999999';
const AT = new Date('2026-07-01T00:00:00.000Z');

function input(overrides: Partial<CreateBenchmarkProfileInput> = {}): CreateBenchmarkProfileInput {
  return {
    name: 'combat-reviews-benchmark',
    agentRole: 'CAMPAIGN_STRATEGIST',
    requiredReferenceRoles: ['CAMPAIGN_STRATEGY'],
    maxTopK: 4,
    maxContextCharacters: 6000,
    maxItemsPerReference: 2,
    minDistinctReferences: 1,
    prohibitedSimilarityRules: ['No wording may be reused.'],
    reviewStatus: 'APPROVED',
    reviewerId: 'reviewer-1',
    approvedAt: AT,
    active: true,
    activatedBy: 'operator-1',
    activatedAt: AT,
    ...overrides,
  };
}

const applicability = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: WORKSPACE_A,
  agentRole: 'CAMPAIGN_STRATEGIST' as const,
  platform: 'TIKTOK',
  campaignId: CAMPAIGN,
  now: AT,
  ...overrides,
});

describe('approval is attributable or it does not happen', () => {
  it('refuses to approve without a reviewer', async () => {
    const store = new InMemoryReferenceStore();
    await expect(
      createBenchmarkProfileVersion(store, WORKSPACE_A, {
        ...input(),
        reviewerId: undefined,
        approvedAt: undefined,
      }),
    ).rejects.toThrow(/reviewerId/i);
  });

  it('refuses to activate a profile that is not approved', async () => {
    const store = new InMemoryReferenceStore();
    await expect(
      createBenchmarkProfileVersion(store, WORKSPACE_A, {
        ...input(),
        reviewStatus: 'DRAFT',
        reviewerId: undefined,
        approvedAt: undefined,
      }),
    ).rejects.toThrow(/only an approved profile/i);
  });
});

describe('versioning and replacement are auditable', () => {
  it('assigns the next version and supersedes the profile it replaces', async () => {
    const store = new InMemoryReferenceStore();
    const first = await createBenchmarkProfileVersion(store, WORKSPACE_A, input());
    const second = await createBenchmarkProfileVersion(
      store,
      WORKSPACE_A,
      input({ maxTopK: 3, activatedBy: 'operator-2' }),
    );

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.supersedesProfileId).toBe(first.id);

    const rows = await listBenchmarkProfiles(store, WORKSPACE_A);
    expect(rows.find((row) => row.id === first.id)?.active).toBe(false);
    expect(rows.find((row) => row.id === second.id)?.active).toBe(true);
  });

  it('resolves the newest active version', async () => {
    const store = new InMemoryReferenceStore();
    await createBenchmarkProfileVersion(store, WORKSPACE_A, input());
    const second = await createBenchmarkProfileVersion(store, WORKSPACE_A, input({ maxTopK: 3 }));

    const resolution = await resolveActiveBenchmarkProfile(store, applicability());
    expect(resolution.kind).toBe('RESOLVED');
    expect(resolution.kind === 'RESOLVED' && resolution.profile.id).toBe(second.id);
  });

  it('stops governing once withdrawn', async () => {
    const store = new InMemoryReferenceStore();
    const row = await createBenchmarkProfileVersion(store, WORKSPACE_A, input());
    await withdrawBenchmarkProfile(store, WORKSPACE_A, row.id);

    const resolution = await resolveActiveBenchmarkProfile(store, applicability());
    expect(resolution.kind).toBe('REJECTED');
    expect(resolution.kind === 'REJECTED' && resolution.rejections).toContain('NOT_APPROVED');
  });
});

describe('applicability', () => {
  it('refuses a profile for another agent role', async () => {
    const store = new InMemoryReferenceStore();
    await createBenchmarkProfileVersion(store, WORKSPACE_A, input());
    const resolution = await resolveActiveBenchmarkProfile(
      store,
      applicability({ agentRole: 'SHOT_PROMPT_ENGINEER' }),
    );
    expect(resolution.kind).toBe('REJECTED');
  });

  it('refuses a platform outside a non-empty allowlist', async () => {
    const store = new InMemoryReferenceStore();
    await createBenchmarkProfileVersion(
      store,
      WORKSPACE_A,
      input({ applicablePlatforms: ['YOUTUBE_SHORTS'] }),
    );
    const resolution = await resolveActiveBenchmarkProfile(store, applicability());
    expect(resolution.kind === 'REJECTED' && resolution.rejections).toContain(
      'PLATFORM_NOT_APPLICABLE',
    );
  });

  it('refuses a campaign outside a non-empty allowlist', async () => {
    const store = new InMemoryReferenceStore();
    await createBenchmarkProfileVersion(
      store,
      WORKSPACE_A,
      input({ applicableCampaignIds: ['88888888-8888-4888-8888-888888888888'] }),
    );
    const resolution = await resolveActiveBenchmarkProfile(store, applicability());
    expect(resolution.kind === 'REJECTED' && resolution.rejections).toContain(
      'CAMPAIGN_NOT_APPLICABLE',
    );
  });

  it('refuses an activation that has gone stale', async () => {
    const store = new InMemoryReferenceStore();
    await createBenchmarkProfileVersion(store, WORKSPACE_A, input({ activationValidForDays: 30 }));
    const resolution = await resolveActiveBenchmarkProfile(
      store,
      applicability({ now: new Date('2026-09-01T00:00:00.000Z') }),
    );
    expect(resolution.kind === 'REJECTED' && resolution.rejections).toContain('STALE_ACTIVATION');
  });
});

describe('workspace isolation and tamper detection', () => {
  it('cannot see another workspace’s profile', async () => {
    const store = new InMemoryReferenceStore();
    await createBenchmarkProfileVersion(store, WORKSPACE_B, input());

    const resolution = await resolveActiveBenchmarkProfile(store, applicability());
    expect(resolution.kind).toBe('REJECTED');
    expect(await listBenchmarkProfiles(store, WORKSPACE_A)).toEqual([]);
  });

  it('refuses a row whose governing fields no longer match its checksum', async () => {
    const store = new InMemoryReferenceStore();
    const row = await createBenchmarkProfileVersion(store, WORKSPACE_A, input());
    // Simulates a direct database edit, which is the only way this happens:
    // the repository never rewrites a governing field.
    await store.benchmarkGovernanceProfile.update({
      where: { id: row.id },
      data: { maxTopK: 20 },
    });

    const resolution = await resolveActiveBenchmarkProfile(store, applicability());
    expect(resolution.kind === 'REJECTED' && resolution.rejections).toContain('CHECKSUM_MISMATCH');
  });

  it('leaves the checksum valid after a withdrawal, which touches no governing field', async () => {
    const store = new InMemoryReferenceStore();
    const row = await createBenchmarkProfileVersion(store, WORKSPACE_A, input());
    await withdrawBenchmarkProfile(store, WORKSPACE_A, row.id);

    const [withdrawn] = await listBenchmarkProfiles(store, WORKSPACE_A);
    const profile = toBenchmarkGovernanceProfile(withdrawn!);
    expect(computeBenchmarkProfileChecksum(profile)).toBe(
      profile.activationProvenance.governingChecksumSha256,
    );
  });
});

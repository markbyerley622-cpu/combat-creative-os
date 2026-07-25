import { InMemoryCampaignStore, addMembership } from '@combat/database';
import { createLogger } from '@combat/observability';
import { MockReviewProvider, MockStorageProvider } from '@combat/providers';
import type { WorkflowClient } from '@temporalio/client';
import { buildServer } from './server';

/**
 * A Fastify server backed entirely by in-memory fakes (no Postgres, no
 * Temporal) — never used by `src/index.ts`'s production entry point. This
 * exists so `apps/dashboard`'s Playwright suite (which needs a real
 * apps/api HTTP server to hit — CLAUDE.md forbids the dashboard from having
 * any direct DB/Temporal access of its own) can exercise real RBAC and
 * route code without the live infrastructure this environment doesn't have
 * (no Docker, no live Postgres — see docs/architecture.md §7.1). Fixture
 * ids are hardcoded and read by apps/dashboard/e2e/concept-approval.spec.ts.
 */

export const FIXTURES = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  ownerUserId: '22222222-2222-2222-2222-222222222222',
  reviewerUserId: '33333333-3333-3333-3333-333333333333',
  campaignId: '44444444-4444-4444-4444-444444444444',
};

function buildFakeWorkflowClient(): WorkflowClient {
  const query = async (def: { name: string }) => {
    if (def.name === 'getStatus') return 'AWAITING_APPROVAL';
    if (def.name === 'getPendingGate') return 'CONCEPT';
    if (def.name === 'getRevisionCount') return 0;
    return undefined;
  };
  const getHandle = () => ({ query, signal: async () => undefined });
  const start = async () => ({ workflowId: 'fake', firstExecutionRunId: 'fake' });
  return { start, getHandle } as unknown as WorkflowClient;
}

async function seed(store: InMemoryCampaignStore) {
  await addMembership(store, FIXTURES.workspaceId, {
    userId: FIXTURES.ownerUserId,
    role: 'OWNER_ADMIN',
  });
  await addMembership(store, FIXTURES.workspaceId, {
    userId: FIXTURES.reviewerUserId,
    role: 'REVIEWER',
  });
  store.seedCampaign({
    id: FIXTURES.campaignId,
    workspaceId: FIXTURES.workspaceId,
    name: 'Combat Reviews Q3 Launch',
    currentStage: 'CONCEPT_REVIEW',
  });
  store.campaignBriefRecords.push({
    id: '55555555-5555-5555-5555-555555555555',
    workspaceId: FIXTURES.workspaceId,
    campaignId: FIXTURES.campaignId,
    version: 1,
    campaignName: 'Combat Reviews Q3 Launch',
    productName: 'Combat Reviews',
    productDescription: 'Review aggregator for combat sports gyms',
    objective: 'Drive trial signups',
    targetAudience: 'MMA gym owners',
    customerProblem: 'No easy way to collect reviews',
    valueProposition: 'Automated review collection',
    productFeatures: ['review widgets'],
    targetPlatforms: ['INSTAGRAM_REELS'],
    aspectRatios: ['9:16'],
    durationsSeconds: [15],
    brandVoice: 'confident',
    visualDirection: 'gritty gym footage',
    requiredMessaging: ['try it free'],
    callToAction: 'Sign up today',
    references: [],
    assetReferences: [],
    prohibitedClaims: [],
    budgetCents: 500000,
    locale: 'en-US',
    acceptedAt: new Date(),
    createdAt: new Date(),
  });
  store.strategies.push({
    id: '66666666-6666-6666-6666-666666666666',
    workspaceId: FIXTURES.workspaceId,
    campaignId: FIXTURES.campaignId,
    version: 1,
    positioning: 'The trusted, automated review layer for combat gyms',
    targetAudienceSummary: 'Gym owners aged 28-45',
    keyMessages: ['Automated review collection', 'Built for combat gyms'],
    toneGuidelines: ['Confident, direct'],
    audienceProfile: {
      name: 'Gym Owner',
      demographics: {},
      psychographics: {},
      painPoints: ['manual review requests take too long'],
      platformBehavior: {},
    },
    createdAt: new Date(),
  });
  store.creativeConceptRecords.push({
    id: '77777777-7777-7777-7777-777777777777',
    workspaceId: FIXTURES.workspaceId,
    campaignId: FIXTURES.campaignId,
    version: 1,
    logline: 'A gym owner watches reviews roll in without lifting a finger.',
    visualDirection: 'Handheld gym footage, warm lighting.',
    narrativeArc: 'Problem -> discovery -> relief.',
    referenceNotes: [],
    createdAt: new Date(),
  });
  const scriptId = '88888888-8888-8888-8888-888888888888';
  store.scriptRecords.push({
    id: scriptId,
    workspaceId: FIXTURES.workspaceId,
    campaignId: FIXTURES.campaignId,
    creativeConceptId: '77777777-7777-7777-7777-777777777777',
    version: 1,
    totalDurationFrames: 450,
    createdAt: new Date(),
  });
  store.shotRecords.push({
    id: '99999999-9999-9999-9999-999999999999',
    workspaceId: FIXTURES.workspaceId,
    scriptId,
    index: 0,
    description: 'Hook: gym owner frustrated at a laptop.',
    durationFrames: 90,
    beat: 'HOOK',
    status: 'PENDING',
    dependsOnShotIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function main() {
  const store = new InMemoryCampaignStore();
  await seed(store);
  const app = buildServer({
    logger: createLogger({ serviceName: 'api-fake', level: 'silent' }),
    approvalDb: store,
    campaignDb: store,
    assetDb: store,
    shotGenerationDb: store,
    shotReviewDb: store,
    storageProvider: new MockStorageProvider(),
    reviewProvider: new MockReviewProvider(),
    workflowClient: buildFakeWorkflowClient(),
  });
  const port = Number(process.env.PORT ?? 4100);
  await app.listen({ host: '127.0.0.1', port });
  // eslint-disable-next-line no-console
  console.log(`apps/api dev-fake-server listening on http://127.0.0.1:${port}`);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('dev-fake-server failed to start:', error);
  process.exitCode = 1;
});

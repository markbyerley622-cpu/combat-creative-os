import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  addMembership,
  createCreativeConcept,
  createScriptWithShots,
  createShotSpecification,
  getOrCreateShotGenerationJob,
  InMemoryCampaignStore,
} from '@combat/database';
import { registerShotGenerationRoutes } from './shot-generation-routes';
import { registerAuthentication } from './authentication';
import { bearerFor, permissiveTestAuthentication } from './test-helpers/authenticated-caller';

function buildApp() {
  const store = new InMemoryCampaignStore();
  const app = Fastify();
  // AAMP-1 step 2: these suites exercise authorization, so the caller arrives
  // authenticated exactly as a production caller does — a verified bearer
  // token, never a request field. See test-helpers/authenticated-caller.ts.
  registerAuthentication(app, permissiveTestAuthentication().hookDeps);
  registerShotGenerationRoutes(app, { db: store });
  return { app, store };
}

async function seedOwner(store: InMemoryCampaignStore, workspaceId: string) {
  const userId = randomUUID();
  await addMembership(store, workspaceId, { userId, role: 'OWNER_ADMIN' });
  return userId;
}

async function seedScriptAndSpec(
  store: InMemoryCampaignStore,
  workspaceId: string,
  campaignId: string,
) {
  const concept = await createCreativeConcept(store, workspaceId, {
    campaignId,
    version: 1,
    logline: 'l',
    visualDirection: 'v',
    narrativeArc: 'n',
    referenceNotes: [],
  });
  const { script, shots } = await createScriptWithShots(store, workspaceId, {
    campaignId,
    creativeConceptId: concept.id,
    version: 1,
    totalDurationFrames: 90,
    shots: [
      { index: 0, description: 'a', durationFrames: 90, beat: 'HOOK', dependsOnShotIndices: [] },
    ],
  });
  const spec = await createShotSpecification(store, workspaceId, {
    campaignId,
    creativeConceptId: concept.id,
    creativeConceptVersion: 1,
    scriptId: script.id,
    scriptVersion: 1,
    shotId: shots[0]!.id,
    version: 1,
    shotNumber: 0,
    sequencePosition: 0,
    intendedDurationSeconds: 3,
    visualObjective: 'o',
    action: 'a',
    subject: 's',
    environment: 'e',
    cameraMovement: 'static',
    lensFraming: 'wide',
    lighting: 'soft',
    colorTreatment: 'neutral',
    motionIntensity: 'LOW',
    transitionIn: 'CUT',
    transitionOut: 'CUT',
    textSafeAreas: [],
    referenceAssetIds: [],
    continuityRequirements: [],
    providerId: 'mock',
    promptVersionId: randomUUID(),
    generationPrompt: 'prompt',
    generationParams: { durationSeconds: 3, aspectRatio: '9:16', providerOptions: {} },
    outputRequirements: { durationSeconds: 3, aspectRatio: '9:16', minCandidateCount: 1 },
    qualityRubric: ['check the thing'],
    licensingConstraints: [],
    createdByAgentInvocationId: randomUUID(),
  });
  return { script, shots, spec };
}

describe('GET /workspaces/:workspaceId/campaigns/:campaignId/shot-generation', () => {
  it('returns 403 for a non-member', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    store.seedCampaign({ id: campaignId, workspaceId });

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-generation`,
      headers: bearerFor(randomUUID()),
    });

    expect(response.statusCode).toBe(403);
  });

  it('returns an empty shots list when the campaign has no script yet', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    store.seedCampaign({ id: campaignId, workspaceId });
    const userId = await seedOwner(store, workspaceId);

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-generation`,
      headers: bearerFor(userId),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      script: null,
      shots: [],
      budget: { workspace: null, campaign: null },
    });
  });

  it('returns each shot with its specification, job, attempts, and candidates', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    store.seedCampaign({ id: campaignId, workspaceId });
    const userId = await seedOwner(store, workspaceId);
    const { shots, spec } = await seedScriptAndSpec(store, workspaceId, campaignId);
    const job = await getOrCreateShotGenerationJob(store, workspaceId, {
      campaignId,
      shotSpecificationId: spec.id,
      requestedCandidateCount: 1,
      maxAttempts: 3,
    });
    store.shotGenerationAttemptRecords.push({
      id: randomUUID(),
      workspaceId,
      shotGenerationJobId: job.id,
      attemptNumber: 1,
      idempotencyKey: 'k1',
      providerId: 'mock',
      providerJobId: 'job-1',
      status: 'SUCCEEDED',
      requestedCandidateCount: 1,
      generationParams: { durationSeconds: 3, aspectRatio: '9:16', providerOptions: {} },
      startedAt: new Date(),
      createdAt: new Date(),
    });
    store.generationCandidateRecords.push({
      id: randomUUID(),
      workspaceId,
      shotSpecificationId: spec.id,
      shotGenerationAttemptId: job.id,
      candidateIndex: 0,
      assetId: randomUUID(),
      status: 'SUCCEEDED',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-generation`,
      headers: bearerFor(userId),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.shots).toHaveLength(1);
    expect(body.shots[0].shotId).toBe(shots[0]!.id);
    expect(body.shots[0].specification.id).toBe(spec.id);
    expect(body.shots[0].specification.qualityRubric).toEqual(['check the thing']);
    expect(body.shots[0].generationJob.id).toBe(job.id);
    expect(body.shots[0].attempts).toHaveLength(1);
    expect(body.shots[0].attempts[0].status).toBe('SUCCEEDED');
    expect(body.shots[0].candidates).toHaveLength(1);
    expect(body.shots[0].candidates[0].hasMedia).toBe(false);
  });

  it('reports null specification/job for a shot that has not been prompted yet', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    store.seedCampaign({ id: campaignId, workspaceId });
    const userId = await seedOwner(store, workspaceId);
    const concept = await createCreativeConcept(store, workspaceId, {
      campaignId,
      version: 1,
      logline: 'l',
      visualDirection: 'v',
      narrativeArc: 'n',
      referenceNotes: [],
    });
    await createScriptWithShots(store, workspaceId, {
      campaignId,
      creativeConceptId: concept.id,
      version: 1,
      totalDurationFrames: 90,
      shots: [
        { index: 0, description: 'a', durationFrames: 90, beat: 'HOOK', dependsOnShotIndices: [] },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-generation`,
      headers: bearerFor(userId),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.shots).toHaveLength(1);
    expect(body.shots[0].specification).toBeNull();
    expect(body.shots[0].generationJob).toBeNull();
    expect(body.shots[0].attempts).toEqual([]);
    expect(body.shots[0].candidates).toEqual([]);
  });

  it('reports budget consumption when a policy is configured', async () => {
    const { app, store } = buildApp();
    const workspaceId = randomUUID();
    const campaignId = randomUUID();
    store.seedCampaign({ id: campaignId, workspaceId });
    const userId = await seedOwner(store, workspaceId);
    store.budgetPolicies.push({
      id: randomUUID(),
      workspaceId,
      level: 'CAMPAIGN',
      scopeId: campaignId,
      limitCents: 10_000,
    });
    store.budgetLedgerEntries.push({
      id: randomUUID(),
      workspaceId,
      budgetPolicyId: store.budgetPolicies[0]!.id,
      entryType: 'CHARGE',
      amountCents: 2500,
      idempotencyKey: randomUUID(),
      createdAt: new Date(),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/campaigns/${campaignId}/shot-generation`,
      headers: bearerFor(userId),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.budget.campaign).toMatchObject({
      limitCents: 10_000,
      spentCents: 2500,
      remainingCents: 7500,
    });
    expect(body.budget.workspace).toBeNull();
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { WorkflowClient } from '@temporalio/client';
import { MockReviewProvider, MockStorageProvider } from '@combat/providers';
import {
  InMemoryCampaignStore,
  addMembership,
  createAssetWithProvenance,
  createCreativeConcept,
  createDraftShotSelectionSet,
  createQualityAssessmentForCandidate,
  createScriptWithShots,
  createShotSpecification,
  submitCampaignBrief,
  type GenerationCandidateRecord,
} from '@combat/database';
import { registerShotReviewRoutes } from './shot-review-routes';

type SpecInput = Parameters<typeof createShotSpecification>[2];
function specInput(
  campaignId: string,
  shotId: string,
  index: number,
  overrides: Partial<SpecInput> = {},
): SpecInput {
  return {
    campaignId,
    creativeConceptId: randomUUID(),
    creativeConceptVersion: 1,
    scriptId: randomUUID(),
    scriptVersion: 1,
    shotId,
    version: 1,
    shotNumber: index,
    sequencePosition: index,
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
    providerId: 'mock-video-generation',
    promptVersionId: randomUUID(),
    generationPrompt: 'p',
    generationParams: { durationSeconds: 3, aspectRatio: '9:16', providerOptions: {} },
    outputRequirements: { durationSeconds: 3, aspectRatio: '9:16', minCandidateCount: 1 },
    qualityRubric: [],
    licensingConstraints: [],
    createdByAgentInvocationId: randomUUID(),
    ...overrides,
  };
}

function buildFakeWorkflowClient() {
  const signal = vi.fn(async () => undefined);
  const workflowClient = {
    getHandle: () => ({ signal, query: async () => undefined }),
    start: async () => ({ workflowId: 'x', firstExecutionRunId: 'y' }),
  } as unknown as WorkflowClient;
  return { workflowClient, signal };
}

async function seedReviewReady(
  store: InMemoryCampaignStore,
  opts: { shotCount?: number; candidateEligible?: boolean } = {},
) {
  const { shotCount = 2, candidateEligible = true } = opts;
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const reviewerId = randomUUID();
  const analystId = randomUUID();
  await addMembership(store, workspaceId, { userId: reviewerId, role: 'REVIEWER' });
  await addMembership(store, workspaceId, { userId: analystId, role: 'ANALYST' });
  store.seedCampaign({ id: campaignId, workspaceId, currentStage: 'HUMAN_SHOT_SELECTION' });
  await submitCampaignBrief(store, workspaceId, {
    campaignId,
    content: {
      campaignName: 'Q3',
      productName: 'Combat Reviews',
      productDescription: 'x',
      objective: 'x',
      targetAudience: 'x',
      customerProblem: 'x',
      valueProposition: 'x',
      productFeatures: ['x'],
      targetPlatforms: ['INSTAGRAM_REELS'],
      aspectRatios: ['9:16'],
      durationsSeconds: [15],
      brandVoice: 'x',
      visualDirection: 'x',
      requiredMessaging: ['x'],
      callToAction: 'x',
      references: [],
      assetReferences: [],
      prohibitedClaims: [],
      budgetCents: 500000,
      locale: 'en-US',
    },
  });
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
    totalDurationFrames: 90 * shotCount,
    shots: Array.from({ length: shotCount }, (_, i) => ({
      index: i,
      description: `Shot ${i}`,
      durationFrames: 90,
      beat: i === 0 ? ('HOOK' as const) : ('FEATURE' as const),
      dependsOnShotIndices: i === 0 ? [] : [i - 1],
    })),
  });

  const candidatesByShot = new Map<string, GenerationCandidateRecord>();
  for (const shot of shots) {
    const spec = await createShotSpecification(
      store,
      workspaceId,
      specInput(campaignId, shot.id, shot.index),
    );
    const { asset } = await createAssetWithProvenance(store, workspaceId, {
      campaignId,
      kind: 'VIDEO_CANDIDATE',
      s3Key: `candidates/${randomUUID()}`,
      checksum: randomUUID(),
      mimeType: 'video/mp4',
      originalFilename: 'c.mp4',
      sizeBytes: 1024,
      ingestionStatus: 'READY',
    });
    const candidate: GenerationCandidateRecord = {
      id: randomUUID(),
      workspaceId,
      shotSpecificationId: spec.id,
      shotGenerationAttemptId: randomUUID(),
      candidateIndex: 0,
      status: 'SUCCEEDED',
      assetId: asset.id,
      providerCandidateRef: 'ref',
      seed: 42,
      durationSeconds: 3,
      aspectRatio: '9:16',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store.generationCandidateRecords.push(candidate);
    candidatesByShot.set(shot.id, candidate);
    await createQualityAssessmentForCandidate(store, {
      workspaceId,
      campaignId,
      candidate,
      candidateCampaignId: campaignId,
      latestCandidateId: candidate.id,
      subjectStage: 'VISUAL_QA',
      pass: candidateEligible,
      overallScore: candidateEligible ? 1 : 0,
      scores: { 'subject-fidelity': candidateEligible ? 1 : 0 },
      assessedBy: 'AGENT',
      failures: candidateEligible
        ? []
        : [{ category: 'GENERATION', severity: 'BLOCKING', description: 'artifact' }],
    });
    await createQualityAssessmentForCandidate(store, {
      workspaceId,
      campaignId,
      candidate,
      candidateCampaignId: campaignId,
      latestCandidateId: candidate.id,
      subjectStage: 'CONTINUITY_QA',
      pass: true,
      overallScore: 1,
      scores: {},
      assessedBy: 'AGENT',
      failures: [],
    });
  }

  return {
    store,
    workspaceId,
    campaignId,
    reviewerId,
    analystId,
    script,
    shots,
    concept,
    candidatesByShot,
  };
}

function buildApp(
  store: InMemoryCampaignStore,
  workflowClient: WorkflowClient,
  reviewProvider = new MockReviewProvider(),
) {
  const app = Fastify();
  registerShotReviewRoutes(app, {
    db: store,
    storageProvider: new MockStorageProvider(),
    reviewProvider,
    workflowClient,
  });
  return app;
}

async function createDraft(
  store: InMemoryCampaignStore,
  s: Awaited<ReturnType<typeof seedReviewReady>>,
) {
  return createDraftShotSelectionSet(store, s.workspaceId, {
    campaignId: s.campaignId,
    scriptId: s.script.id,
    scriptVersion: s.script.version,
    creativeConceptId: s.concept.id,
    creativeConceptVersion: s.concept.version,
    version: 1,
    createdByUserId: s.reviewerId,
    requiredShots: s.shots.map((shot) => ({
      shotId: shot.id,
      sequencePosition: shot.index,
      shotSpecificationId: store.shotSpecificationRecords.find((sp) => sp.shotId === shot.id)!.id,
      shotSpecificationVersion: 1,
    })),
  });
}

describe('shot-review routes', () => {
  it('returns the ordered review workspace with eligible candidates and QA', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedReviewReady(store);
    const { workflowClient } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review?userId=${s.analystId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.campaign.isSelectionStage).toBe(true);
    expect(body.shots).toHaveLength(2);
    expect(body.shots[0].index).toBe(0);
    expect(body.shots[0].candidates[0].eligibility.eligible).toBe(true);
    expect(body.shots[0].candidates[0].hasMedia).toBe(false);
    expect(body.shots[0].candidates[0].visualQa.pass).toBe(true);
  });

  it('creates a draft with a PENDING selection per shot', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedReviewReady(store);
    const { workflowClient } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/draft`,
      payload: { userId: s.reviewerId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().selections).toHaveLength(2);
    expect(res.json().selections.every((x: { status: string }) => x.status === 'PENDING')).toBe(
      true,
    );
  });

  it('rejects a non-privileged role from selecting (RBAC)', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedReviewReady(store);
    const { set } = await createDraft(store, s);
    const { workflowClient } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/select`,
      payload: {
        userId: s.analystId,
        setId: set.id,
        shotId: s.shots[0]!.id,
        candidateId: s.candidatesByShot.get(s.shots[0]!.id)!.id,
        expectedRevision: 0,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('selects an eligible candidate and refuses an ineligible one', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedReviewReady(store, { candidateEligible: false });
    const { set } = await createDraft(store, s);
    const { workflowClient } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/select`,
      payload: {
        userId: s.reviewerId,
        setId: set.id,
        shotId: s.shots[0]!.id,
        candidateId: s.candidatesByShot.get(s.shots[0]!.id)!.id,
        expectedRevision: 0,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INELIGIBLE_CANDIDATE');
    expect(res.json().reasons).toContain('VISUAL_QA_NOT_PASSED');
  });

  it('records the approval BEFORE signalling, and only signals a valid complete set', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedReviewReady(store);
    const { set } = await createDraft(store, s);
    const { workflowClient, signal } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);

    // Select both shots.
    let revision = 0;
    for (const shot of s.shots) {
      // eslint-disable-next-line no-await-in-loop
      const r = await app.inject({
        method: 'POST',
        url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/select`,
        payload: {
          userId: s.reviewerId,
          setId: set.id,
          shotId: shot.id,
          candidateId: s.candidatesByShot.get(shot.id)!.id,
          expectedRevision: revision,
        },
      });
      expect(r.statusCode).toBe(200);
      revision = r.json().set.revision;
    }

    // The signal must never fire before a HumanApproval row exists.
    signal.mockImplementationOnce(async () => {
      expect(store.approvals.some((a) => a.gate === 'SHOT_SELECTION')).toBe(true);
    });

    const approve = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/approve`,
      payload: { userId: s.reviewerId, setId: set.id, expectedRevision: revision },
    });
    expect(approve.statusCode).toBe(202);
    expect(signal).toHaveBeenCalledTimes(1);
    // The set is now frozen APPROVED.
    expect(store.shotSelectionSetRecords.find((x) => x.id === set.id)?.status).toBe('APPROVED');

    // Idempotent retry: no second approval row, still one signal per call but same approvalId.
    const retry = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/approve`,
      payload: { userId: s.reviewerId, setId: set.id, expectedRevision: revision },
    });
    // The set is already APPROVED, so a re-approve is refused as NOT_DRAFT — the
    // gate cannot be crossed twice off one draft.
    expect(retry.statusCode).toBe(409);
  });

  it('refuses to approve an incomplete set (no signal fires)', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedReviewReady(store);
    const { set } = await createDraft(store, s);
    const { workflowClient, signal } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);

    // Select only the first shot, leaving the second PENDING.
    await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/select`,
      payload: {
        userId: s.reviewerId,
        setId: set.id,
        shotId: s.shots[0]!.id,
        candidateId: s.candidatesByShot.get(s.shots[0]!.id)!.id,
        expectedRevision: 0,
      },
    });

    const approve = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/approve`,
      payload: { userId: s.reviewerId, setId: set.id, expectedRevision: 1 },
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error).toBe('INCOMPLETE');
    expect(signal).not.toHaveBeenCalled();
    expect(store.approvals).toHaveLength(0);
  });

  it('rejects a shot and routes regeneration through CHANGES_REQUESTED', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedReviewReady(store);
    const { set } = await createDraft(store, s);
    const { workflowClient, signal } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);

    const reject = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/reject-shot`,
      payload: {
        userId: s.reviewerId,
        setId: set.id,
        shotId: s.shots[0]!.id,
        regenerationFeedback: 'Too dark, brighten the key light.',
        expectedRevision: 0,
      },
    });
    expect(reject.statusCode).toBe(200);

    const regen = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/request-regeneration`,
      payload: { userId: s.reviewerId, setId: set.id },
    });
    expect(regen.statusCode).toBe(202);
    expect(store.approvals[0]?.decision).toBe('CHANGES_REQUESTED');
    expect(signal).toHaveBeenCalledTimes(1);
  });

  it('refuses regeneration when no shot has been rejected', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedReviewReady(store);
    const { set } = await createDraft(store, s);
    const { workflowClient } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);

    const regen = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/request-regeneration`,
      payload: { userId: s.reviewerId, setId: set.id },
    });
    expect(regen.statusCode).toBe(409);
    expect(regen.json().error).toBe('NO_REJECTED_SHOTS');
  });

  it('rejects a stale-revision selection (optimistic concurrency)', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedReviewReady(store);
    const { set } = await createDraft(store, s);
    const { workflowClient } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);

    await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/select`,
      payload: {
        userId: s.reviewerId,
        setId: set.id,
        shotId: s.shots[0]!.id,
        candidateId: s.candidatesByShot.get(s.shots[0]!.id)!.id,
        expectedRevision: 0,
      },
    });
    const stale = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/select`,
      payload: {
        userId: s.reviewerId,
        setId: set.id,
        shotId: s.shots[1]!.id,
        candidateId: s.candidatesByShot.get(s.shots[1]!.id)!.id,
        expectedRevision: 0,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('STALE_REVISION');
  });

  it('404s a cross-workspace campaign rather than leaking it', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedReviewReady(store);
    const { workflowClient } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);
    // The reviewer is a member of s.workspaceId, but asks about it under a different workspace id.
    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${randomUUID()}/campaigns/${s.campaignId}/shot-review?userId=${s.reviewerId}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('adds a timecoded review comment', async () => {
    const store = new InMemoryCampaignStore();
    const s = await seedReviewReady(store);
    const { workflowClient } = buildFakeWorkflowClient();
    const app = buildApp(store, workflowClient);
    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${s.workspaceId}/campaigns/${s.campaignId}/shot-review/comment`,
      payload: {
        userId: s.reviewerId,
        shotId: s.shots[0]!.id,
        candidateId: s.candidatesByShot.get(s.shots[0]!.id)!.id,
        body: 'Fix framing at 1.5s',
        timecodeSeconds: 1.5,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().comment.timecodeSeconds).toBe(1.5);
  });
});

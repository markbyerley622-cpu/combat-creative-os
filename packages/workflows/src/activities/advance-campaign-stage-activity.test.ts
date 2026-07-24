import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAdvanceCampaignStageActivity } from './advance-campaign-stage-activity';
import { InMemoryTransitionStore } from './test-helpers/in-memory-transition-store';

describe('advanceCampaignStageActivity — AUTO_FORWARD', () => {
  it('advances a non-gated forward edge once its prerequisite fact is true', async () => {
    const store = new InMemoryTransitionStore();
    const campaign = store.seedCampaign({ currentStage: 'DRAFT' });
    store.briefs.push({
      id: randomUUID(),
      campaignId: campaign.id,
      version: 1,
      acceptedAt: new Date(),
    });
    const activity = createAdvanceCampaignStageActivity({ campaignTransitionDb: store });

    const result = await activity({
      mode: 'AUTO_FORWARD',
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      fromStage: 'DRAFT',
      idempotencyKey: randomUUID(),
    });

    expect(result).toEqual({ ok: true, toStage: 'STRATEGY_REVIEW' });
  });

  it('reports MISSING_PREREQUISITE without mutating the campaign when the fact is false', async () => {
    const store = new InMemoryTransitionStore();
    const campaign = store.seedCampaign({ currentStage: 'DRAFT' });
    const activity = createAdvanceCampaignStageActivity({ campaignTransitionDb: store });

    const result = await activity({
      mode: 'AUTO_FORWARD',
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      fromStage: 'DRAFT',
      idempotencyKey: randomUUID(),
    });

    expect(result).toMatchObject({ ok: false, reason: 'MISSING_PREREQUISITE' });
    expect(store.campaigns[0]!.currentStage).toBe('DRAFT');
  });

  it('reports GATE_REQUIRED and never attempts the DB transition for a gated forward edge', async () => {
    const store = new InMemoryTransitionStore();
    const campaign = store.seedCampaign({ currentStage: 'CONCEPT_REVIEW' });
    const activity = createAdvanceCampaignStageActivity({ campaignTransitionDb: store });

    const result = await activity({
      mode: 'AUTO_FORWARD',
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      fromStage: 'CONCEPT_REVIEW',
      idempotencyKey: randomUUID(),
    });

    expect(result).toEqual({
      ok: false,
      reason: 'GATE_REQUIRED',
      gate: 'CONCEPT',
      targetStage: 'SCRIPT_REVIEW',
    });
    expect(store.audits).toHaveLength(0);
  });

  it('reports TERMINAL at the final stage of the lifecycle', async () => {
    const store = new InMemoryTransitionStore();
    const campaign = store.seedCampaign({ currentStage: 'DISTRIBUTED' });
    const activity = createAdvanceCampaignStageActivity({ campaignTransitionDb: store });

    const result = await activity({
      mode: 'AUTO_FORWARD',
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      fromStage: 'DISTRIBUTED',
      idempotencyKey: randomUUID(),
    });

    expect(result).toEqual({ ok: false, reason: 'TERMINAL' });
  });
});

describe('advanceCampaignStageActivity — GATE_DECISION', () => {
  it('advances through the CONCEPT gate once an APPROVED HumanApproval is persisted', async () => {
    const store = new InMemoryTransitionStore();
    const campaign = store.seedCampaign({ currentStage: 'CONCEPT_REVIEW' });
    store.seedApproval({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      gate: 'CONCEPT',
      decision: 'APPROVED',
      stageAtDecision: 'CONCEPT_REVIEW',
      decidedByUserId: randomUUID(),
    });
    const activity = createAdvanceCampaignStageActivity({ campaignTransitionDb: store });

    const result = await activity({
      mode: 'GATE_DECISION',
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      fromStage: 'CONCEPT_REVIEW',
      gate: 'CONCEPT',
      decision: 'APPROVED',
      idempotencyKey: randomUUID(),
    });

    expect(result).toEqual({ ok: true, toStage: 'SCRIPT_REVIEW' });
  });

  it('routes a CHANGES_REQUESTED CONCEPT decision back to STRATEGY_REVIEW', async () => {
    const store = new InMemoryTransitionStore();
    const campaign = store.seedCampaign({ currentStage: 'CONCEPT_REVIEW' });
    store.seedApproval({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      gate: 'CONCEPT',
      decision: 'CHANGES_REQUESTED',
      stageAtDecision: 'CONCEPT_REVIEW',
      decidedByUserId: randomUUID(),
    });
    const activity = createAdvanceCampaignStageActivity({ campaignTransitionDb: store });

    const result = await activity({
      mode: 'GATE_DECISION',
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      fromStage: 'CONCEPT_REVIEW',
      gate: 'CONCEPT',
      decision: 'CHANGES_REQUESTED',
      idempotencyKey: randomUUID(),
    });

    expect(result).toEqual({ ok: true, toStage: 'STRATEGY_REVIEW' });
  });

  it('routes a REJECTED FINAL decision to the human-selected repairTarget', async () => {
    const store = new InMemoryTransitionStore();
    const campaign = store.seedCampaign({ currentStage: 'FINAL_APPROVAL' });
    store.seedApproval({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      gate: 'FINAL',
      decision: 'REJECTED',
      stageAtDecision: 'FINAL_APPROVAL',
      decidedByUserId: randomUUID(),
      repairTarget: 'SOUND_DESIGN',
    });
    const activity = createAdvanceCampaignStageActivity({ campaignTransitionDb: store });

    const result = await activity({
      mode: 'GATE_DECISION',
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      fromStage: 'FINAL_APPROVAL',
      gate: 'FINAL',
      decision: 'REJECTED',
      repairTarget: 'SOUND_DESIGN',
      idempotencyKey: randomUUID(),
    });

    expect(result).toEqual({ ok: true, toStage: 'SOUND_DESIGN' });
  });

  it('rejects an APPROVED decision at a gate that does not match the current stage forward edge', async () => {
    const store = new InMemoryTransitionStore();
    const campaign = store.seedCampaign({ currentStage: 'CONCEPT_REVIEW' });
    const activity = createAdvanceCampaignStageActivity({ campaignTransitionDb: store });

    const result = await activity({
      mode: 'GATE_DECISION',
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      fromStage: 'CONCEPT_REVIEW',
      gate: 'FINAL',
      decision: 'APPROVED',
      idempotencyKey: randomUUID(),
    });

    expect(result).toMatchObject({ ok: false, reason: 'NO_MATCHING_TRANSITION' });
  });

  it('is idempotent: a retried call with the same idempotencyKey does not double-transition', async () => {
    const store = new InMemoryTransitionStore();
    const campaign = store.seedCampaign({ currentStage: 'CONCEPT_REVIEW' });
    store.seedApproval({
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      gate: 'CONCEPT',
      decision: 'APPROVED',
      stageAtDecision: 'CONCEPT_REVIEW',
      decidedByUserId: randomUUID(),
    });
    const activity = createAdvanceCampaignStageActivity({ campaignTransitionDb: store });
    const idempotencyKey = randomUUID();
    const input = {
      mode: 'GATE_DECISION' as const,
      workspaceId: campaign.workspaceId,
      campaignId: campaign.id,
      fromStage: 'CONCEPT_REVIEW' as const,
      gate: 'CONCEPT' as const,
      decision: 'APPROVED' as const,
      idempotencyKey,
    };

    const first = await activity(input);
    const second = await activity(input);

    expect(first).toEqual({ ok: true, toStage: 'SCRIPT_REVIEW' });
    expect(second).toEqual({ ok: true, toStage: 'SCRIPT_REVIEW' });
    expect(store.audits).toHaveLength(1);
    expect(store.campaigns[0]!.version).toBe(1);
  });
});

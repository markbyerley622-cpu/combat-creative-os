import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CampaignProductionWorkflowInputSchema,
  GateApprovalSignalPayloadSchema,
} from './campaign-production-workflow-contracts';

function buildPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    approvalId: randomUUID(),
    workspaceId: randomUUID(),
    campaignId: randomUUID(),
    gate: 'CONCEPT',
    decision: 'APPROVED',
    decidedByUserId: randomUUID(),
    ...overrides,
  };
}

describe('CampaignProductionWorkflowInputSchema', () => {
  it('defaults initialStage to DRAFT and maxRevisionsPerGate to 3', () => {
    const parsed = CampaignProductionWorkflowInputSchema.parse({
      workspaceId: randomUUID(),
      campaignId: randomUUID(),
      workflowRunId: 'run-1',
    });
    expect(parsed.initialStage).toBe('DRAFT');
    expect(parsed.maxRevisionsPerGate).toBe(3);
  });

  it('rejects a non-UUID workspaceId', () => {
    expect(() =>
      CampaignProductionWorkflowInputSchema.parse({
        workspaceId: 'not-a-uuid',
        campaignId: randomUUID(),
        workflowRunId: 'run-1',
      }),
    ).toThrow();
  });
});

describe('GateApprovalSignalPayloadSchema', () => {
  it('accepts an APPROVED decision at any gate with no repairTarget', () => {
    expect(() => GateApprovalSignalPayloadSchema.parse(buildPayload())).not.toThrow();
  });

  it('rejects a non-approved FINAL decision missing a repairTarget', () => {
    expect(() =>
      GateApprovalSignalPayloadSchema.parse(buildPayload({ gate: 'FINAL', decision: 'REJECTED' })),
    ).toThrow();
  });

  it('accepts a non-approved FINAL decision with a valid repairTarget', () => {
    expect(() =>
      GateApprovalSignalPayloadSchema.parse(
        buildPayload({ gate: 'FINAL', decision: 'REJECTED', repairTarget: 'ROUGH_CUT' }),
      ),
    ).not.toThrow();
  });

  it('rejects a repairTarget supplied for a non-FINAL gate', () => {
    expect(() =>
      GateApprovalSignalPayloadSchema.parse(
        buildPayload({ gate: 'CONCEPT', decision: 'REJECTED', repairTarget: 'ROUGH_CUT' }),
      ),
    ).toThrow();
  });

  it('rejects an invalid decision enum value', () => {
    expect(() =>
      GateApprovalSignalPayloadSchema.parse(buildPayload({ decision: 'MAYBE' })),
    ).toThrow();
  });
});

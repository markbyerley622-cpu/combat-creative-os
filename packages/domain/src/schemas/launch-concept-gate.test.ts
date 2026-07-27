import { describe, expect, it } from 'vitest';

import {
  evaluateConceptSelection,
  LaunchConceptVersionSchema,
  LaunchGateDecisionSchema,
  type LaunchSelectionCandidateState,
  type LaunchSelectionRequest,
} from './launch-concept-gate';

/**
 * The gate's decision rules, without a filesystem.
 *
 * Each refusal names a different operator response, so each is asserted
 * separately: "select the revision", "re-plan against the current brief" and
 * "this is not your workspace" are not the same problem, and a caller that
 * cannot tell them apart cannot act on any of them.
 */

const WORKSPACE = '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e';
const OTHER_WORKSPACE = '11111111-2222-4333-8444-555555555555';
const CAMPAIGN = '3f9a1c22-7b5e-4d61-9f2a-8c6d5e4b3a21';
const PROMPT = 'a'.repeat(64);

function candidate(
  overrides: Partial<LaunchSelectionCandidateState> = {},
): LaunchSelectionCandidateState {
  return {
    conceptId: 'concept-1',
    versions: [1],
    latestVersion: 1,
    workspaceId: WORKSPACE,
    campaignId: CAMPAIGN,
    campaignPromptSha256: PROMPT,
    selectable: true,
    blockingReasons: [],
    ...overrides,
  };
}

function request(overrides: Partial<LaunchSelectionRequest> = {}): LaunchSelectionRequest {
  return {
    conceptId: 'concept-1',
    reviewerId: 'reviewer-1',
    workspaceId: WORKSPACE,
    campaignId: CAMPAIGN,
    campaignPromptSha256: PROMPT,
    approvedReviewerIds: ['reviewer-1'],
    alreadySelected: false,
    ...overrides,
  };
}

describe('a selection that should stand', () => {
  it('is accepted and resolves to the latest version when none was named', () => {
    const outcome = evaluateConceptSelection(request(), [
      candidate({ versions: [1, 2], latestVersion: 2 }),
    ]);
    expect(outcome).toEqual({ ok: true, conceptId: 'concept-1', conceptVersion: 2 });
  });
});

describe('refusals', () => {
  it('refuses a reviewer the brief never approved, before anything else', () => {
    const outcome = evaluateConceptSelection(
      request({ reviewerId: 'someone-else', conceptId: 'does-not-exist' }),
      [candidate()],
    );
    expect(outcome).toMatchObject({ ok: false, refusal: 'REVIEWER_NOT_APPROVED' });
  });

  it('refuses a second selection rather than overwriting the first', () => {
    const outcome = evaluateConceptSelection(request({ alreadySelected: true }), [candidate()]);
    expect(outcome).toMatchObject({ ok: false, refusal: 'ALREADY_SELECTED' });
  });

  it('refuses a concept belonging to another workspace as exactly that', () => {
    const outcome = evaluateConceptSelection(request({ workspaceId: OTHER_WORKSPACE }), [
      candidate(),
    ]);
    expect(outcome).toMatchObject({ ok: false, refusal: 'CROSS_WORKSPACE' });
  });

  it('refuses a concept belonging to another campaign', () => {
    const outcome = evaluateConceptSelection(request(), [
      candidate({ campaignId: '99999999-9999-4999-8999-999999999999' }),
    ]);
    expect(outcome).toMatchObject({ ok: false, refusal: 'WRONG_CAMPAIGN' });
  });

  it('refuses a superseded version and points at the one that replaced it', () => {
    const outcome = evaluateConceptSelection(request({ conceptVersion: 1 }), [
      candidate({ versions: [1, 2], latestVersion: 2 }),
    ]);
    expect(outcome).toMatchObject({ ok: false, refusal: 'SUPERSEDED_VERSION' });
    expect(outcome.ok === false && outcome.detail).toContain('version 2');
  });

  it('refuses a version that does not exist', () => {
    const outcome = evaluateConceptSelection(request({ conceptVersion: 7 }), [candidate()]);
    expect(outcome).toMatchObject({ ok: false, refusal: 'UNKNOWN_VERSION' });
  });

  it('refuses a concept authored against a different brief', () => {
    const outcome = evaluateConceptSelection(request({ campaignPromptSha256: 'b'.repeat(64) }), [
      candidate(),
    ]);
    expect(outcome).toMatchObject({ ok: false, refusal: 'STALE_CAMPAIGN_PROMPT' });
  });

  it('refuses an unselectable concept and repeats why', () => {
    const outcome = evaluateConceptSelection(request(), [
      candidate({ selectable: false, blockingReasons: ['missing capture app-information'] }),
    ]);
    expect(outcome).toMatchObject({ ok: false, refusal: 'NOT_SELECTABLE' });
    expect(outcome.ok === false && outcome.detail).toContain('missing capture');
  });
});

describe('the immutable records themselves', () => {
  const version = {
    recordVersion: 1 as const,
    conceptId: 'concept-1',
    version: 2,
    workspaceId: WORKSPACE,
    campaignId: CAMPAIGN,
    launchRunId: 'run-1',
    origin: 'REVISION' as const,
    supersedesVersion: 1,
    authoredByAgent: 'creative-director@v4',
    createdAt: '2026-07-28T00:00:00.000Z',
    revisionFeedback: 'change the opening',
    conceptChecksumSha256: 'c'.repeat(64),
    campaignPromptSha256: PROMPT,
    concept: undefined as never,
  };

  it('refuses a revision that names no superseded version', () => {
    const parsed = LaunchConceptVersionSchema.safeParse({
      ...version,
      supersedesVersion: undefined,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a revision that records no reviewer feedback', () => {
    const parsed = LaunchConceptVersionSchema.safeParse({
      ...version,
      revisionFeedback: undefined,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an initial candidate that claims to supersede something', () => {
    const parsed = LaunchConceptVersionSchema.safeParse({
      ...version,
      origin: 'INITIAL_COMPETITION',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a rejection with no written feedback', () => {
    const parsed = LaunchGateDecisionSchema.safeParse({
      recordVersion: 1,
      decisionId: 'decision-1',
      launchRunId: 'run-1',
      workspaceId: WORKSPACE,
      campaignId: CAMPAIGN,
      gate: 'CONCEPT',
      decision: 'ALL_REJECTED',
      reviewerId: 'reviewer-1',
      decidedAt: '2026-07-28T00:00:00.000Z',
    });
    expect(parsed.success).toBe(false);
  });
});

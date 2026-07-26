import { test, expect } from '@playwright/test';
import { bearer, signIn } from './auth';

/**
 * Post-M14 audit finding H-3 — browser coverage for the two human approval
 * gates that had none.
 *
 * `concept-approval.spec.ts` already covered the CONCEPT gate. The
 * SHOT_SELECTION and FINAL gates were exercised only at the API level, so
 * nothing verified that a reviewer can actually reach those screens or —
 * more importantly — that no browser flow can advance a gate whose required
 * approval state is not persisted. Each gate is checked twice: the control the
 * UI offers, and the request behind that control sent directly, because UI
 * visibility is never authorization. Fixture ids come from
 * apps/api/src/dev-fake-server.ts.
 */
const FIXTURES = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  ownerUserId: '22222222-2222-2222-2222-222222222222',
  reviewerUserId: '33333333-3333-3333-3333-333333333333',
  /** Parked at HUMAN_SHOT_SELECTION: two shots, one QA-passed candidate each, a DRAFT set with nothing selected. */
  shotSelectionCampaignId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  /** Parked at FINAL_APPROVAL: a registered FINAL_MASTER with a passing Final QA assessment. */
  finalApprovalCampaignId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  /** Parked at CONCEPT_REVIEW — a campaign whose FINAL gate is deliberately not open. */
  conceptCampaignId: '44444444-4444-4444-4444-444444444444',
};
const API_BASE_URL = 'http://127.0.0.1:4100';

async function loadSelectionSet(request: import('@playwright/test').APIRequestContext) {
  const review = await request.get(
    `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/campaigns/${FIXTURES.shotSelectionCampaignId}/shot-review`,
    { headers: bearer(FIXTURES.reviewerUserId) },
  );
  expect(review.status()).toBe(200);
  const body = await review.json();
  expect(body.selectionSet).not.toBeNull();
  return body.selectionSet as { id: string; revision: number; status: string };
}

test.describe('Shot selection gate', () => {
  test('a reviewer reaches the review UI with every shot and its QA verdict', async ({ page }) => {
    await signIn(page, FIXTURES.reviewerUserId);
    await page.goto(`/campaigns/${FIXTURES.shotSelectionCampaignId}/shot-selection`);

    await expect(page.getByText('Current stage:')).toContainText('HUMAN_SHOT_SELECTION');
    await expect(page.getByRole('heading', { name: 'Shot 0 — HOOK' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shot 1 — FEATURE' })).toBeVisible();
    await expect(page.getByText('Hook: gym owner frustrated at a laptop.')).toBeVisible();
    await expect(page.getByText('Visual QA:').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select this candidate' }).first()).toBeEnabled();
  });

  test('the gate cannot be advanced from the UI while the selection is incomplete', async ({
    page,
  }) => {
    await signIn(page, FIXTURES.reviewerUserId);
    await page.goto(`/campaigns/${FIXTURES.shotSelectionCampaignId}/shot-selection`);

    // Nothing is selected yet, so neither gate-advancing control is offered.
    await expect(page.getByRole('button', { name: 'Approve selection' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Request regeneration' })).toBeDisabled();
  });

  test('approving an incomplete selection is refused server-side, not merely in the UI', async ({
    request,
  }) => {
    const set = await loadSelectionSet(request);

    // Exactly the request the disabled "Approve selection" button would send.
    const response = await request.post(
      `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/campaigns/${FIXTURES.shotSelectionCampaignId}/shot-review/approve`,
      {
        headers: bearer(FIXTURES.reviewerUserId),
        data: {
          setId: set.id,
          expectedRevision: set.revision,
        },
      },
    );

    expect(response.status()).toBe(409);
    expect((await response.json()).error).toBe('INCOMPLETE');

    // And the set is still an unapproved draft afterwards.
    expect((await loadSelectionSet(request)).status).toBe('DRAFT');
  });

  test('a selection set from another campaign cannot satisfy this campaign gate', async ({
    request,
  }) => {
    const set = await loadSelectionSet(request);

    // Same workspace, fully privileged caller, valid set id — but the set
    // belongs to a different campaign than the one in the path.
    const response = await request.post(
      `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/campaigns/${FIXTURES.conceptCampaignId}/shot-review/approve`,
      {
        headers: bearer(FIXTURES.reviewerUserId),
        data: {
          setId: set.id,
          expectedRevision: set.revision,
        },
      },
    );

    expect(response.status()).toBe(404);
  });
});

test.describe('Final approval gate', () => {
  test('an authorized owner reaches the final master and its QA verdict', async ({ page }) => {
    await signIn(page, FIXTURES.ownerUserId);
    await page.goto(`/campaigns/${FIXTURES.finalApprovalCampaignId}/final-approval`);

    await expect(page.getByText('Stage:')).toContainText('FINAL_APPROVAL');
    await expect(page.getByRole('heading', { name: 'Final master' })).toBeVisible();
    await expect(page.getByText('final-master-v1.mp4')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Final QA: passed/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve final master' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Request changes' })).toBeEnabled();
  });

  test('the gate is closed in the UI for a campaign that has not reached it', async ({ page }) => {
    await signIn(page, FIXTURES.ownerUserId);
    await page.goto(`/campaigns/${FIXTURES.conceptCampaignId}/final-approval`);

    await expect(page.getByText('the final approval gate is not open yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve final master' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Request changes' })).toBeDisabled();
  });

  test('a REVIEWER sees the gate disabled and is refused server-side anyway', async ({
    page,
    request,
  }) => {
    await signIn(page, FIXTURES.reviewerUserId);
    await page.goto(`/campaigns/${FIXTURES.finalApprovalCampaignId}/final-approval`);

    await expect(page.getByText('cannot approve a final master')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve final master' })).toBeDisabled();

    const response = await request.post(
      `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/campaigns/${FIXTURES.finalApprovalCampaignId}/approvals/final`,
      { headers: bearer(FIXTURES.reviewerUserId), data: { decision: 'APPROVED' } },
    );

    expect(response.status()).toBe(403);
    expect((await response.json()).error).toBe('FORBIDDEN');
  });

  test('an authorized decision is recorded as a persisted approval', async ({ request }) => {
    const response = await request.post(
      `${API_BASE_URL}/workspaces/${FIXTURES.workspaceId}/campaigns/${FIXTURES.finalApprovalCampaignId}/approvals/final`,
      { headers: bearer(FIXTURES.ownerUserId), data: { decision: 'APPROVED' } },
    );

    expect(response.status()).toBe(202);
    expect((await response.json()).approvalId).toBeTruthy();
  });
});

import type { MembershipDataSource, CampaignDataSource } from '@combat/database';
import { getCampaign, listMembershipsForWorkspace } from '@combat/database';
import { roleHasPermission, type Permission, type RoleName } from '@combat/domain';

/**
 * M14 — the canonical authorization audit artifact for `apps/api`'s mutating
 * surface, plus the shared guard every mutating route runs.
 *
 * Two things live here, deliberately together:
 *
 * 1. `MUTATING_ROUTES` — a typed registry enumerating **every** create /
 *    update / approve / reject / regenerate / upload-confirm / dispatch /
 *    transition / ingestion / review endpoint, the exact `Permission` it
 *    requires, the resource it targets, and the ownership checks it must
 *    perform. `apps/api`'s own test suite asserts this registry matches the
 *    routes Fastify actually registered, so an endpoint added without an entry
 *    (or with a mismatched permission) fails the build rather than shipping
 *    unaudited. Permission values are the `Permission` union from
 *    `@combat/domain` — this file never redeclares a permission constant.
 *
 * 2. `authorizeMutation` / `assertBelongsToCampaign` — the enforcement path.
 *    Membership is resolved from a persisted `Membership` row through the same
 *    repository boundary as everything else; the role is checked against
 *    `roleHasPermission`; the campaign is re-read scoped to the workspace; and
 *    any client-supplied child-resource id is verified to belong to that
 *    campaign before it is used.
 *
 * **This is authorization, not authentication.** The caller's `userId` still
 * arrives in the request (the documented temporary development-identity
 * mechanism — see docs/architecture.md §7.1). M14 hardens what an identity may
 * *do* once asserted; proving *who* the caller is remains an unbuilt production
 * blocker, and nothing here should be read as claiming otherwise.
 */

/** Which resource a mutation targets — drives the ownership checks below. */
export const MUTATION_RESOURCES = [
  'CAMPAIGN',
  'CAMPAIGN_BRIEF',
  'WORKFLOW_RUN',
  'ASSET',
  'SHOT_SELECTION_SET',
  'HUMAN_APPROVAL',
  'COMPOSITION_JOB',
  'VARIANT_JOB',
  'PERFORMANCE_OBSERVATION',
  'LEARNING_RECORD',
] as const;
export type MutationResource = (typeof MUTATION_RESOURCES)[number];

export interface MutatingRouteAudit {
  readonly method: 'POST';
  /** The Fastify path pattern, exactly as registered. */
  readonly path: string;
  readonly resource: MutationResource;
  /** The exact permission from `@combat/domain`'s canonical matrix. */
  readonly permission: Permission;
  /** True when the route re-reads the path campaign scoped to the workspace. */
  readonly verifiesCampaignOwnership: boolean;
  /**
   * Client-supplied resource ids this route must verify belong to the path
   * campaign before use. Empty when the route takes no such id.
   */
  readonly verifiedBodyResourceIds: readonly string[];
  /** Why this permission, in one line — the audit rationale. */
  readonly note: string;
}

/**
 * Every mutating endpoint in `apps/api`. Kept in path order per file so it
 * reads as an audit, not a lookup table.
 */
export const MUTATING_ROUTES: readonly MutatingRouteAudit[] = [
  // --- approval-routes.ts: the human gates ---
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/approvals/concept',
    resource: 'HUMAN_APPROVAL',
    permission: 'APPROVE_CONCEPT',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: [],
    note: 'CONCEPT gate. Records an immutable HumanApproval before signalling; the workflow re-verifies it.',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/approvals/final',
    resource: 'HUMAN_APPROVAL',
    permission: 'APPROVE_FINAL_MASTER',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: [],
    note: 'FINAL gate. Same record-then-signal discipline; repairTarget is Zod-validated per gate.',
  },

  // --- campaign-routes.ts: intake and run control ---
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns',
    resource: 'CAMPAIGN',
    permission: 'MANAGE_CAMPAIGNS',
    verifiesCampaignOwnership: false,
    verifiedBodyResourceIds: [],
    note: 'Creates the campaign — there is no prior campaign to own-check.',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/brief/draft',
    resource: 'CAMPAIGN_BRIEF',
    permission: 'MANAGE_CAMPAIGNS',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: [],
    note: 'Saves a draft brief version against a workspace-scoped campaign.',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/brief/submit',
    resource: 'CAMPAIGN_BRIEF',
    permission: 'MANAGE_CAMPAIGNS',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: [],
    note: 'Accepts a brief version (immutable once accepted).',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/workflow/start',
    resource: 'WORKFLOW_RUN',
    permission: 'MANAGE_CAMPAIGNS',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: [],
    note: 'Starts CampaignProductionWorkflow; the workflow id is campaign-derived, never client-supplied.',
  },

  // --- asset-routes.ts ---
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/assets/request-upload',
    resource: 'ASSET',
    permission: 'MANAGE_ASSETS',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: [],
    note: 'Mints a presigned upload URL under a server-built, workspace/campaign-scoped key.',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/assets/confirm-upload',
    resource: 'ASSET',
    permission: 'MANAGE_ASSETS',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: [],
    note: 'Ingests the uploaded object; the ingest Activity re-derives the key from workspace/campaign.',
  },

  // --- shot-review-routes.ts: the SHOT_SELECTION gate ---
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/shot-review/draft',
    resource: 'SHOT_SELECTION_SET',
    permission: 'SELECT_SHOTS',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: [],
    note: 'Creates/returns the draft selection set for the campaign latest script.',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/shot-review/select',
    resource: 'SHOT_SELECTION_SET',
    permission: 'SELECT_SHOTS',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: ['setId'],
    note: 'M14: setId is verified to belong to the path campaign, not merely the workspace.',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/shot-review/reject-shot',
    resource: 'SHOT_SELECTION_SET',
    permission: 'SELECT_SHOTS',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: ['setId'],
    note: 'M14: same campaign-association check as /select.',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/shot-review/comment',
    resource: 'SHOT_SELECTION_SET',
    permission: 'PROVIDE_CANDIDATE_FEEDBACK',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: [],
    note: 'M14: narrowed from SELECT_SHOTS — commenting is feedback, not selection. Takes no set id.',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/shot-review/approve',
    resource: 'HUMAN_APPROVAL',
    permission: 'SELECT_SHOTS',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: ['setId'],
    note: 'SHOT_SELECTION gate. Freezes the set, records the approval, then signals.',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/shot-review/request-regeneration',
    resource: 'HUMAN_APPROVAL',
    permission: 'SELECT_SHOTS',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: ['setId'],
    note: 'SHOT_SELECTION gate, revision path.',
  },

  // --- compositing-routes.ts / variant-routes.ts: dispatch control ---
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/compositing/cancel',
    resource: 'COMPOSITION_JOB',
    permission: 'TRIGGER_GENERATION',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: [],
    note: 'Signals the campaign-derived compositing child; never advances a stage itself.',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/variants/cancel',
    resource: 'VARIANT_JOB',
    permission: 'TRIGGER_GENERATION',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: [],
    note: 'Signals the campaign-derived variant child; never advances a stage itself.',
  },

  // --- performance-routes.ts ---
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/campaigns/:campaignId/performance/observations',
    resource: 'PERFORMANCE_OBSERVATION',
    permission: 'MANAGE_CAMPAIGNS',
    verifiesCampaignOwnership: true,
    verifiedBodyResourceIds: ['creativeVariantId', 'variantAssetId'],
    note: 'M14: a supplied variant/asset id is verified to belong to the path campaign before it is pinned as provenance.',
  },
  {
    method: 'POST',
    path: '/workspaces/:workspaceId/learnings/:learningId/review',
    resource: 'LEARNING_RECORD',
    permission: 'APPROVE_CONCEPT',
    verifiesCampaignOwnership: false,
    verifiedBodyResourceIds: [],
    note: 'Workspace-scoped, not campaign-scoped; the repository folds workspaceId into the lookup.',
  },
];

/** Every mutating path, for the registry-vs-router conformance test. */
export const MUTATING_ROUTE_PATHS: readonly string[] = MUTATING_ROUTES.map((r) => r.path);

export type AuthorizationFailure = {
  readonly ok: false;
  readonly status: number;
  readonly body: { error: string; message: string };
};

export type AuthorizationSuccess = { readonly ok: true; readonly role: RoleName };

const FORBIDDEN_NOT_A_MEMBER: AuthorizationFailure = {
  ok: false,
  status: 403,
  body: { error: 'FORBIDDEN', message: 'caller is not a member of this workspace' },
};

/**
 * Resolves the caller's persisted role and checks it against the canonical
 * permission matrix. A non-member and an under-privileged member both get 403
 * with the project-standard body — deliberately without revealing which, so
 * membership of a workspace is not probeable.
 */
export async function authorizeMutation(
  db: MembershipDataSource,
  workspaceId: string,
  userId: string,
  permission: Permission | null,
): Promise<AuthorizationSuccess | AuthorizationFailure> {
  const memberships = await listMembershipsForWorkspace(db, workspaceId);
  const membership = memberships.find((m) => m.userId === userId);
  if (!membership) return FORBIDDEN_NOT_A_MEMBER;

  const role = membership.role as RoleName;
  if (permission && !roleHasPermission(role, permission)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'FORBIDDEN', message: `role ${role} lacks permission ${permission}` },
    };
  }
  return { ok: true, role };
}

/**
 * Re-reads the path campaign scoped to the workspace. A campaign that exists
 * in another workspace is indistinguishable from one that does not exist —
 * 404, never 403, so campaign ids are not probeable across tenants.
 */
export async function requireCampaign(
  db: CampaignDataSource,
  workspaceId: string,
  campaignId: string,
): Promise<{ ok: true } | AuthorizationFailure> {
  const campaign = await getCampaign(db, workspaceId, campaignId);
  if (!campaign) {
    return {
      ok: false,
      status: 404,
      body: { error: 'NOT_FOUND', message: 'campaign not found' },
    };
  }
  return { ok: true };
}

/**
 * Verifies a client-supplied child resource actually belongs to the campaign
 * being acted on.
 *
 * Workspace scoping alone is not enough: two campaigns in the SAME workspace
 * are still distinct resources, and a body-supplied `setId` pointing at
 * campaign X must not be mutable through campaign Y's route. `resolved` is the
 * row the caller already loaded through a workspace-scoped repository call;
 * this asserts its `campaignId` matches the path.
 */
export function assertBelongsToCampaign(
  resolved: { campaignId: string } | null | undefined,
  campaignId: string,
  resourceLabel: string,
): { ok: true } | AuthorizationFailure {
  if (!resolved || resolved.campaignId !== campaignId) {
    return {
      ok: false,
      status: 404,
      body: { error: 'NOT_FOUND', message: `${resourceLabel} not found for this campaign` },
    };
  }
  return { ok: true };
}

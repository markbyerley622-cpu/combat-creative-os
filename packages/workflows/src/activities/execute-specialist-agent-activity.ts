import type { AgentDefinition, AgentRun } from '@combat/agent-runtime';
import { computeCost, executeAgent, redact, stableHash, toAgentFailure } from '@combat/agent-runtime';
import type {
  AgentInvocationDataSource,
  AgentInvocationRecord,
  BudgetDataSource,
  CampaignDataSource,
} from '@combat/database';
import {
  chargeBudget,
  checkAndReserveBudget,
  findAgentInvocationByIdempotencyKey,
  recordAgentInvocation,
  releaseBudget,
} from '@combat/database';
import type {
  AgentInput,
  AgentInvocationFailure,
  AgentInvocationFailureReason,
  CampaignStage,
  ExecuteSpecialistAgentInput,
  ExecuteSpecialistAgentOutput,
} from '@combat/domain';
import { ExecuteSpecialistAgentInputSchema } from '@combat/domain';
import type { Logger } from '@combat/observability';
import type { ReasoningProvider } from '@combat/providers';

/**
 * Thrown for request-shape problems this Activity refuses to run at all —
 * never persisted as an `AgentInvocation` (requirement 6's persisted-outcome
 * list is deliberately narrower than "every rejection"; ownership and stage
 * mismatches are orchestrator bugs, not expected business outcomes worth an
 * audit row referencing a campaign/workspace pairing that doesn't actually
 * hold). A real Temporal worker should wrap these as
 * `ApplicationFailure.nonRetryable` when registering this function — that
 * wiring belongs to `apps/worker`, out of this milestone's scope.
 */
export class CampaignNotFoundError extends Error {
  constructor(workspaceId: string, campaignId: string) {
    super(`Campaign ${campaignId} not found in workspace ${workspaceId}`);
    this.name = 'CampaignNotFoundError';
  }
}

export class CampaignStageMismatchError extends Error {
  constructor(campaignId: string, expected: CampaignStage, actual: CampaignStage) {
    super(
      `Campaign ${campaignId} is at stage ${actual}, but this invocation was requested for stage ${expected}`,
    );
    this.name = 'CampaignStageMismatchError';
  }
}

export interface ExecuteSpecialistAgentActivityDeps {
  /** Resolved exclusively through `@combat/agents`'s canonical registry in production (requirement 3) — injected here for DI/testability. */
  readonly agentRegistry: Readonly<Record<string, AgentDefinition<unknown, unknown>>>;
  readonly reasoningProvider: ReasoningProvider;
  readonly campaignDb: CampaignDataSource;
  readonly agentInvocationDb: AgentInvocationDataSource;
  readonly budgetDb: BudgetDataSource;
  readonly logger?: Logger;
  /** Overridable for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number;
  /** Overridable for asserting provenance in tests. Defaults to a constant 1 — a real Temporal worker's activity-registration wiring is expected to supply Temporal's own attempt counter here. */
  readonly getAttempt?: () => number;
}

const BUDGET_GATED_LEVELS = ['WORKSPACE', 'CAMPAIGN', 'PROVIDER'] as const;

interface BudgetReservation {
  readonly policyId: string;
}

function microCentsToCents(microCents: number): number {
  return Math.ceil(microCents / 1_000_000);
}

function toOutput(record: AgentInvocationRecord, replayed: boolean): ExecuteSpecialistAgentOutput {
  return {
    invocationId: record.idempotencyKey,
    agentName: record.agentName,
    agentVersion: record.agentVersion,
    status: record.status,
    result: record.result ?? null,
    failure:
      record.failureReason !== undefined
        ? {
            reason: record.failureReason as AgentInvocationFailureReason,
            retryable: record.failureRetryable ?? false,
            message: record.failureMessage ?? '',
            details: record.failureDetails,
          }
        : null,
    modelMeta:
      record.model !== undefined
        ? {
            model: record.model,
            promptVersion: record.promptVersion ?? 0,
            tokensIn: record.tokensIn ?? 0,
            tokensOut: record.tokensOut ?? 0,
            latencyMs: record.completedAt.getTime() - record.startedAt.getTime(),
          }
        : null,
    costCents: record.costCents ?? null,
    inputHash: record.inputHash,
    outputHash: record.outputHash ?? null,
    correlationId: record.correlationId,
    causationId: record.causationId,
    idempotencyKey: record.idempotencyKey,
    attempt: record.attempt,
    startedAt: record.startedAt.toISOString(),
    completedAt: record.completedAt.toISOString(),
    replayed,
  };
}

/**
 * The Temporal Activity boundary for specialist-agent execution (ADR-0004).
 * Every dependency is injected (requirement 10) so this is testable with no
 * live Postgres, Temporal, or reasoning-provider credentials — the default
 * production wiring (a future `apps/worker` concern) points `agentRegistry`
 * at `@combat/agents`'s `AGENT_REGISTRY`, `reasoningProvider` at whichever
 * provider `REASONING_PROVIDER` selects, and the DB sources at a real Prisma
 * client.
 */
export function createExecuteSpecialistAgentActivity(
  deps: ExecuteSpecialistAgentActivityDeps,
): (input: ExecuteSpecialistAgentInput) => Promise<ExecuteSpecialistAgentOutput> {
  const now = deps.now ?? Date.now;
  const getAttempt = deps.getAttempt ?? (() => 1);

  async function releaseReservations(
    reservations: readonly BudgetReservation[],
    workspaceId: string,
    campaignId: string,
    amountCents: number,
    idempotencyKey: string,
  ): Promise<void> {
    for (const reservation of reservations) {
      await releaseBudget(deps.budgetDb, reservation.policyId, workspaceId, {
        amountCents,
        idempotencyKey: `${idempotencyKey}:release`,
        campaignId,
      });
    }
  }

  async function persistFailure(
    input: ExecuteSpecialistAgentInput,
    failure: AgentInvocationFailure,
    resolvedPromptVersion?: number,
  ): Promise<ExecuteSpecialistAgentOutput> {
    const timestamp = new Date(now());
    const record = await recordAgentInvocation(deps.agentInvocationDb, {
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      workflowRunId: input.workflowRunId,
      stage: input.stage,
      agentName: input.agentName,
      agentVersion: input.agentVersion,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      causationId: input.causationId,
      status: 'FAILED',
      failureReason: failure.reason,
      failureRetryable: failure.retryable,
      failureMessage: failure.message,
      // Never persist a failure's raw `details` — it may originate from a
      // provider error object carrying request/response data (CLAUDE.md: "No
      // secret, API key, or token is ever hardcoded or committed").
      failureDetails: redact(failure.details),
      promptVersion: resolvedPromptVersion,
      // Rejections that never reach `executeAgent` have no agent-runtime-
      // computed inputHash — derive one from the request itself (reusing
      // agent-runtime's own stableHash, not a second hashing scheme) so the
      // column is never null.
      inputHash: stableHash(input.payload ?? null),
      attempt: getAttempt(),
      startedAt: timestamp,
      completedAt: timestamp,
    });
    return toOutput(record, false);
  }

  return async function executeSpecialistAgentActivity(
    rawInput: ExecuteSpecialistAgentInput,
  ): Promise<ExecuteSpecialistAgentOutput> {
    const input = ExecuteSpecialistAgentInputSchema.parse(rawInput);
    const { workspaceId, campaignId, idempotencyKey } = input;

    // 1. Idempotency check — first, before any ownership/budget/provider
    // work, so an Activity retry that already produced a terminal result
    // never re-invokes the reasoning provider (requirements 4, 8, 9).
    const existing = await findAgentInvocationByIdempotencyKey(
      deps.agentInvocationDb,
      campaignId,
      idempotencyKey,
    );
    if (existing) {
      return toOutput(existing, true);
    }

    // 2. Ownership + stage verification — see CampaignNotFoundError /
    // CampaignStageMismatchError doc comments for why these throw instead of
    // persisting a rejection row.
    const campaign = await deps.campaignDb.campaign.findFirst({
      where: { id: campaignId, workspaceId },
    });
    if (!campaign) {
      throw new CampaignNotFoundError(workspaceId, campaignId);
    }
    if (campaign.currentStage !== input.stage) {
      throw new CampaignStageMismatchError(campaignId, input.stage, campaign.currentStage);
    }

    // 3. Resolve the agent exclusively through the injected registry
    // (requirement 3) — an unknown name fails before any provider call, and
    // is persisted per requirement 6.
    const definition = deps.agentRegistry[input.agentName];
    if (!definition) {
      return persistFailure(input, {
        reason: 'AGENT_NOT_FOUND',
        retryable: false,
        message: `Agent "${input.agentName}" is not registered in the canonical agent registry.`,
      });
    }

    // 4. Budget check at WORKSPACE/CAMPAIGN/PROVIDER before dispatch
    // (requirement 4; SHOT-level is out of scope here — see
    // AgentBudgetScopeSchema's doc comment in @combat/domain).
    const estimatedCents = microCentsToCents(
      computeCost(
        definition.modelPolicy.model,
        definition.tokenBudget.maxInputTokens,
        definition.tokenBudget.maxOutputTokens,
      ).costMicroCents,
    );
    const reservations: BudgetReservation[] = [];
    for (const level of BUDGET_GATED_LEVELS) {
      const scopeId =
        level === 'WORKSPACE'
          ? workspaceId
          : level === 'CAMPAIGN'
            ? campaignId
            : definition.modelPolicy.model;
      const budgetResult = await checkAndReserveBudget(deps.budgetDb, {
        workspaceId,
        level,
        scopeId,
        requiredCents: estimatedCents,
        idempotencyKey,
        campaignId,
      });
      if (!budgetResult.ok) {
        await releaseReservations(reservations, workspaceId, campaignId, estimatedCents, idempotencyKey);
        return persistFailure(input, {
          reason: 'BUDGET_EXCEEDED',
          retryable: false,
          message: budgetResult.error.message,
          details: budgetResult.error.reason,
        });
      }
      if (budgetResult.policy) {
        reservations.push({ policyId: budgetResult.policy.id });
      }
    }

    // 5. Execute — the one and only place this Activity calls the reasoning
    // provider, entirely through `executeAgent` (requirement 5: no
    // duplicated prompt assembly, validation, retry, or cost logic here).
    const agentInput: AgentInput<unknown> = {
      invocationId: idempotencyKey,
      workflowRunId: input.workflowRunId,
      stage: input.stage,
      promptVersion: String(definition.promptVersion.version),
      input: input.payload,
      context: input.context,
      attachments: input.attachments,
    };

    let run: AgentRun<unknown>;
    try {
      run = await executeAgent(definition, agentInput, {
        reasoningProvider: deps.reasoningProvider,
        logger: deps.logger,
        now,
      });
    } catch (error) {
      // NOT_IMPLEMENTED (placeholder agents) and DISABLED are thrown by
      // `executeAgent` before any provider call — caught here so they still
      // become a persisted, typed AgentInvocation (requirement 6).
      await releaseReservations(reservations, workspaceId, campaignId, estimatedCents, idempotencyKey);
      return persistFailure(input, toAgentFailure(error), definition.promptVersion.version);
    }

    // 6. True up the budget reservation against the actual cost.
    const actualCents = microCentsToCents(run.cost.costMicroCents);
    for (const reservation of reservations) {
      await chargeBudget(deps.budgetDb, reservation.policyId, workspaceId, {
        amountCents: actualCents,
        idempotencyKey: `${idempotencyKey}:charge`,
        campaignId,
      });
      const remainder = estimatedCents - actualCents;
      if (remainder > 0) {
        await releaseBudget(deps.budgetDb, reservation.policyId, workspaceId, {
          amountCents: remainder,
          idempotencyKey: `${idempotencyKey}:release`,
          campaignId,
        });
      }
    }

    const record = await recordAgentInvocation(deps.agentInvocationDb, {
      workspaceId,
      campaignId,
      workflowRunId: input.workflowRunId,
      stage: input.stage,
      agentName: input.agentName,
      agentVersion: input.agentVersion,
      idempotencyKey,
      correlationId: input.correlationId,
      causationId: input.causationId,
      status: run.status,
      result: run.result ?? undefined,
      failureReason: run.failure?.reason,
      failureRetryable: run.failure?.retryable,
      failureMessage: run.failure?.message,
      failureDetails: run.failure ? redact(run.failure.details) : undefined,
      model: run.modelMeta.model,
      promptVersion: run.modelMeta.promptVersion,
      tokensIn: run.modelMeta.tokensIn,
      tokensOut: run.modelMeta.tokensOut,
      costCents: actualCents,
      inputHash: run.inputHash,
      outputHash: run.outputHash ?? undefined,
      attempt: getAttempt(),
      startedAt: new Date(run.startedAt),
      completedAt: new Date(run.completedAt),
    });

    return toOutput(record, false);
  };
}

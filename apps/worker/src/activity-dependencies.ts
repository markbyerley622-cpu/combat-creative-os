import { AGENT_REGISTRY } from '@combat/agents';
import type { WorkerEnv } from '@combat/config';
import { createPrismaClient, type PrismaClient } from '@combat/database';
import type { Logger } from '@combat/observability';
import {
  MockMotionGraphicsProvider,
  MockReasoningProvider,
  MockVideoGenerationProvider,
  createClaudeReasoningProvider,
  type ReasoningProvider,
} from '@combat/providers';
import type { WorkerActivityCostEstimates, WorkerActivityDependencies } from '@combat/workflows';
import { createPrismaActivityDatabase } from './prisma-activity-database';

/**
 * Reservation-sizing estimates. Deliberately code-level constants rather than
 * env vars: they only size a pre-dispatch RESERVATION, and every one is trued
 * up against the provider's reported usage when the job settles
 * (`settleBudgetReservation`), so an imprecise estimate costs nothing but a
 * temporarily larger hold. They match the values the Activity unit tests use.
 */
const COST_ESTIMATES: WorkerActivityCostEstimates = {
  shotGenerationCentsPerSecond: 50,
  compositionCentsPerFrame: 2,
  variantCentsPerFrame: 2,
};

/**
 * Resolves the reasoning provider from validated config only.
 *
 * `workerEnvSchema` already fails closed when `REASONING_PROVIDER=claude`
 * arrives without an `ANTHROPIC_API_KEY` (M14), so by the time this runs the
 * key is guaranteed present for the `claude` branch — the check below is a
 * type narrowing, not a second policy. `process.env` is never read here
 * (CLAUDE.md provider-adapter rule).
 */
export async function resolveReasoningProvider(env: WorkerEnv): Promise<ReasoningProvider> {
  if (env.REASONING_PROVIDER === 'claude') {
    return createClaudeReasoningProvider(env.ANTHROPIC_API_KEY!);
  }
  return new MockReasoningProvider();
}

export interface ActivityDependencyOptions {
  readonly env: WorkerEnv;
  readonly logger: Logger;
  /** Temporal's per-Activity attempt counter, supplied by the caller so this module needs no `@temporalio/activity` import. */
  readonly getAttempt?: () => number;
  /** Overridable so the wiring can be exercised without a live Postgres. */
  readonly prisma?: PrismaClient;
}

/**
 * Builds the concrete collaborators `createWorkerActivities` needs.
 *
 * Video generation and motion graphics resolve to their deterministic mocks
 * unconditionally: no real Veo/Runway/ComfyUI/aerender adapter exists in this
 * repository, and CLAUDE.md forbids connecting one or spending money through
 * one without an explicit, separate decision. This is the honest wiring — a
 * Worker that starts and runs, against mocks, rather than one that pretends to
 * have renderers it does not have.
 */
export async function createActivityDependencies(
  options: ActivityDependencyOptions,
): Promise<{ deps: WorkerActivityDependencies; prisma: PrismaClient }> {
  const prisma = options.prisma ?? createPrismaClient();

  const deps: WorkerActivityDependencies = {
    db: createPrismaActivityDatabase(prisma),
    videoGenerationProvider: new MockVideoGenerationProvider(),
    motionGraphicsProvider: new MockMotionGraphicsProvider(),
    reasoningProvider: await resolveReasoningProvider(options.env),
    agentRegistry: AGENT_REGISTRY,
    costEstimates: COST_ESTIMATES,
    logger: options.logger,
    getAttempt: options.getAttempt,
  };

  return { deps, prisma };
}

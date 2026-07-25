import { describe, expect, it } from 'vitest';
import { InMemoryCampaignStore } from '@combat/database';
import { AGENT_REGISTRY } from '@combat/agents';
import {
  MockMotionGraphicsProvider,
  MockReasoningProvider,
  MockVideoGenerationProvider,
} from '@combat/providers';
import * as allActivities from '../activities';
import {
  createWorkerActivities,
  type WorkerActivities,
  type WorkerActivityDependencies,
} from './worker-activities';
import {
  REQUIRED_WORKER_ACTIVITY_NAMES,
  WORKFLOW_ACTIVITY_CONTRACTS,
} from './required-activity-names';

/**
 * Post-M14 audit finding C-1 — the regression test that would have caught it.
 *
 * `apps/worker` registered `@combat/workflows`' `activities` namespace, which
 * exports `create*Activity(deps)` factories, so not one name a workflow
 * proxies was registered and every workflow would have failed at runtime the
 * moment a real Temporal server was connected. This suite builds the actual
 * production registration object against in-memory fakes — no Temporal server,
 * no Postgres, no provider credentials — and asserts it covers exactly the
 * Activity names the canonical workflow contracts declare.
 */

function buildDependencies(
  overrides: Partial<WorkerActivityDependencies> = {},
): WorkerActivityDependencies {
  const store = new InMemoryCampaignStore();
  return {
    db: store,
    videoGenerationProvider: new MockVideoGenerationProvider(),
    motionGraphicsProvider: new MockMotionGraphicsProvider(),
    reasoningProvider: new MockReasoningProvider(),
    agentRegistry: AGENT_REGISTRY,
    costEstimates: {
      shotGenerationCentsPerSecond: 50,
      compositionCentsPerFrame: 2,
      variantCentsPerFrame: 2,
    },
    ...overrides,
  };
}

/** Index-signature view of the registration object, for looking names up dynamically. */
function asRegistry(activities: WorkerActivities): Record<string, unknown> {
  return activities as unknown as Record<string, unknown>;
}

/** Sorted for stable, readable diffs when an assertion fails. */
function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe('createWorkerActivities — Worker registration conformance', () => {
  it('registers exactly the Activity names the workflow contracts declare', () => {
    const registered = sorted(Object.keys(createWorkerActivities(buildDependencies())));
    const required = sorted(REQUIRED_WORKER_ACTIVITY_NAMES);

    const missing = required.filter((name) => !registered.includes(name));
    const unexpected = registered.filter((name) => !required.includes(name));

    expect(
      missing,
      `Activities a workflow proxies but the Worker does not register: ${missing.join(', ') || '(none)'}`,
    ).toEqual([]);
    expect(
      unexpected,
      `Activities registered with the Worker that no workflow contract declares: ${unexpected.join(', ') || '(none)'}`,
    ).toEqual([]);
    expect(registered).toEqual(required);
  });

  it('registers a callable function for every required name', () => {
    const registry = asRegistry(createWorkerActivities(buildDependencies()));

    for (const name of REQUIRED_WORKER_ACTIVITY_NAMES) {
      expect(typeof registry[name], `${name} must be registered as a function`).toBe('function');
    }
  });

  it.each(WORKFLOW_ACTIVITY_CONTRACTS.map((c) => [c.workflow, c] as const))(
    '%s can resolve every Activity it proxies',
    (workflow, contract) => {
      const registry = asRegistry(createWorkerActivities(buildDependencies()));
      const unresolved = contract.activityNames.filter(
        (name) => typeof registry[name] !== 'function',
      );

      expect(unresolved, `${workflow} would fail at runtime on: ${unresolved.join(', ')}`).toEqual(
        [],
      );
    },
  );

  /**
   * The direction that makes a *future* missing registration fail before
   * merge. `REQUIRED_WORKER_ACTIVITY_NAMES` is derived from the contract
   * tuples, each compile-time proven to cover its interface exactly
   * (`activity-name-contract.ts`), so a new Activity added to a contract
   * appears here automatically — and this assertion fails until
   * `createWorkerActivities` builds it.
   */
  it('detects a dropped registration', () => {
    const complete = asRegistry(createWorkerActivities(buildDependencies()));
    const { advanceCampaignStageActivity: _dropped, ...damaged } = complete;

    const missing = REQUIRED_WORKER_ACTIVITY_NAMES.filter(
      (name) => typeof damaged[name] !== 'function',
    );

    expect(missing).toEqual(['advanceCampaignStageActivity']);
  });

  it('needs no Temporal server, database or provider credential to build', () => {
    // The whole point of keeping the factories dependency-injected: the exact
    // object apps/worker registers is constructible from in-memory fakes.
    expect(() => createWorkerActivities(buildDependencies())).not.toThrow();
  });
});

describe('createWorkerActivities — Activities deliberately left unregistered', () => {
  /**
   * `../activities` exports more than the workflows proxy. Naming the
   * exclusions here (rather than leaving them as an unexplained gap) is what
   * makes the exact-coverage assertion above safe: if one of these ever
   * becomes a workflow step, its contract tuple grows, the coverage test fails,
   * and this list must be revisited on purpose.
   */
  const NOT_PROXIED_BY_ANY_WORKFLOW = [
    // Called in-process by apps/api's upload-confirm route, not by a workflow.
    'createIngestAssetActivity',
    // No media-pipeline workflow stage exists yet (docs/architecture.md §7.1).
    'createInspectMediaActivity',
    'createGenerateMediaProxyActivity',
    // Performance ingestion is an apps/api route, not a workflow step.
    'createIngestPerformanceObservationsActivity',
    // Composed as a dependency of the specialist Activities, never proxied —
    // this is what keeps "an agent never calls another agent" true in code.
    'createExecuteSpecialistAgentActivity',
  ] as const;

  it('every excluded factory still exists and is still not registered', () => {
    const registered = new Set(Object.keys(createWorkerActivities(buildDependencies())));
    const exported = allActivities as unknown as Record<string, unknown>;

    for (const factory of NOT_PROXIED_BY_ANY_WORKFLOW) {
      expect(typeof exported[factory], `${factory} should still be exported`).toBe('function');
      // The Activity a factory produces is the factory name minus `create`,
      // lower-cased at the first character.
      const activityName = factory.slice('create'.length);
      const proxiedName = activityName.charAt(0).toLowerCase() + activityName.slice(1);
      expect(registered.has(proxiedName as keyof WorkerActivities)).toBe(false);
    }
  });
});

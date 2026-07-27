import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CreativeDirectorResult } from '@combat/agents';
import type { ReasoningInvokeInput } from '@combat/providers';

import type { CampaignRequest } from '../campaign-request';
import { CreativeMemoryInjector } from '../creative-memory/injection';
import { planCampaign } from '../plan-campaign';
import { runConceptCompetition, validateLaunchConcept } from './concept-competition';
import { LaunchFixtureReasoningProvider } from './launch-fixture-reasoning';
import {
  LAUNCH_FIXTURE_AT,
  LAUNCH_FIXTURE_CAMPAIGN_ID,
  LAUNCH_FIXTURE_WORKSPACE_ID,
  launchCreativeMemoryDependencies,
  launchRequestJson,
} from './launch-fixtures';

/**
 * What each agent was actually handed.
 *
 * The acceptance test proves the artefacts on disk; this one proves the
 * envelopes. They are different claims: a run can produce a plausible-looking
 * concept set while quietly failing to pass a prohibited claim to the stage
 * that writes on-screen copy, and only reading the invocation inputs catches
 * that.
 */

const REQUEST_JSON = launchRequestJson();

function request(): CampaignRequest {
  const raw = REQUEST_JSON as Record<string, unknown>;
  return {
    ...(raw as unknown as CampaignRequest),
    promptSha256: 'a'.repeat(64),
    sourceAssetManifestPath: resolve('assets.json'),
    requestPath: resolve('request.json'),
  };
}

/** Every agent input the provider saw, in call order. */
function inputsOf(provider: LaunchFixtureReasoningProvider): Record<string, unknown>[] {
  return provider.calls.map((call: ReasoningInvokeInput) => {
    const first = call.messages[0];
    const raw = typeof first?.content === 'string' ? first.content : '{}';
    return (JSON.parse(raw) as { input?: Record<string, unknown> }).input ?? {};
  });
}

async function injector(): Promise<CreativeMemoryInjector> {
  return new CreativeMemoryInjector({
    mode: 'required',
    dependencies: await launchCreativeMemoryDependencies(),
    workspaceId: LAUNCH_FIXTURE_WORKSPACE_ID,
    campaignId: LAUNCH_FIXTURE_CAMPAIGN_ID,
    platform: 'TIKTOK',
    now: LAUNCH_FIXTURE_AT,
  });
}

async function competition(): Promise<{
  provider: LaunchFixtureReasoningProvider;
  result: Awaited<ReturnType<typeof runConceptCompetition>>;
}> {
  const provider = new LaunchFixtureReasoningProvider();
  let counter = 0;
  const result = await runConceptCompetition({
    request: request(),
    launchBrief: (REQUEST_JSON.productLaunch as CampaignRequest['productLaunch'])!,
    reasoningProvider: provider,
    workflowRunId: 'competition-test',
    injector: await injector(),
    newConceptId: () => `concept-${(counter += 1)}`,
  });
  return { provider, result };
}

describe('the brief reaches every agent that competes', () => {
  it('passes the campaign prompt, the product truths and the prohibited claims to every invocation', async () => {
    const { provider, result } = await competition();
    const inputs = inputsOf(provider);
    const brief = REQUEST_JSON.productLaunch as {
      prohibitedClaims: string[];
      positioning: string;
      desiredAudiencePerception: string;
    };

    // One strategist call plus one director call per candidate.
    expect(inputs.length).toBe(result.candidates.length + result.rejected.length + 1);
    for (const input of inputs) {
      expect(input.campaignPrompt).toBe(REQUEST_JSON.campaignPrompt);
      const constraints = input.factualConstraints as string[];
      expect(constraints).toEqual(
        expect.arrayContaining([expect.stringContaining('PRODUCT [coverage] —')]),
      );
      const launch = input.productLaunch as typeof brief;
      expect(launch.prohibitedClaims).toEqual(brief.prohibitedClaims);
      expect(launch.positioning).toBe(brief.positioning);
      expect(launch.desiredAudiencePerception).toBe(brief.desiredAudiencePerception);
    }
  });

  it('tells each candidate which structural positions the earlier ones took', async () => {
    const { provider } = await competition();
    const directives = inputsOf(provider)
      .map(
        (input) =>
          input.launchDirective as {
            candidateIndex: number;
            occupiedStructuralPositions: string[];
          },
      )
      .filter((directive) => directive !== undefined);

    expect(directives.length).toBeGreaterThanOrEqual(3);
    expect(directives[0]?.occupiedStructuralPositions).toEqual([]);
    // Every later candidate is told strictly more than the one before it.
    for (let index = 1; index < directives.length; index += 1) {
      expect(
        (directives[index]?.occupiedStructuralPositions.length ?? 0) >
          (directives[index - 1]?.occupiedStructuralPositions.length ?? 0),
      ).toBe(true);
    }
  });

  it('injects a role-specific Creative Memory context into each invocation', async () => {
    const { provider } = await competition();
    const inputs = inputsOf(provider);

    const strategist = inputs[0] as { creativeMemory?: { agentRole: string; planKey: string } };
    const director = inputs[1] as { creativeMemory?: { agentRole: string; planKey: string } };
    expect(strategist.creativeMemory?.agentRole).toBe('CAMPAIGN_STRATEGIST');
    expect(director.creativeMemory?.agentRole).toBe('CREATIVE_DIRECTOR');
    expect(strategist.creativeMemory?.planKey).not.toBe(director.creativeMemory?.planKey);

    // Agent-safe: the context carries measurements and abstractions, never a
    // path, a URL or a byte.
    const serialised = JSON.stringify(director.creativeMemory);
    expect(serialised).not.toMatch(/\.mp4|\.png|https?:\/\/|file:/);
  });
});

describe('the brief reaches the downstream planning agents too', () => {
  it('gives the script and shot agents the launch brief and its prohibited claims', async () => {
    const provider = new LaunchFixtureReasoningProvider();
    const { result } = await competition();
    const selected = result.candidates[0];
    expect(selected).toBeDefined();

    await planCampaign({
      request: request(),
      reasoningProvider: provider,
      workflowRunId: 'handoff-test',
      preplanned: {
        strategy: result.strategy,
        concept: (selected as { director: CreativeDirectorResult }).director,
      },
    });

    const inputs = inputsOf(provider);
    expect(inputs.length).toBeGreaterThan(0);
    const brief = REQUEST_JSON.productLaunch as { prohibitedClaims: string[] };
    for (const input of inputs) {
      expect((input.productLaunch as { prohibitedClaims: string[] }).prohibitedClaims).toEqual(
        brief.prohibitedClaims,
      );
      expect(input.campaignPrompt).toBe(REQUEST_JSON.campaignPrompt);
    }
    // The approved concept was not re-authored: no creative-director call ran.
    expect(inputs.some((input) => 'launchDirective' in input)).toBe(false);
  });
});

describe('a candidate that does not satisfy the contract is rejected, never repaired', () => {
  const permitted = new Set<string>();

  it('rejects a result with no structured concept', () => {
    const outcome = validateLaunchConcept(
      { logline: 'x', visualDirection: 'y', narrativeArc: 'z', referenceNotes: [] },
      { productFactIds: new Set(['coverage']), permittedReferenceIds: permitted },
    );
    expect('reasons' in outcome && outcome.reasons[0]).toContain('no launchConcept');
  });

  it('rejects a claim that cites a product fact the campaign never supplied', async () => {
    const { result } = await competition();
    const candidate = result.candidates[0];
    expect(candidate).toBeDefined();

    const outcome = validateLaunchConcept(
      (candidate as { director: CreativeDirectorResult }).director,
      { productFactIds: new Set(['something-else']), permittedReferenceIds: permitted },
    );
    expect('reasons' in outcome).toBe(true);
    expect('reasons' in outcome && outcome.reasons.join(' ')).toContain('invented claim');
  });

  it('rejects a reference citation the agent was never given', async () => {
    const { result } = await competition();
    const candidate = result.candidates[0];
    const outcome = validateLaunchConcept(
      (candidate as { director: CreativeDirectorResult }).director,
      { productFactIds: new Set(['coverage', 'free']), permittedReferenceIds: new Set() },
    );
    expect('reasons' in outcome).toBe(true);
    expect('reasons' in outcome && outcome.reasons.join(' ')).toContain(
      'was not in this invocation',
    );
  });
});

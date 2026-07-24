import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  executeAgent,
  AgentNotImplementedError,
  type AgentDefinition,
} from '@combat/agent-runtime';
import type { AgentInput } from '@combat/domain';
import { QueuedReasoningProvider } from '@combat/agent-runtime';
import {
  assetManagerAgent,
  motionCompositingCoordinatorAgent,
  videoGenerationCoordinatorAgent,
} from './registry';

type AnyAgentDefinition = AgentDefinition<unknown, unknown>;

function buildInput(input: unknown): AgentInput<unknown> {
  return {
    invocationId: randomUUID(),
    workflowRunId: randomUUID(),
    stage: 'ASSET_PREP',
    promptVersion: '1',
    input,
    context: { campaignId: randomUUID(), priorArtifactRefs: [], budgetRemainingCents: 0 },
  };
}

/**
 * Proves the three deferred agents cannot be executed accidentally
 * (clarified requirement: "Include tests proving they cannot be executed
 * accidentally"). Each attempt must fail with the typed, non-retryable
 * `AgentNotImplementedError` — before the reasoning provider is ever called.
 */
describe('placeholder agents refuse to execute', () => {
  const cases: Array<[string, AnyAgentDefinition, unknown]> = [
    [
      'asset-manager',
      assetManagerAgent as unknown as AnyAgentDefinition,
      { shots: [{ index: 0, description: 'x' }], brandAssetLibraryRefs: [] },
    ],
    [
      'video-generation-coordinator',
      videoGenerationCoordinatorAgent as unknown as AnyAgentDefinition,
      {
        shotPrompts: [{ shotIndex: 0, providerId: 'mock', promptText: 'x' }],
        candidateCountPerShot: 1,
        budgetRemainingCents: 0,
      },
    ],
    [
      'motion-compositing-coordinator',
      motionCompositingCoordinatorAgent as unknown as AnyAgentDefinition,
      { shot: { index: 0, description: 'x' }, selectedCandidateRef: 'ref', brandTemplateRefs: [] },
    ],
  ];

  it.each(cases)(
    '%s throws AgentNotImplementedError and never calls the reasoning provider',
    async (_name, agent, input) => {
      const provider = new QueuedReasoningProvider([]);

      await expect(
        executeAgent(agent, buildInput(input), { reasoningProvider: provider }),
      ).rejects.toBeInstanceOf(AgentNotImplementedError);
      expect(provider.calls).toHaveLength(0);
    },
  );

  it('reports the future milestone responsible for each deferred agent in the thrown error', async () => {
    const provider = new QueuedReasoningProvider([]);
    try {
      await executeAgent(
        assetManagerAgent,
        buildInput({ shots: [{ index: 0, description: 'x' }], brandAssetLibraryRefs: [] }),
        { reasoningProvider: provider },
      );
      expect.unreachable('expected AgentNotImplementedError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentNotImplementedError);
      expect((error as AgentNotImplementedError).message).toContain('asset-manager');
    }
  });
});

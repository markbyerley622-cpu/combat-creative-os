import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executeAgent, QueuedReasoningProvider } from '@combat/agent-runtime';
import type { AgentInput } from '@combat/domain';
import {
  campaignStrategistAgent,
  creativeDirectorAgent,
  scriptTimingDirectorAgent,
  shotPromptEngineerAgent,
} from './registry';
import {
  COMBAT_REVIEWS_BRIEF,
  COMBAT_REVIEWS_CONCEPT_RESULT,
  COMBAT_REVIEWS_SCRIPT_RESULT,
  COMBAT_REVIEWS_SHOT_PROMPT_RESULT,
  COMBAT_REVIEWS_STRATEGY_RESULT,
} from './fixtures/combat-reviews-15s';

function envelope<T>(input: T): AgentInput<T> {
  return {
    invocationId: randomUUID(),
    workflowRunId: randomUUID(),
    stage: 'STRATEGY',
    promptVersion: '1',
    input,
    context: {
      campaignId: randomUUID(),
      priorArtifactRefs: [],
      budgetRemainingCents: COMBAT_REVIEWS_BRIEF.budgetCents,
    },
  };
}

/**
 * Drives the Combat Reviews 15-second-ad golden fixture through four real
 * agent-handoff stages — campaign-strategist -> creative-director ->
 * script-timing-director -> shot-prompt-engineer — using
 * `QueuedReasoningProvider` so no paid API is ever called, while every
 * intermediate value still passes through the real `executeAgent` harness
 * (schema validation, hashing, cost accounting) and each stage's output is
 * fed as the *next* stage's real, schema-validated input.
 */
describe('Combat Reviews 15s ad — agent handoff', () => {
  it('carries hook / promise / feature-journey / CTA intact from brief through shot prompt', async () => {
    // Stage 1: Campaign Strategist
    const strategistProvider = new QueuedReasoningProvider([
      { result: COMBAT_REVIEWS_STRATEGY_RESULT },
    ]);
    const strategyRun = await executeAgent(
      campaignStrategistAgent,
      envelope(COMBAT_REVIEWS_BRIEF),
      {
        reasoningProvider: strategistProvider,
      },
    );
    expect(strategyRun.status).toBe('SUCCEEDED');
    const strategy = strategyRun.result!.strategy;
    expect(strategy.keyMessages).toEqual(
      expect.arrayContaining(['12 Fight Events This Weekend', 'Every Combat Sport. One App.']),
    );

    // Stage 2: Creative Director — consumes stage 1's real, validated output.
    const creativeDirectorInput = {
      brandName: COMBAT_REVIEWS_BRIEF.brandName,
      strategy,
      mandatories: COMBAT_REVIEWS_BRIEF.mandatories,
      durationsSeconds: COMBAT_REVIEWS_BRIEF.durationsSeconds,
    };
    expect(() => creativeDirectorAgent.inputSchema.parse(creativeDirectorInput)).not.toThrow();
    const conceptProvider = new QueuedReasoningProvider([
      { result: COMBAT_REVIEWS_CONCEPT_RESULT },
    ]);
    const conceptRun = await executeAgent(creativeDirectorAgent, envelope(creativeDirectorInput), {
      reasoningProvider: conceptProvider,
    });
    expect(conceptRun.status).toBe('SUCCEEDED');
    const concept = conceptRun.result!;

    // Stage 3: Script Director (canonical id script-timing-director).
    const scriptInput = {
      logline: concept.logline,
      visualDirection: concept.visualDirection,
      narrativeArc: concept.narrativeArc,
      targetDurationsSeconds: COMBAT_REVIEWS_BRIEF.durationsSeconds,
      keyMessages: strategy.keyMessages,
      callToAction: 'Download Free',
      frameRate: 30,
    };
    expect(() => scriptTimingDirectorAgent.inputSchema.parse(scriptInput)).not.toThrow();
    const scriptProvider = new QueuedReasoningProvider([{ result: COMBAT_REVIEWS_SCRIPT_RESULT }]);
    const scriptRun = await executeAgent(scriptTimingDirectorAgent, envelope(scriptInput), {
      reasoningProvider: scriptProvider,
    });
    expect(scriptRun.status).toBe('SUCCEEDED');
    const shots = scriptRun.result!.shots;

    expect(shots[0]!.beat).toBe('HOOK');
    expect(shots.at(-1)!.beat).toBe('CTA');
    expect(shots.at(-1)!.description).toContain('Download Free');
    expect(shots.some((s) => s.beat === 'PROMISE')).toBe(true);

    const featureShots = shots.filter((s) => s.beat === 'FEATURE');
    expect(featureShots).toHaveLength(4);
    // Feature journey order: discovery -> information -> prediction -> discussion.
    expect(featureShots[0]!.description.toLowerCase()).toContain('discovery');
    expect(featureShots[1]!.description.toLowerCase()).toContain('information');
    expect(featureShots[2]!.description.toLowerCase()).toContain('prediction');
    expect(featureShots[3]!.description.toLowerCase()).toContain('discussion');

    // durationFrames must sum to totalDurationFrames.
    const sum = shots.reduce((total, shot) => total + shot.durationFrames, 0);
    expect(sum).toBe(scriptRun.result!.totalDurationFrames);

    // Stage 4: Shot Prompt Engineer — consumes one real shot from stage 3.
    const hookShot = shots[0]!;
    const shotPromptInput = {
      shot: {
        index: hookShot.index,
        description: hookShot.description,
        durationFrames: hookShot.durationFrames,
      },
      visualDirection: concept.visualDirection,
      providerId: 'mock-video-gen',
    };
    expect(() => shotPromptEngineerAgent.inputSchema.parse(shotPromptInput)).not.toThrow();
    const shotPromptProvider = new QueuedReasoningProvider([
      { result: COMBAT_REVIEWS_SHOT_PROMPT_RESULT },
    ]);
    const shotPromptRun = await executeAgent(shotPromptEngineerAgent, envelope(shotPromptInput), {
      reasoningProvider: shotPromptProvider,
    });

    expect(shotPromptRun.status).toBe('SUCCEEDED');
    expect(shotPromptRun.result!.providerId).toBe('mock-video-gen');
    expect(shotPromptRun.result!.promptText.length).toBeGreaterThan(0);

    // Every stage's run recorded distinct invocation bookkeeping — no shared state leakage.
    const invocationIds = new Set([
      strategyRun.invocationId,
      conceptRun.invocationId,
      scriptRun.invocationId,
      shotPromptRun.invocationId,
    ]);
    expect(invocationIds.size).toBe(4);
  });
});

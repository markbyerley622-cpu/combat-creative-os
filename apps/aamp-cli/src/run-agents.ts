import { randomUUID } from 'node:crypto';

import { AGENT_REGISTRY } from '@combat/agents';
import type {
  CampaignStrategistResult,
  CreativeDirectorResult,
  ScriptTimingDirectorResult,
  ShotPromptEngineerResult,
} from '@combat/agents';
import { executeAgent, type AgentDefinition } from '@combat/agent-runtime';
import type { AgentInput } from '@combat/domain';
import type { ReasoningProvider } from '@combat/providers';

import type { CampaignGenerationManifest } from './generation-manifest';

/**
 * The existing specialist agents, run in the existing order, through the
 * existing typed handoffs.
 *
 * This is deliberately *not* a second agent system. Each step calls
 * `executeAgent` with a definition from the canonical `AGENT_REGISTRY`,
 * validates through that agent's own schemas, and passes its typed result to
 * the next — the same contracts `runStrategyConceptScriptActivity` and
 * `runShotPromptEngineerActivity` use inside Temporal. What this module does
 * *not* do is persist anything or sequence approvals: it is a CLI's read-only
 * pass over the creative chain, and the three human gates continue to live
 * only in the workflow path.
 */

export interface AgentPipelineOptions {
  readonly manifest: CampaignGenerationManifest;
  readonly reasoningProvider: ReasoningProvider;
  readonly workflowRunId: string;
  readonly onProgress?: (message: string) => void;
}

/** One shot brief, as the generation step consumes it. */
export interface GeneratedShotBrief {
  readonly index: number;
  readonly shotId: string;
  readonly description: string;
  readonly durationSeconds: number;
  readonly promptText: string;
  readonly negativePrompt?: string;
  readonly creativeAttributes: {
    readonly subject: string;
    readonly action: string;
    readonly environment: string;
    readonly cameraMovement: string;
    readonly lensFraming: string;
    readonly lighting: string;
    readonly colorTreatment: string;
    readonly motionIntensity: string;
    readonly continuityRequirements: readonly string[];
    readonly visualObjective: string;
  };
}

export interface AgentPipelineResult {
  readonly strategy: CampaignStrategistResult;
  readonly concept: CreativeDirectorResult;
  readonly script: ScriptTimingDirectorResult;
  readonly shotBriefs: readonly GeneratedShotBrief[];
}

export class AgentPipelineError extends Error {
  constructor(agentName: string, detail: string) {
    super(`Agent "${agentName}" failed: ${detail}`);
    this.name = 'AgentPipelineError';
  }
}

function envelope<T>(
  input: T,
  options: { workflowRunId: string; campaignId: string; stage: string; promptVersion: string },
): AgentInput<T> {
  return {
    invocationId: randomUUID(),
    workflowRunId: options.workflowRunId,
    stage: options.stage,
    promptVersion: options.promptVersion,
    input,
    context: {
      campaignId: options.campaignId,
      priorArtifactRefs: [],
      // The CLI performs no budget reservation of its own — that machinery is
      // the Activity's, and duplicating it here would write ledger rows for a
      // run the workflow never saw.
      budgetRemainingCents: 0,
    },
  };
}

async function runOne<TInput, TResult>(
  agentName: string,
  input: TInput,
  options: AgentPipelineOptions & { stage: string },
): Promise<TResult> {
  // The registry is keyed by the canonical agent-name union; this CLI looks up
  // by string, so the widening happens here in one place rather than forcing
  // every call site to carry the literal type.
  const registry: Readonly<Record<string, AgentDefinition<unknown, unknown>>> = AGENT_REGISTRY;
  const definition = registry[agentName] as AgentDefinition<TInput, TResult> | undefined;
  if (!definition) {
    throw new AgentPipelineError(agentName, 'not present in AGENT_REGISTRY');
  }

  options.onProgress?.(`running agent ${agentName}`);
  const run = await executeAgent(
    definition,
    envelope(input, {
      workflowRunId: options.workflowRunId,
      campaignId: options.manifest.campaignId,
      stage: options.stage,
      promptVersion: String(definition.promptVersion.version),
    }),
    { reasoningProvider: options.reasoningProvider },
  );

  if (run.status !== 'SUCCEEDED' || run.result === null) {
    throw new AgentPipelineError(
      agentName,
      run.failure ? `${run.failure.reason}: ${run.failure.message}` : 'returned no result',
    );
  }
  return run.result;
}

/**
 * Runs Campaign Strategist → Creative Director → Script/Timing Director →
 * Shot Prompt Engineer and returns typed shot briefs.
 *
 * Only the first `generation.shotCount` shots the Script Director planned are
 * turned into generation briefs; the rest of the timeline is filled from
 * supplied assets. That is the hybrid-output rule from CLAUDE.md applied
 * literally — AI-generated visuals for controlled shots, real app assets for
 * everything the app itself must be seen doing.
 */
export async function runAgentPipeline(
  options: AgentPipelineOptions,
): Promise<AgentPipelineResult> {
  const { manifest } = options;
  const durations = [Math.round(manifest.outputDurationSeconds)];

  const strategy = await runOne<unknown, CampaignStrategistResult>(
    'campaign-strategist',
    {
      brandName: manifest.brandName,
      objective: manifest.objective,
      targetPlatforms: ['TIKTOK'],
      durationsSeconds: durations,
      budgetCents: manifest.budgetCents,
      keyMessages: manifest.keyMessages,
      mandatories: manifest.mandatories,
      priorLearnings: [],
    },
    { ...options, stage: 'STRATEGY' },
  );

  const concept = await runOne<unknown, CreativeDirectorResult>(
    'creative-director',
    {
      brandName: manifest.brandName,
      strategy: {
        positioning: strategy.strategy.positioning,
        targetAudienceSummary: strategy.strategy.targetAudienceSummary,
        keyMessages: strategy.strategy.keyMessages,
        toneGuidelines: strategy.strategy.toneGuidelines,
      },
      mandatories: manifest.mandatories,
      durationsSeconds: durations,
      priorLearnings: [],
    },
    { ...options, stage: 'CONCEPT' },
  );

  const script = await runOne<unknown, ScriptTimingDirectorResult>(
    'script-timing-director',
    {
      logline: concept.logline,
      visualDirection: concept.visualDirection,
      narrativeArc: concept.narrativeArc,
      targetDurationsSeconds: durations,
      keyMessages: manifest.keyMessages,
      callToAction: manifest.cta.headline,
      frameRate: 30,
    },
    { ...options, stage: 'SCRIPT' },
  );

  const shotsToGenerate = script.shots.slice(0, manifest.generation.shotCount);
  const shotBriefs: GeneratedShotBrief[] = [];

  for (const shot of shotsToGenerate) {
    // eslint-disable-next-line no-await-in-loop -- shot briefs are produced in script order so shot indices stay stable
    const brief = await runOne<unknown, ShotPromptEngineerResult>(
      'shot-prompt-engineer',
      {
        shot: {
          index: shot.index,
          description: shot.description,
          durationFrames: shot.durationFrames,
        },
        visualDirection: concept.visualDirection,
        providerId: 'comfyui',
      },
      { ...options, stage: 'SHOT_PROMPTS' },
    );

    shotBriefs.push({
      index: shot.index,
      shotId: randomUUID(),
      description: shot.description,
      // The manifest's per-shot ceiling wins over the script's own timing:
      // generation cost scales with frames, and the edit fills any shortfall
      // from supplied assets.
      durationSeconds: Math.min(
        manifest.generation.maxShotDurationSeconds,
        shot.durationFrames / 30,
      ),
      promptText: brief.promptText,
      ...(brief.negativePrompt ? { negativePrompt: brief.negativePrompt } : {}),
      creativeAttributes: {
        subject: brief.subject,
        action: brief.action,
        environment: brief.environment,
        cameraMovement: brief.cameraMovement,
        lensFraming: brief.lensFraming,
        lighting: brief.lighting,
        colorTreatment: brief.colorTreatment,
        motionIntensity: brief.motionIntensity,
        continuityRequirements: brief.continuityRequirements,
        visualObjective: brief.visualObjective,
      },
    });
  }

  return { strategy, concept, script, shotBriefs };
}

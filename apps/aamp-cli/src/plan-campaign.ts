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

import { formatFactualConstraints, type CampaignRequest } from './campaign-request';
import type { ScriptedShot } from './source-selection';

/**
 * Runs the existing specialist agents against a campaign request.
 *
 * The difference from the previous milestone's pipeline is what reaches the
 * agents. Before, they received a derived summary — an objective string and a
 * couple of key messages — and the requester's actual brief never left the CLI.
 * Now every planning agent receives `campaignPrompt` verbatim and the same
 * ordered `factualConstraints`, so the plan can be specific to what was
 * actually asked for. That propagation is the milestone, and
 * `plan-campaign.test.ts` asserts it rather than trusting it.
 *
 * Still not a second orchestration framework: every call is `executeAgent`
 * with a definition from the canonical `AGENT_REGISTRY`, validated by that
 * agent's own schemas, handed to the next by typed result. No persistence, no
 * approvals — the three human gates live only in the workflow path.
 */

export interface CampaignPlanOptions {
  readonly request: CampaignRequest;
  readonly reasoningProvider: ReasoningProvider;
  readonly workflowRunId: string;
  readonly onProgress?: (message: string) => void;
}

export interface CampaignPlan {
  readonly strategy: CampaignStrategistResult;
  readonly concept: CreativeDirectorResult;
  readonly script: ScriptTimingDirectorResult;
  readonly shots: readonly ScriptedShot[];
  readonly shotBriefs: readonly ShotPromptEngineerResult[];
  /** Caption line per shot, in shot order, derived from each shot's brief. */
  readonly captionLines: readonly string[];
  /** `agentName@promptVersion` for every agent that ran, in order. */
  readonly agentVersions: readonly string[];
}

export class CampaignPlanningError extends Error {
  constructor(agentName: string, detail: string) {
    super(`Planning failed at agent "${agentName}": ${detail}`);
    this.name = 'CampaignPlanningError';
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
      // The CLI reserves no budget of its own; that machinery belongs to the
      // Activity, and duplicating it here would write ledger rows for a run
      // the workflow never saw.
      budgetRemainingCents: 0,
    },
  };
}

async function runOne<TInput, TResult>(
  agentName: string,
  input: TInput,
  options: CampaignPlanOptions & { stage: string; agentVersions: string[] },
): Promise<TResult> {
  const registry: Readonly<Record<string, AgentDefinition<unknown, unknown>>> = AGENT_REGISTRY;
  const definition = registry[agentName] as AgentDefinition<TInput, TResult> | undefined;
  if (!definition) throw new CampaignPlanningError(agentName, 'not present in AGENT_REGISTRY');

  options.onProgress?.(`agent ${agentName} (prompt v${definition.promptVersion.version})`);
  options.agentVersions.push(`${agentName}@v${definition.promptVersion.version}`);

  const run = await executeAgent(
    definition,
    envelope(input, {
      workflowRunId: options.workflowRunId,
      campaignId: options.request.campaignId,
      stage: options.stage,
      promptVersion: String(definition.promptVersion.version),
    }),
    { reasoningProvider: options.reasoningProvider },
  );

  if (run.status !== 'SUCCEEDED' || run.result === null) {
    throw new CampaignPlanningError(
      agentName,
      run.failure ? `${run.failure.reason}: ${run.failure.message}` : 'returned no result',
    );
  }
  return run.result;
}

/**
 * The inputs handed to each agent, exposed separately from execution so tests
 * can assert prompt propagation and request determinism without a model.
 */
export function buildPlanningInputs(request: CampaignRequest): {
  strategist: Record<string, unknown>;
  factualConstraints: readonly string[];
} {
  const factualConstraints = formatFactualConstraints(request);
  return {
    factualConstraints,
    strategist: {
      brandName: request.brandName,
      objective: request.objective,
      targetPlatforms: [request.platform],
      durationsSeconds: [Math.round(request.targetDurationSeconds)],
      budgetCents: 0,
      keyMessages: request.keyMessages,
      mandatories: request.mandatories,
      priorLearnings: [],
      campaignPrompt: request.campaignPrompt,
      factualConstraints,
    },
  };
}

export async function planCampaign(options: CampaignPlanOptions): Promise<CampaignPlan> {
  const { request } = options;
  const agentVersions: string[] = [];
  const shared = { ...options, agentVersions };
  const { strategist, factualConstraints } = buildPlanningInputs(request);
  const durations = [Math.round(request.targetDurationSeconds)];

  const strategy = await runOne<unknown, CampaignStrategistResult>(
    'campaign-strategist',
    strategist,
    {
      ...shared,
      stage: 'STRATEGY',
    },
  );

  const concept = await runOne<unknown, CreativeDirectorResult>(
    'creative-director',
    {
      brandName: request.brandName,
      strategy: {
        positioning: strategy.strategy.positioning,
        targetAudienceSummary: strategy.strategy.targetAudienceSummary,
        keyMessages: strategy.strategy.keyMessages,
        toneGuidelines: strategy.strategy.toneGuidelines,
      },
      mandatories: request.mandatories,
      durationsSeconds: durations,
      priorLearnings: [],
      campaignPrompt: request.campaignPrompt,
      factualConstraints,
    },
    { ...shared, stage: 'CONCEPT' },
  );

  const script = await runOne<unknown, ScriptTimingDirectorResult>(
    'script-timing-director',
    {
      logline: concept.logline,
      visualDirection: concept.visualDirection,
      narrativeArc: concept.narrativeArc,
      targetDurationsSeconds: durations,
      keyMessages: request.keyMessages,
      callToAction: request.cta.headline,
      frameRate: 30,
      campaignPrompt: request.campaignPrompt,
      factualConstraints,
    },
    { ...shared, stage: 'SCRIPT' },
  );

  const shots: ScriptedShot[] = [];
  const shotBriefs: ShotPromptEngineerResult[] = [];
  const captionLines: string[] = [];

  for (const shot of script.shots) {
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
        // Even in a source-only edit the brief is real work: it is what the
        // selector matches against and what the captions are drawn from.
        providerId: request.generation.source === 'COMFYUI' ? 'comfyui' : 'source-library',
        campaignPrompt: request.campaignPrompt,
        factualConstraints,
      },
      { ...shared, stage: 'SHOT_PROMPTS' },
    );

    shots.push({
      index: shot.index,
      description: shot.description,
      durationSeconds: shot.durationFrames / 30,
      beat: shot.beat,
    });
    shotBriefs.push(brief);
    captionLines.push(deriveCaptionLine(brief, shot.description));
  }

  if (shots.length === 0) {
    throw new CampaignPlanningError('script-timing-director', 'produced no shots');
  }

  return { strategy, concept, script, shots, shotBriefs, captionLines, agentVersions };
}

/**
 * The on-screen line for a shot.
 *
 * Prefers the Shot-Prompt Engineer's `visualObjective` — a short statement of
 * what the shot is *for* — over its longer prose fields, because a caption has
 * to be readable in a feed at arm's length, not comprehensive.
 */
export function deriveCaptionLine(brief: ShotPromptEngineerResult, fallback: string): string {
  const candidate = (brief.visualObjective || fallback).trim();
  const firstSentence = candidate.split(/(?<=[.!?])\s/)[0] ?? candidate;
  return firstSentence.replace(/\s+/g, ' ').slice(0, 90);
}

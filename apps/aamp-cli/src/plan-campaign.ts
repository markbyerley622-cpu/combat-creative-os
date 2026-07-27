import type {
  CampaignStrategistResult,
  CreativeDirectorResult,
  ScriptTimingDirectorResult,
  ShotPromptEngineerResult,
} from '@combat/agents';
import type {
  CreativeDivergenceRecord,
  CreativeMemoryAgentRole,
  CreativeMemoryContext,
  RetrievalPlanInputs,
} from '@combat/domain';
import type { ReasoningProvider } from '@combat/providers';

import { AgentInvocationError, invokeAgent } from './agent-invocation';
import { formatFactualConstraints, type CampaignRequest } from './campaign-request';
import type { CreativeMemoryInjector } from './creative-memory/injection';
import type { ScriptedShot } from './source-selection';

/**
 * Runs the existing specialist agents against a campaign request.
 *
 * Two milestones' worth of input now reaches the agents. The prompt-driven
 * milestone gave them `campaignPrompt` verbatim and the ordered
 * `factualConstraints`. This one adds, immediately before each call, a bounded
 * and governed **role-specific Creative Memory context** — different for each
 * agent, because the four are answering different craft questions, and absent
 * entirely when `--creative-memory off` so the previous behaviour is preserved
 * byte for byte.
 *
 * Still not a second orchestration framework: every call is `executeAgent` with
 * a definition from the canonical `AGENT_REGISTRY`, validated by that agent's
 * own schemas, handed to the next by typed result. The agents themselves reach
 * nothing — the injector resolves context here, the same way an Activity would
 * inside Temporal, and no agent can initiate a query. No persistence, no
 * approvals: the three human gates continue to live only in the workflow path.
 */

export interface CampaignPlanOptions {
  readonly request: CampaignRequest;
  readonly reasoningProvider: ReasoningProvider;
  readonly workflowRunId: string;
  /** Absent in `--creative-memory off`, which is the pre-injection baseline. */
  readonly injector?: CreativeMemoryInjector;
  /**
   * A strategy and a concept that were decided earlier and approved.
   *
   * Set by the product-launch path after a named reviewer selected one concept
   * from a competing set. When present the Campaign Strategist and Creative
   * Director are **not** invoked again: re-running them would produce a
   * different concept from the one a human approved, which is the one failure a
   * concept gate exists to prevent. Everything downstream — script, shots,
   * captions, Creative Memory for those two roles — runs exactly as it does on
   * the ordinary path.
   */
  readonly preplanned?: {
    readonly strategy: CampaignStrategistResult;
    readonly concept: CreativeDirectorResult;
  };
  readonly onProgress?: (message: string) => void;
}

/** One agent invocation's Creative Memory record, for provenance and originality. */
export interface RoleContextRecord {
  readonly agentRole: CreativeMemoryAgentRole;
  readonly shotIndex?: number;
  readonly context?: CreativeMemoryContext;
  readonly divergence?: CreativeDivergenceRecord;
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
  /** What each agent was given and what it said it did with it, in call order. */
  readonly roleContexts: readonly RoleContextRecord[];
}

export class CampaignPlanningError extends Error {
  constructor(agentName: string, detail: string) {
    super(`Planning failed at agent "${agentName}": ${detail}`);
    this.name = 'CampaignPlanningError';
  }
}

async function runOne<TInput, TResult>(
  agentName: string,
  input: TInput,
  options: CampaignPlanOptions & { stage: string; agentVersions: string[] },
): Promise<TResult> {
  try {
    const invocation = await invokeAgent<TInput, TResult>(agentName, input, {
      reasoningProvider: options.reasoningProvider,
      workflowRunId: options.workflowRunId,
      campaignId: options.request.campaignId,
      stage: options.stage,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    options.agentVersions.push(invocation.agentVersion);
    return invocation.result;
  } catch (error) {
    if (error instanceof AgentInvocationError) {
      throw new CampaignPlanningError(error.agentName, error.detail);
    }
    throw error;
  }
}

/**
 * The brand system, as one line for retrieval.
 *
 * Colours, type and safe areas are the properties a benchmark's typography and
 * hierarchy observations are actually relevant to; the logo asset id is
 * deliberately excluded because an asset identifier is production-side and has
 * no business in a reference query.
 */
export function describeBrandSystem(request: CampaignRequest): string {
  const { brandKit } = request;
  return [
    `primary ${brandKit.primaryColorHex}`,
    `accent ${brandKit.accentColorHex}`,
    `caption type ${brandKit.captionFontFamily}`,
    '9:16 vertical',
    `top safe area ${brandKit.safeAreaTopPx}px`,
    `bottom safe area ${brandKit.safeAreaBottomPx}px`,
  ].join(', ');
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
      ...launchBriefFor(request),
    },
  };
}

/**
 * The launch brief, as the field every planning agent receives.
 *
 * One helper rather than four spread expressions, so the four agents cannot
 * drift into disagreeing about whether a prohibited claim applies to them.
 */
export function launchBriefFor(request: CampaignRequest): {
  productLaunch?: CampaignRequest['productLaunch'];
} {
  return request.productLaunch ? { productLaunch: request.productLaunch } : {};
}

/** The retrieval inputs available before any agent has run. */
export function baseRetrievalInputs(request: CampaignRequest): RetrievalPlanInputs {
  return {
    campaignPrompt: request.campaignPrompt,
    factualConstraints: formatFactualConstraints(request),
    objective: request.objective,
    targetAudience: request.targetAudience,
    brandSystem: describeBrandSystem(request),
    platform: request.platform,
    targetDurationSeconds: request.targetDurationSeconds,
    ctaHeadline: request.cta.headline,
  };
}

export async function planCampaign(options: CampaignPlanOptions): Promise<CampaignPlan> {
  const { request, injector } = options;
  const agentVersions: string[] = [];
  const roleContexts: RoleContextRecord[] = [];
  const shared = { ...options, agentVersions };
  const { strategist, factualConstraints } = buildPlanningInputs(request);
  const durations = [Math.round(request.targetDurationSeconds)];
  let retrievalInputs = baseRetrievalInputs(request);

  const record = (
    agentRole: CreativeMemoryAgentRole,
    context: CreativeMemoryContext | undefined,
    divergence: CreativeDivergenceRecord | undefined,
    shotIndex?: number,
  ): void => {
    roleContexts.push({
      agentRole,
      ...(shotIndex === undefined ? {} : { shotIndex }),
      ...(context ? { context } : {}),
      ...(divergence ? { divergence } : {}),
    });
  };

  // The two upstream roles are skipped entirely when a human already approved
  // their output. No context is retrieved for them either: retrieval that
  // cannot influence anything is spend with no effect on the campaign.
  const strategyContext = options.preplanned
    ? undefined
    : await injector?.contextFor('CAMPAIGN_STRATEGIST', retrievalInputs);
  const strategy =
    options.preplanned?.strategy ??
    (await runOne<unknown, CampaignStrategistResult>(
      'campaign-strategist',
      { ...strategist, ...(strategyContext ? { creativeMemory: strategyContext } : {}) },
      { ...shared, stage: 'STRATEGY' },
    ));
  if (!options.preplanned) {
    record('CAMPAIGN_STRATEGIST', strategyContext, strategy.creativeMemoryDivergence);
  }

  retrievalInputs = {
    ...retrievalInputs,
    strategy: {
      positioning: strategy.strategy.positioning,
      targetAudienceSummary: strategy.strategy.targetAudienceSummary,
      keyMessages: strategy.strategy.keyMessages,
      toneGuidelines: strategy.strategy.toneGuidelines,
    },
  };

  const conceptContext = options.preplanned
    ? undefined
    : await injector?.contextFor('CREATIVE_DIRECTOR', retrievalInputs);
  const concept =
    options.preplanned?.concept ??
    (await runOne<unknown, CreativeDirectorResult>(
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
        ...launchBriefFor(request),
        ...(conceptContext ? { creativeMemory: conceptContext } : {}),
      },
      { ...shared, stage: 'CONCEPT' },
    ));
  if (!options.preplanned) {
    record('CREATIVE_DIRECTOR', conceptContext, concept.creativeMemoryDivergence);
  }

  retrievalInputs = {
    ...retrievalInputs,
    concept: {
      logline: concept.logline,
      visualDirection: concept.visualDirection,
      narrativeArc: concept.narrativeArc,
    },
  };

  const scriptContext = await injector?.contextFor('SCRIPT_TIMING_DIRECTOR', retrievalInputs);
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
      ...launchBriefFor(request),
      ...(scriptContext ? { creativeMemory: scriptContext } : {}),
    },
    { ...shared, stage: 'SCRIPT' },
  );
  record('SCRIPT_TIMING_DIRECTOR', scriptContext, script.creativeMemoryDivergence);

  const shots: ScriptedShot[] = [];
  const shotBriefs: ShotPromptEngineerResult[] = [];
  const captionLines: string[] = [];

  for (const shot of script.shots) {
    // Retrieved per shot: a hook and a CTA are different craft questions, so
    // giving both the same context would waste the plan's specificity.
    // eslint-disable-next-line no-await-in-loop -- shot briefs are produced in script order so shot indices stay stable
    const shotContext = await injector?.contextFor(
      'SHOT_PROMPT_ENGINEER',
      {
        ...retrievalInputs,
        shot: { index: shot.index, description: shot.description, beat: shot.beat },
      },
      { shotIndex: shot.index },
    );

    // eslint-disable-next-line no-await-in-loop -- same ordering rationale
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
        ...launchBriefFor(request),
        ...(shotContext ? { creativeMemory: shotContext } : {}),
      },
      { ...shared, stage: 'SHOT_PROMPTS' },
    );
    record('SHOT_PROMPT_ENGINEER', shotContext, brief.creativeMemoryDivergence, shot.index);

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

  return {
    strategy,
    concept,
    script,
    shots,
    shotBriefs,
    captionLines,
    agentVersions,
    roleContexts,
  };
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

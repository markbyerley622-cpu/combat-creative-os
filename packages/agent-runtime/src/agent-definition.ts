import type { ZodType } from 'zod';
import type { ModelPolicy } from './model-policy';
import type { TokenBudget } from './token-budget';
import type { ToolPolicy } from './tool-policy';
import type { PromptTemplate } from './prompt-template';
import type { AgentEvaluation, QualityRubric } from './agent-evaluation';

/**
 * The full, versioned definition of one specialist agent — the "informal
 * string scattered through the codebase" this framework exists to replace.
 * Every specialist agent module exports exactly one of these; nothing else
 * in the codebase should construct an agent's model/prompt/schema wiring
 * ad hoc.
 *
 * `TInput`/`TResult` are the agent's *business* input/result types — the
 * harness (`execute-agent.ts`) wraps `TResult` with a `ReasoningBreakdown`
 * before validating the model's response, so agent authors only define the
 * creative/analytical shape, not the facts/decisions/assumptions/
 * recommendations envelope every agent shares.
 */
export interface AgentDefinition<TInput = unknown, TResult = unknown> {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;

  /**
   * False for the three deferred agents (asset-manager,
   * video-generation-coordinator, motion-compositing-coordinator) whose
   * complete implementations depend on later provider/asset/compositing
   * milestones. `executeAgent` refuses to run any definition with
   * `implemented: false` — see `AgentNotImplementedError`.
   */
  readonly implemented: boolean;
  /** Defense in depth alongside `implemented` — placeholders always set this true. */
  readonly disabledByDefault: boolean;
  /** Required when `implemented` is false; names the milestone that will implement it. */
  readonly futureMilestone?: string;

  readonly inputSchema: ZodType<TInput>;
  readonly resultSchema: ZodType<TResult>;

  readonly promptVersion: PromptTemplate;
  readonly modelPolicy: ModelPolicy;
  readonly tokenBudget: TokenBudget;
  readonly toolPolicy: ToolPolicy;

  /** Required for QA-category agents (requirement 13); absent for creative/planning agents. */
  readonly rubric?: QualityRubric;

  /**
   * Derives a rubric-scored `AgentEvaluation` from a successful result, for
   * QA-category agents whose result schema embeds pass/fail + per-criterion
   * scores (e.g. `visual-quality-controller`). Absent for agents with no
   * rubric.
   */
  readonly deriveEvaluation?: (result: TResult) => AgentEvaluation | null;

  /**
   * Names of agents whose creative output this agent is allowed to review or
   * gate. Must never include this agent's own `name` — enforced by a
   * registry-consistency test (requirement 12: "No agent can approve its own
   * creative work").
   */
  readonly reviewsOutputOf?: readonly string[];
}

export function defineAgent<TInput, TResult>(
  definition: AgentDefinition<TInput, TResult>,
): AgentDefinition<TInput, TResult> {
  if (definition.reviewsOutputOf?.includes(definition.name)) {
    throw new Error(
      `Agent "${definition.name}" lists itself in reviewsOutputOf — an agent may never review its own creative work.`,
    );
  }
  if (!definition.implemented && !definition.futureMilestone) {
    throw new Error(
      `Agent "${definition.name}" is marked unimplemented but has no futureMilestone recorded.`,
    );
  }
  if (!definition.implemented && !definition.disabledByDefault) {
    throw new Error(
      `Agent "${definition.name}" is unimplemented but not disabledByDefault — placeholders must be disabled by default.`,
    );
  }
  return definition;
}

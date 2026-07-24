/**
 * Every failure mode a specialist-agent invocation can produce, typed so the
 * orchestrator (a future Temporal Activity) can decide retry policy from the
 * error's shape rather than string-matching a message — see CLAUDE.md
 * "Bound retries explicitly ... escalate to a human state rather than
 * retrying forever" and requirement 7 ("Support retryable and non-retryable
 * failures").
 */
export type AgentFailureReason =
  | 'NOT_IMPLEMENTED'
  | 'DISABLED'
  | 'INPUT_INVALID'
  | 'SCHEMA_INVALID'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'BUDGET_EXCEEDED'
  | 'SELF_APPROVAL_FORBIDDEN';

/**
 * The persistable record of why an agent invocation failed — distinct from
 * the `Agent*Error` classes below, which are what gets *thrown* during
 * execution. `toAgentFailure` converts one into the other; `AgentRun.failure`
 * (see `agent-run.ts`) always holds this data shape, never a raw `Error`
 * instance, so it stays JSON-serializable for persistence.
 */
export interface AgentFailure {
  readonly reason: AgentFailureReason;
  readonly retryable: boolean;
  readonly message: string;
  readonly details?: unknown;
}

export abstract class AgentExecutionError extends Error {
  abstract readonly reason: AgentFailureReason;
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown when the orchestrator attempts to run an agent whose
 * `AgentDefinition.implemented` is false (the three deferred agents —
 * asset-manager, video-generation-coordinator, motion-compositing-coordinator
 * — pending later provider/asset/compositing milestones). Never retryable:
 * retrying does not make an unimplemented agent implemented.
 */
export class AgentNotImplementedError extends AgentExecutionError {
  readonly reason = 'NOT_IMPLEMENTED' as const;
  readonly retryable = false;

  constructor(agentName: string, futureMilestone: string) {
    super(
      `Agent "${agentName}" is not implemented yet (planned for ${futureMilestone}). ` +
        'It is registered as a typed placeholder only and must not be executed.',
      { agentName, futureMilestone },
    );
  }
}

/** Thrown when a disabled-by-default agent is invoked without an explicit enable. */
export class AgentDisabledError extends AgentExecutionError {
  readonly reason = 'DISABLED' as const;
  readonly retryable = false;

  constructor(agentName: string) {
    super(`Agent "${agentName}" is disabled by default and was not explicitly enabled.`, {
      agentName,
    });
  }
}

/** The caller-supplied input failed the agent's input schema — a caller bug, not a model error. */
export class AgentInputInvalidError extends AgentExecutionError {
  readonly reason = 'INPUT_INVALID' as const;
  readonly retryable = false;

  constructor(agentName: string, issues: unknown) {
    super(`Agent "${agentName}" received input that failed schema validation.`, issues);
  }
}

/**
 * The model's response failed schema validation even after one corrective
 * re-prompt (architecture.md §6). Non-retryable at this layer — the calling
 * Activity decides whether a whole-stage retry is warranted.
 */
export class AgentSchemaInvalidError extends AgentExecutionError {
  readonly reason = 'SCHEMA_INVALID' as const;
  readonly retryable = false;

  constructor(agentName: string, issues: unknown) {
    super(
      `Agent "${agentName}" produced output that failed schema validation after a corrective retry.`,
      issues,
    );
  }
}

/** The reasoning provider itself failed (network, 5xx, rate limit, malformed response envelope). */
export class AgentProviderError extends AgentExecutionError {
  readonly reason = 'PROVIDER_ERROR' as const;
  readonly retryable = true;

  constructor(agentName: string, cause: unknown) {
    super(`Agent "${agentName}"'s reasoning provider call failed.`, cause);
  }
}

/** The reasoning provider call exceeded its allotted time budget. */
export class AgentTimeoutError extends AgentExecutionError {
  readonly reason = 'TIMEOUT' as const;
  readonly retryable = true;

  constructor(agentName: string, timeoutMs: number) {
    super(`Agent "${agentName}" timed out after ${timeoutMs}ms.`, { timeoutMs });
  }
}

/** A budget check (workspace/campaign/shot/provider) failed before dispatch. */
export class AgentBudgetExceededError extends AgentExecutionError {
  readonly reason = 'BUDGET_EXCEEDED' as const;
  readonly retryable = false;

  constructor(agentName: string, details: unknown) {
    super(`Agent "${agentName}" was blocked by a budget check.`, details);
  }
}

/**
 * Thrown when an `AgentDefinition.reviewsOutputOf` would include the agent's
 * own name — the structural enforcement behind CLAUDE.md/requirement 12
 * ("No agent can approve its own creative work"). This should only ever fire
 * from a registry-consistency test, never at runtime, since it is checked at
 * definition time.
 */
export class AgentSelfApprovalForbiddenError extends AgentExecutionError {
  readonly reason = 'SELF_APPROVAL_FORBIDDEN' as const;
  readonly retryable = false;

  constructor(agentName: string) {
    super(`Agent "${agentName}" is configured to review its own output, which is forbidden.`, {
      agentName,
    });
  }
}

export function toAgentFailure(error: unknown): AgentFailure {
  if (error instanceof AgentExecutionError) {
    return {
      reason: error.reason,
      retryable: error.retryable,
      message: error.message,
      details: error.details,
    };
  }
  return {
    reason: 'PROVIDER_ERROR',
    retryable: true,
    message: error instanceof Error ? error.message : String(error),
  };
}

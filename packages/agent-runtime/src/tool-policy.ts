/**
 * Governs any *additional* tools an agent's reasoning call may use beyond
 * the mandatory structured-output tool the harness always attaches (see
 * `execute-agent.ts`). No specialist agent in this milestone calls an
 * external tool during reasoning — all context is supplied as validated
 * input by the calling Activity (architecture.md §2: "an agent's job is
 * reasoning over inputs it's given, not fetching its own data") — so every
 * current `AgentDefinition` uses `NO_TOOL_POLICY`. The type exists so a
 * future agent that legitimately needs one (e.g. a research tool) has a
 * place to declare and bound it rather than reaching for an unbounded tool
 * surface.
 */
export interface ToolPolicy {
  readonly allowedTools: readonly string[];
  readonly maxToolCalls: number;
}

export const NO_TOOL_POLICY: ToolPolicy = {
  allowedTools: [],
  maxToolCalls: 0,
};

/**
 * Scaffolding only — no specialist agent is implemented yet (explicit
 * instruction: "Do not implement business agents ... yet"). This lists the
 * fourteen specialist agents from docs/architecture.md so the workflow
 * orchestrator and dashboard have a stable name/id to reference before any of
 * them exist, and so each agent's future package/module lands in an agreed
 * slot rather than an ad hoc one.
 *
 * When an agent is implemented, it gets its own `src/<agent-name>/` module
 * exporting a `run(input: AgentInput<TIn>): Promise<AgentOutput<TOut>>`
 * built on the future agent-runtime package (see CLAUDE.md "Architecture
 * boundaries" — agents may not call other agents or the database directly).
 */
export const SPECIALIST_AGENT_NAMES = [
  'campaign-strategist',
  'creative-director',
  'script-timing-director',
  'asset-manager',
  'shot-prompt-engineer',
  'video-generation-coordinator',
  'visual-quality-controller',
  'continuity-controller',
  'motion-compositing-coordinator',
  'edit-director',
  'sound-director',
  'final-qa-controller',
  'variant-generator',
  'performance-analyst',
] as const;

export type SpecialistAgentName = (typeof SPECIALIST_AGENT_NAMES)[number];

export function isSpecialistAgentName(value: string): value is SpecialistAgentName {
  return (SPECIALIST_AGENT_NAMES as readonly string[]).includes(value);
}

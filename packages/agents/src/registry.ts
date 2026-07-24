import type { AgentDefinition } from '@combat/agent-runtime';
import { campaignStrategistAgent } from './campaign-strategist/agent';
import { creativeDirectorAgent } from './creative-director/agent';
import { scriptTimingDirectorAgent } from './script-timing-director/agent';
import { assetManagerAgent } from './asset-manager/agent';
import { shotPromptEngineerAgent } from './shot-prompt-engineer/agent';
import { videoGenerationCoordinatorAgent } from './video-generation-coordinator/agent';
import { visualQualityControllerAgent } from './visual-quality-controller/agent';
import { continuityControllerAgent } from './continuity-controller/agent';
import { motionCompositingCoordinatorAgent } from './motion-compositing-coordinator/agent';
import { editDirectorAgent } from './edit-director/agent';
import { soundDirectorAgent } from './sound-director/agent';
import { finalQaControllerAgent } from './final-qa-controller/agent';
import { variantGeneratorAgent } from './variant-generator/agent';
import { performanceAnalystAgent } from './performance-analyst/agent';

/**
 * The fourteen specialist agent names from docs/architecture.md, fixed by
 * the approved architecture — do not rename or add entries here without an
 * architecture-doc change (CLAUDE.md "Documentation expectations").
 * `script-timing-director` and `visual-quality-controller` are the
 * canonical identifiers; "Script Director" / "Visual QA Controller" are
 * display labels only (see each agent's `displayName`).
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

/**
 * The single source of truth mapping a canonical agent name to its
 * `AgentDefinition` — this is what "do not hardcode agents as informal
 * strings" means in practice: every caller looks an agent up here rather
 * than constructing prompts/schemas/model config inline.
 *
 * Eleven agents are fully implemented; three (`asset-manager`,
 * `video-generation-coordinator`, `motion-compositing-coordinator`) are
 * typed, registered, NOT_IMPLEMENTED placeholders pending later provider/
 * asset/compositing milestones — see each one's `agent.ts`.
 */
export const AGENT_REGISTRY: Readonly<Record<SpecialistAgentName, AgentDefinition<unknown, unknown>>> = {
  'campaign-strategist': campaignStrategistAgent as AgentDefinition<unknown, unknown>,
  'creative-director': creativeDirectorAgent as AgentDefinition<unknown, unknown>,
  'script-timing-director': scriptTimingDirectorAgent as AgentDefinition<unknown, unknown>,
  'asset-manager': assetManagerAgent as AgentDefinition<unknown, unknown>,
  'shot-prompt-engineer': shotPromptEngineerAgent as AgentDefinition<unknown, unknown>,
  'video-generation-coordinator': videoGenerationCoordinatorAgent as AgentDefinition<unknown, unknown>,
  'visual-quality-controller': visualQualityControllerAgent as AgentDefinition<unknown, unknown>,
  'continuity-controller': continuityControllerAgent as AgentDefinition<unknown, unknown>,
  'motion-compositing-coordinator': motionCompositingCoordinatorAgent as AgentDefinition<unknown, unknown>,
  'edit-director': editDirectorAgent as AgentDefinition<unknown, unknown>,
  'sound-director': soundDirectorAgent as AgentDefinition<unknown, unknown>,
  'final-qa-controller': finalQaControllerAgent as AgentDefinition<unknown, unknown>,
  'variant-generator': variantGeneratorAgent as AgentDefinition<unknown, unknown>,
  'performance-analyst': performanceAnalystAgent as AgentDefinition<unknown, unknown>,
};

export function getAgentDefinition(name: SpecialistAgentName): AgentDefinition<unknown, unknown> {
  return AGENT_REGISTRY[name];
}

// Re-export the fully-typed definitions too, for callers that already know
// which agent they want and would rather not lose type information through
// the `unknown`-erased registry map above.
export {
  campaignStrategistAgent,
  creativeDirectorAgent,
  scriptTimingDirectorAgent,
  assetManagerAgent,
  shotPromptEngineerAgent,
  videoGenerationCoordinatorAgent,
  visualQualityControllerAgent,
  continuityControllerAgent,
  motionCompositingCoordinatorAgent,
  editDirectorAgent,
  soundDirectorAgent,
  finalQaControllerAgent,
  variantGeneratorAgent,
  performanceAnalystAgent,
};

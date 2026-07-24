import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { definePlaceholderPrompt } from '../shared/placeholder-prompt';
import {
  MotionCompositingCoordinatorInputSchema,
  MotionCompositingCoordinatorResultSchema,
} from './schema';

const FUTURE_MILESTONE =
  'M9 — Compositing & rough edit (needs MotionGraphicsProvider + DesignProvider wiring)';

/** NOT_IMPLEMENTED placeholder — see `asset-manager/agent.ts` for the pattern this follows. */
export const motionCompositingCoordinatorAgent = defineAgent({
  name: 'motion-compositing-coordinator',
  displayName: 'Motion-Compositing Coordinator',
  description:
    'Plans After Effects/Figma compositing per shot. Not implemented — see futureMilestone.',
  implemented: false,
  disabledByDefault: true,
  futureMilestone: FUTURE_MILESTONE,
  inputSchema: MotionCompositingCoordinatorInputSchema,
  resultSchema: MotionCompositingCoordinatorResultSchema,
  promptVersion: definePlaceholderPrompt('motion-compositing-coordinator', FUTURE_MILESTONE),
  modelPolicy: DEFAULT_MODEL_POLICY,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

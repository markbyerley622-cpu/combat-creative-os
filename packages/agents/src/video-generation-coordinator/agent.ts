import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { definePlaceholderPrompt } from '../shared/placeholder-prompt';
import {
  VideoGenerationCoordinatorInputSchema,
  VideoGenerationCoordinatorResultSchema,
} from './schema';

const FUTURE_MILESTONE =
  'M6 — Video generation (needs a real video-gen provider dispatch/budget contract)';

/** NOT_IMPLEMENTED placeholder — see `asset-manager/agent.ts` for the pattern this follows. */
export const videoGenerationCoordinatorAgent = defineAgent({
  name: 'video-generation-coordinator',
  displayName: 'Video Generation Coordinator',
  description:
    'Plans generation-job dispatch across shots/providers. Not implemented — see futureMilestone.',
  implemented: false,
  disabledByDefault: true,
  futureMilestone: FUTURE_MILESTONE,
  inputSchema: VideoGenerationCoordinatorInputSchema,
  resultSchema: VideoGenerationCoordinatorResultSchema,
  promptVersion: definePlaceholderPrompt('video-generation-coordinator', FUTURE_MILESTONE),
  modelPolicy: DEFAULT_MODEL_POLICY,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

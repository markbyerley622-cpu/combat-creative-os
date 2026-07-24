import { DEFAULT_MODEL_POLICY, DEFAULT_TOKEN_BUDGET, NO_TOOL_POLICY, defineAgent } from '@combat/agent-runtime';
import { definePlaceholderPrompt } from '../shared/placeholder-prompt';
import { AssetManagerInputSchema, AssetManagerResultSchema } from './schema';

const FUTURE_MILESTONE =
  'post-M6 (requires a brand asset-library provider category not yet designed in docs/architecture.md §5)';

/**
 * NOT_IMPLEMENTED placeholder. `implemented: false` + `disabledByDefault:
 * true` mean `executeAgent` refuses to run this definition — see
 * `AgentNotImplementedError` in `@combat/agent-runtime` and
 * `placeholder-agents.test.ts` for the tests proving this can't be invoked
 * accidentally.
 */
export const assetManagerAgent = defineAgent({
  name: 'asset-manager',
  displayName: 'Asset Manager',
  description: 'Plans required brand/licensed assets per shot. Not implemented — see futureMilestone.',
  implemented: false,
  disabledByDefault: true,
  futureMilestone: FUTURE_MILESTONE,
  inputSchema: AssetManagerInputSchema,
  resultSchema: AssetManagerResultSchema,
  promptVersion: definePlaceholderPrompt('asset-manager', FUTURE_MILESTONE),
  modelPolicy: DEFAULT_MODEL_POLICY,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

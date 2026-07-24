import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { CampaignStrategistInputSchema, CampaignStrategistResultSchema } from './schema';
import { V1 } from './prompts/v1';

export const campaignStrategistAgent = defineAgent({
  name: 'campaign-strategist',
  displayName: 'Campaign Strategist',
  description: 'Turns a validated campaign brief into an audience profile and creative strategy.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: CampaignStrategistInputSchema,
  resultSchema: CampaignStrategistResultSchema,
  promptVersion: V1,
  modelPolicy: { ...DEFAULT_MODEL_POLICY, effort: 'high' },
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

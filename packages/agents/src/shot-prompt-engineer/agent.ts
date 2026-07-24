import { DEFAULT_MODEL_POLICY, DEFAULT_TOKEN_BUDGET, NO_TOOL_POLICY, defineAgent } from '@combat/agent-runtime';
import { ShotPromptEngineerInputSchema, ShotPromptEngineerResultSchema } from './schema';
import { V1 } from './prompts/v1';

export const shotPromptEngineerAgent = defineAgent({
  name: 'shot-prompt-engineer',
  displayName: 'Shot Prompt Engineer',
  description: 'Translates one script shot into a provider-ready video-generation prompt.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: ShotPromptEngineerInputSchema,
  resultSchema: ShotPromptEngineerResultSchema,
  promptVersion: V1,
  modelPolicy: DEFAULT_MODEL_POLICY,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

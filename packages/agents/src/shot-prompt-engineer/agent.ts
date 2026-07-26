import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { ShotPromptEngineerInputSchema, ShotPromptEngineerResultSchema } from './schema';
import { V3 } from './prompts/v3';

export const shotPromptEngineerAgent = defineAgent({
  name: 'shot-prompt-engineer',
  displayName: 'Shot Prompt Engineer',
  description: 'Translates one script shot into a complete, provider-ready generation brief.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: ShotPromptEngineerInputSchema,
  resultSchema: ShotPromptEngineerResultSchema,
  promptVersion: V3,
  modelPolicy: DEFAULT_MODEL_POLICY,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

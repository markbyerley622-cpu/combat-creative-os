import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { CreativeDirectorInputSchema, CreativeDirectorResultSchema } from './schema';
import { V4 } from './prompts/v4';

export const creativeDirectorAgent = defineAgent({
  name: 'creative-director',
  displayName: 'Creative Director',
  description: 'Turns an approved creative strategy into one concrete creative concept.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: CreativeDirectorInputSchema,
  resultSchema: CreativeDirectorResultSchema,
  promptVersion: V4,
  modelPolicy: { ...DEFAULT_MODEL_POLICY, effort: 'high' },
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

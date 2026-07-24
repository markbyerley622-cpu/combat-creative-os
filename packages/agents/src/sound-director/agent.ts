import { DEFAULT_MODEL_POLICY, DEFAULT_TOKEN_BUDGET, NO_TOOL_POLICY, defineAgent } from '@combat/agent-runtime';
import { SoundDirectorInputSchema, SoundDirectorResultSchema } from './schema';
import { V1 } from './prompts/v1';

export const soundDirectorAgent = defineAgent({
  name: 'sound-director',
  displayName: 'Sound Director',
  description: 'Produces a sound design plan (music brief, mix notes, cues) from the edit timeline.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: SoundDirectorInputSchema,
  resultSchema: SoundDirectorResultSchema,
  promptVersion: V1,
  modelPolicy: DEFAULT_MODEL_POLICY,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

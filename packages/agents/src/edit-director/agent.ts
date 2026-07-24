import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { EditDirectorInputSchema, EditDirectorResultSchema } from './schema';
import { V1 } from './prompts/v1';

export const editDirectorAgent = defineAgent({
  name: 'edit-director',
  displayName: 'Edit Director',
  description: 'Produces a rough-edit timeline plan from human-selected shots.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: EditDirectorInputSchema,
  resultSchema: EditDirectorResultSchema,
  promptVersion: V1,
  modelPolicy: DEFAULT_MODEL_POLICY,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

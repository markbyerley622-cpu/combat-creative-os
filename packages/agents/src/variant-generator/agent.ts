import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { VariantGeneratorInputSchema, VariantGeneratorResultSchema } from './schema';
import { V1 } from './prompts/v1';

export const variantGeneratorAgent = defineAgent({
  name: 'variant-generator',
  displayName: 'Variant Generator',
  description: 'Cuts an approved final master down to a shorter target duration for a platform.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: VariantGeneratorInputSchema,
  resultSchema: VariantGeneratorResultSchema,
  promptVersion: V1,
  modelPolicy: { ...DEFAULT_MODEL_POLICY, effort: 'low', thinking: 'disabled' },
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

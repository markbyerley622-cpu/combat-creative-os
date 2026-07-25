import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { VariantGeneratorInputSchema, VariantGeneratorResultSchema } from './schema';
import { V2 } from './prompts/v2';

export const variantGeneratorAgent = defineAgent({
  name: 'variant-generator',
  displayName: 'Variant Generator',
  description:
    "Re-cuts an approved final master down to a shorter delivery duration, using only the master timeline's existing segment boundaries.",
  implemented: true,
  disabledByDefault: false,
  inputSchema: VariantGeneratorInputSchema,
  resultSchema: VariantGeneratorResultSchema,
  promptVersion: V2,
  modelPolicy: { ...DEFAULT_MODEL_POLICY, effort: 'low', thinking: 'disabled' },
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { PerformanceAnalystInputSchema, PerformanceAnalystResultSchema } from './schema';
import { V2 } from './prompts/v2';

export const performanceAnalystAgent = defineAgent({
  name: 'performance-analyst',
  displayName: 'Performance Analyst',
  description:
    'Distills closed-window performance observations into evidence-cited, reusable creative learnings.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: PerformanceAnalystInputSchema,
  resultSchema: PerformanceAnalystResultSchema,
  promptVersion: V2,
  modelPolicy: DEFAULT_MODEL_POLICY,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

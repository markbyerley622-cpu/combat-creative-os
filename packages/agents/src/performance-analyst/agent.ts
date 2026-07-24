import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { PerformanceAnalystInputSchema, PerformanceAnalystResultSchema } from './schema';
import { V1 } from './prompts/v1';

export const performanceAnalystAgent = defineAgent({
  name: 'performance-analyst',
  displayName: 'Performance Analyst',
  description: 'Distills per-platform performance metrics into reusable Learnings.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: PerformanceAnalystInputSchema,
  resultSchema: PerformanceAnalystResultSchema,
  promptVersion: V1,
  modelPolicy: DEFAULT_MODEL_POLICY,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
});

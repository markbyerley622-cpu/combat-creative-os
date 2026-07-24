import { DEFAULT_MODEL_POLICY, DEFAULT_TOKEN_BUDGET, NO_TOOL_POLICY, defineAgent } from '@combat/agent-runtime';
import { CONTINUITY_RUBRIC } from '../shared/rubrics';
import { ContinuityControllerInputSchema, ContinuityControllerResultSchema } from './schema';
import { V1 } from './prompts/v1';

export const continuityControllerAgent = defineAgent({
  name: 'continuity-controller',
  displayName: 'Continuity Controller',
  description: 'Assesses cross-shot continuity for all candidates selected so far in a script.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: ContinuityControllerInputSchema,
  resultSchema: ContinuityControllerResultSchema,
  promptVersion: V1,
  modelPolicy: { ...DEFAULT_MODEL_POLICY, effort: 'high' },
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
  rubric: CONTINUITY_RUBRIC,
  reviewsOutputOf: ['shot-prompt-engineer', 'visual-quality-controller'],
  deriveEvaluation: (result) => ({
    rubricId: CONTINUITY_RUBRIC.id,
    overallPass: result.criterionScores.every((criterion) => criterion.pass),
    criterionScores: result.criterionScores,
  }),
});

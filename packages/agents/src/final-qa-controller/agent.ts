import { DEFAULT_MODEL_POLICY, DEFAULT_TOKEN_BUDGET, NO_TOOL_POLICY, defineAgent } from '@combat/agent-runtime';
import { FINAL_QA_RUBRIC } from '../shared/rubrics';
import { FinalQaControllerInputSchema, FinalQaControllerResultSchema } from './schema';
import { V1 } from './prompts/v1';

export const finalQaControllerAgent = defineAgent({
  name: 'final-qa-controller',
  displayName: 'Final QA Controller',
  description: 'Assesses a finished master against the Final QA rubric before human Final Approval.',
  implemented: true,
  disabledByDefault: false,
  inputSchema: FinalQaControllerInputSchema,
  resultSchema: FinalQaControllerResultSchema,
  promptVersion: V1,
  modelPolicy: { ...DEFAULT_MODEL_POLICY, effort: 'high' },
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
  rubric: FINAL_QA_RUBRIC,
  reviewsOutputOf: ['edit-director', 'sound-director', 'motion-compositing-coordinator'],
  deriveEvaluation: (result) => ({
    rubricId: FINAL_QA_RUBRIC.id,
    overallPass: result.criterionScores.every((criterion) => criterion.pass),
    criterionScores: result.criterionScores,
  }),
});

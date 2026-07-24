import {
  DEFAULT_MODEL_POLICY,
  DEFAULT_TOKEN_BUDGET,
  NO_TOOL_POLICY,
  defineAgent,
} from '@combat/agent-runtime';
import { VISUAL_QC_RUBRIC } from '../shared/rubrics';
import { VisualQualityControllerInputSchema, VisualQualityControllerResultSchema } from './schema';
import { V1 } from './prompts/v1';

/**
 * Canonical registry id is `visual-quality-controller` (preserved from the
 * approved architecture); "Visual QA Controller" is a display label only.
 */
export const visualQualityControllerAgent = defineAgent({
  name: 'visual-quality-controller',
  displayName: 'Visual QA Controller',
  description: "Assesses one generated candidate's frames against the Visual QC rubric.",
  implemented: true,
  disabledByDefault: false,
  inputSchema: VisualQualityControllerInputSchema,
  resultSchema: VisualQualityControllerResultSchema,
  promptVersion: V1,
  modelPolicy: { ...DEFAULT_MODEL_POLICY, effort: 'high' },
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  toolPolicy: NO_TOOL_POLICY,
  rubric: VISUAL_QC_RUBRIC,
  // Reviews the output of the agents that produced the prompt/dispatch —
  // never its own output (requirement 12; enforced structurally by
  // defineAgent, which throws if `name` ever appears in this list).
  reviewsOutputOf: ['shot-prompt-engineer', 'video-generation-coordinator'],
  deriveEvaluation: (result) => ({
    rubricId: VISUAL_QC_RUBRIC.id,
    overallPass: result.criterionScores.every((criterion) => criterion.pass),
    criterionScores: result.criterionScores,
  }),
});

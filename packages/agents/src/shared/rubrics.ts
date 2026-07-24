import type { QualityRubric } from '@combat/agent-runtime';

/**
 * Explicit rubrics QA-category agents evaluate against (requirement 13).
 * Each criterion is scored independently by the agent's structured output
 * (`criterionScores`); `AgentDefinition.deriveEvaluation` computes
 * `overallPass` as the AND of every criterion rather than trusting a
 * separately-stated boolean the model could contradict.
 */
export const VISUAL_QC_RUBRIC: QualityRubric = {
  id: 'visual-qc-v1',
  criteria: [
    {
      id: 'subject-fidelity',
      description: 'The generated frames depict the subject described in the shot, not something else.',
      weight: 1,
    },
    {
      id: 'motion-coherence',
      description: 'No impossible motion, morphing artifacts, or physically incoherent movement.',
      weight: 1,
    },
    {
      id: 'resolution-clarity',
      description: 'The candidate is sharp enough to use; not garbled, blurred, or corrupted.',
      weight: 1,
    },
    {
      id: 'brand-safety',
      description: 'No content that would be unsafe or off-brand for Combat Reviews to publish.',
      weight: 1,
    },
  ],
};

export const CONTINUITY_RUBRIC: QualityRubric = {
  id: 'continuity-v1',
  criteria: [
    {
      id: 'visual-consistency',
      description:
        'Color grade, lighting style, and subject appearance are consistent across the shots being compared.',
      weight: 1,
    },
    {
      id: 'narrative-continuity',
      description: 'Shot order and content do not contradict the established narrative arc.',
      weight: 1,
    },
  ],
};

export const FINAL_QA_RUBRIC: QualityRubric = {
  id: 'final-qa-v1',
  criteria: [
    {
      id: 'technical-delivery-spec',
      description: 'Duration, resolution, and loudness match the delivery specification exactly.',
      weight: 1,
    },
    {
      id: 'caption-compliance',
      description: 'Caption burn-in is present when the delivery specification requires it.',
      weight: 1,
    },
    {
      id: 'visual-brand-safety',
      description: 'No content that would be unsafe or off-brand for Combat Reviews to publish.',
      weight: 1,
    },
    {
      id: 'edit-continuity',
      description: 'Cuts and transitions are clean; no dropped frames, freezes, or audio/video desync.',
      weight: 1,
    },
  ],
};

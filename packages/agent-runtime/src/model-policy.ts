/**
 * Which Claude model an agent calls and how hard it should think. Kept
 * per-agent (not global) because QA/mechanical agents (variant-generator,
 * sound-director) don't need the same effort level as open-ended creative
 * reasoning (campaign-strategist, creative-director).
 *
 * `thinking: 'adaptive'` maps to Claude's adaptive-thinking mode; `'disabled'`
 * is for agents whose task is narrow enough that thinking only adds latency.
 */
export interface ModelPolicy {
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly thinking: 'adaptive' | 'disabled';
}

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  model: 'claude-opus-4-8',
  effort: 'medium',
  thinking: 'adaptive',
};

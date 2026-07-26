import {
  COMBAT_REVIEWS_CONCEPT_RESULT,
  COMBAT_REVIEWS_SCRIPT_RESULT,
  COMBAT_REVIEWS_SHOT_PROMPT_RESULT,
  COMBAT_REVIEWS_STRATEGY_RESULT,
} from '@combat/agents';
import { createQueuedReasoningProvider } from '@combat/agent-runtime';
import type { ReasoningProvider } from '@combat/providers';

/**
 * Deterministic creative for local runs with no paid API key.
 *
 * `MockReasoningProvider` cannot drive this chain: it returns an empty echo
 * shape, so every agent fails schema validation. But CLAUDE.md requires that
 * mock mode keeps working with "no external services and no paid
 * credentials", and a command that cannot run at all without an
 * `ANTHROPIC_API_KEY` would not satisfy that. So `REASONING_PROVIDER=mock`
 * replays the committed golden results for the Combat Reviews 15s brief, in
 * the order the pipeline calls the agents.
 *
 * **This is canned creative, not generated creative.** The fixtures ignore the
 * manifest's prompt entirely — the same four results come back whatever the
 * brief says. That makes the plumbing exercisable end to end and makes the
 * creative output meaningless, so the CLI is required to say so on every run
 * (`FIXTURE_CREATIVE_WARNING`). Anything evaluating actual creative quality
 * must use `REASONING_PROVIDER=claude`.
 */

export const FIXTURE_CREATIVE_WARNING =
  'REASONING_PROVIDER=mock: replaying committed golden agent results for the Combat Reviews brief. The creative is canned and ignores this manifest’s prompt — set REASONING_PROVIDER=claude to generate it for real.';

/**
 * Queued in call order: strategist, creative director, script/timing director,
 * then one shot-prompt result per shot the pipeline briefs.
 */
export function createFixtureReasoningProvider(shotCount: number): ReasoningProvider {
  return createQueuedReasoningProvider([
    { result: COMBAT_REVIEWS_STRATEGY_RESULT },
    { result: COMBAT_REVIEWS_CONCEPT_RESULT },
    { result: COMBAT_REVIEWS_SCRIPT_RESULT },
    ...Array.from({ length: Math.max(1, shotCount) }, () => ({
      result: COMBAT_REVIEWS_SHOT_PROMPT_RESULT,
    })),
  ]);
}

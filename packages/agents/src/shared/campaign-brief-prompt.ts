import { definePromptTemplate, type PromptTemplate } from '@combat/agent-runtime';

/**
 * The instruction block that teaches an agent what to do with the two fields
 * this milestone added to every planning agent's input: the requester's
 * verbatim `campaignPrompt` and the binding `factualConstraints`.
 *
 * Kept in one place because the guidance must be identical across the four
 * planning agents — if the Strategist and the Script Director disagree about
 * whether a fact is binding, the resulting ad contradicts itself.
 */
export const CAMPAIGN_BRIEF_ADDENDUM = `
# Campaign Brief and Factual Constraints
Two additional input fields may be present. Both are authoritative.

- campaignPrompt: the requester's brief in their own words, verbatim. This is the
  canonical statement of what the advertisement is for. Every other field
  (objective, keyMessages, visualDirection) is a *derived summary* of it — where
  a summary is thinner than the brief, the brief wins. Read it for specifics a
  summary cannot carry: the particular hook asked for, the order of ideas, the
  tone, the thing the requester obviously cares about.
- factualConstraints: verifiable product and event facts, each prefixed
  "PRODUCT — " or "EVENT — ". Treat every one as established fact about a real
  product and real scheduled events.

Rules:
- Ground the work in the brief. If the brief asks for a specific opening, a
  specific sequence of ideas, or a specific closing action, honour it.
- Never contradict a factual constraint, and never invent a competing fact of
  the same kind (a different event count, a different feature name, a different
  price). If the brief and a constraint disagree, follow the constraint and
  record the conflict in reasoning.assumptions.
- Do not simply restate the brief back. Your job is to advance it into your own
  stage's output.
- Do not name, imitate, or reference any advertising agency, studio or existing
  campaign as a style target. Express creative intent as explicit properties —
  pacing, contrast, framing, typography, rhythm — not as "make it like X".
- Cite in reasoning.facts which factual constraints you actually used.`;

/**
 * Builds a new prompt version by appending the brief-handling guidance to an
 * earlier, immutable version.
 *
 * Composition rather than copy-paste: the four agents' base prompts are long
 * and unrelated to each other, and duplicating each in full to add one shared
 * section would guarantee they drift. The earlier version stays byte-for-byte
 * reconstructible because it is still its own file and is never edited — and
 * `prompts.snapshot.test.ts` snapshots the *composed* text, so any change to
 * either half is caught in review.
 */
export function withCampaignBrief(
  base: PromptTemplate,
  version: number,
  changelog: string,
): PromptTemplate {
  return definePromptTemplate({
    version,
    changelog,
    systemPrompt: `${base.systemPrompt}\n${CAMPAIGN_BRIEF_ADDENDUM}`,
  });
}

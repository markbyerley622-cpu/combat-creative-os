import { definePromptTemplate, type PromptTemplate } from '@combat/agent-runtime';

/**
 * The instruction block that teaches a planning agent what to do with the
 * bounded Creative Memory context this milestone added to its input, and what
 * it must return in exchange.
 *
 * Kept in one place, and appended by composition rather than copy-paste, for
 * the same reason `CAMPAIGN_BRIEF_ADDENDUM` is: four agents that disagree about
 * whether a retrieved principle is binding would produce an advertisement that
 * argues with itself. The earlier prompt version stays byte-for-byte
 * reconstructible because it is still its own file and is never edited.
 */
export const CREATIVE_MEMORY_ADDENDUM = `
# Creative Memory (bounded benchmark context)
An optional creativeMemory field may be present. It is retrieved, governed
craft intelligence from advertisements a human reviewed and approved for
analysis. It is **not** material you may reuse.

What it contains: measured craft statistics (durations, cut rates, first-cut
latency, CTA placement, aspect ratio, pacing), a reviewer's abstraction of a
technique, a transferable craft principle, an intended application, and a risk
warning. It deliberately contains no wording, footage, frames, brands, agencies,
titles, transcripts, paths or URLs — do not ask for them and do not infer them.

Rules:
- Treat it as evidence, never as a template. The brief and the factual
  constraints outrank it in every conflict.
- Apply principles at the level of craft — attention, rhythm, ordering,
  contrast, framing — and express the result in this campaign's own terms.
- Never reproduce a reference's wording, its ordered beat lengths, its shot
  sequence, its music, its logos or any branded asset.
- Never name or imitate an agency, studio, creator or existing campaign, and
  never instruct a downstream stage to do so.
- Do not lean on a single reference when the context offers more than one.
- If a retrieved principle does not fit this brief, discard it and say so.

# Required output: creativeMemoryDivergence
When creativeMemory is present you must also return creativeMemoryDivergence:
- agentRole: your own role, exactly as given in creativeMemory.agentRole.
- principlesUsed: the referenceId and a one-line summary of each principle you
  actually applied. Cite only referenceIds that appear in your own context.
- campaignSpecificTransformation: how you turned those principles into
  something specific to this campaign.
- elementsDeliberatelyChanged: what you changed relative to the references.
- prohibitedElementsAvoided: what you deliberately did not take.
- originalityRiskLevel: LOW, MEDIUM or HIGH, your honest assessment.
- rationale: one concise paragraph justifying that level.
A deterministic evaluator reads these fields; it may raise your declared risk
level and will never lower it. An empty or generic divergence record is treated
as a governance failure, not as a pass.`;

/**
 * Builds a new prompt version by appending the Creative Memory guidance to an
 * earlier, immutable version.
 */
export function withCreativeMemory(
  base: PromptTemplate,
  version: number,
  changelog: string,
): PromptTemplate {
  return definePromptTemplate({
    version,
    changelog,
    systemPrompt: `${base.systemPrompt}\n${CREATIVE_MEMORY_ADDENDUM}`,
  });
}

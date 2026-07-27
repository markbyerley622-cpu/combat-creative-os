import { definePromptTemplate, type PromptTemplate } from '@combat/agent-runtime';

/**
 * The instruction blocks for product-launch campaigns.
 *
 * Two blocks, appended by composition for the same reason
 * `CAMPAIGN_BRIEF_ADDENDUM` is: the constraints have to be identical across the
 * four planning agents, and duplicating long prompts to add a shared section
 * guarantees they drift.
 *
 * `PRODUCT_LAUNCH_ADDENDUM` goes to all four planning agents — it carries the
 * positioning, the perception target, the brand voice and, above all, the
 * prohibited claims, which have to reach the agent that writes on-screen copy
 * just as much as the one that writes strategy.
 *
 * `LAUNCH_CONCEPT_ADDENDUM` goes only to the Creative Director, because only it
 * produces concepts. It describes the structured concept contract and the one
 * thing that makes a competition a competition: each candidate must occupy a
 * different structural position from the ones already taken.
 */
export const PRODUCT_LAUNCH_ADDENDUM = `
# Product Launch Campaigns
An optional productLaunch field may be present. When it is, this campaign is a
PRODUCT_LAUNCH: it exists to introduce and showcase the product and the brand
itself. It is not an event promotion, not a dated offer, and not a
direct-response advertisement — do not write it as one.

Fields, all authoritative:
- positioning: what the product is positioned as. Your work advances it; it does
  not restate it.
- desiredAudiencePerception: what the audience should believe afterwards. This
  is distinct from the objective, which is what they should do.
- prohibitedClaims: claims that must never be made, in any wording, however
  indirect. A rephrasing that lands the same claim is still that claim.
- creativeConstraints: non-negotiable direction from the requester.
- brandIdentity: voice, personalityAttributes and prohibitedTone. Registers in
  prohibitedTone are forbidden outright.
- requiredVariants: cutdowns this campaign must eventually support. The work
  must survive the shortest one.

Rules:
- Never invent a product feature, capability, screen, integration, statistic or
  outcome. If it is not in factualConstraints, it does not exist.
- Never make, imply or set up a prohibited claim, and never instruct a
  downstream stage to make one.
- Honour brandIdentity.voice in every line you write.
- Say in reasoning.assumptions if the brief and the launch constraints pull in
  different directions; do not resolve it silently.`;

export const LAUNCH_CONCEPT_ADDENDUM = `
# Launch Concept Competition
When productLaunch and launchDirective are both present you are producing one
candidate in a competing set, and you must additionally return launchConcept.

launchDirective tells you:
- candidateIndex and candidateCount: which slot you are filling.
- occupiedStructuralPositions: axis=value positions earlier candidates in this
  same set already took.
- occupiedTitles: titles already used.

Your candidate must be a genuinely different idea, not the previous one
rephrased. Concretely: choose values for the seven structural axes such that
your candidate differs from every occupied position on at least three of the
eight comparison axes (the seven below plus the central idea), and write a
central idea that shares little vocabulary with the ones already taken. A
deterministic comparison enforces this and will reject the whole set if the
candidates are superficial rewrites of each other.

launchConcept contract:
- conceptSchemaVersion: 1.
- title: short, specific to this idea.
- centralIdea: the single idea the whole advertisement rests on.
- intendedAudienceResponse: what the viewer should feel and think.
- The seven structural axes — narrativeStructure, emotionalArc,
  productPresence, interfacePresentation, pacing, soundDesign, endFrame — each
  as { kind, direction }. kind is one value from that axis's closed vocabulary;
  direction is your own concrete direction for it, in your own words.
- combatCultureRelationship: how combat culture and the product relate in this
  concept, not merely that both appear.
- cinematographyDirection, motionDesignDirection, typographyDirection: concrete
  enough for a Script Director and a Shot Prompt Engineer to work from.
- assetRoleRequirements: the asset roles this concept needs, each REQUIRED or
  PREFERRED, with the purpose it serves.
- factualProductClaims: every claim the advertisement will make, each citing the
  factId of the factualConstraint that makes it true. On this path each
  factualConstraints line carries its own id in brackets — "PRODUCT [some-id] —
  Label: detail" — and factId is exactly that bracketed id. A claim with no
  supporting fact is an invented claim; do not write one.
- prohibitedImplications: what this concept must never be read as implying.
- originalityRationale: why this is your own work.
- referencePatternProvenance: for each craft pattern you took from Creative
  Memory, the referenceId it came from and how you applied it. Cite only
  referenceIds present in your own creativeMemory context, and leave this empty
  when you were given none.
- feasibility: confidence, the capture ids the concept cannot be produced
  without, the risks, and how it survives the shortest required variant.

Rules:
- Do not write a script, a shot list, frame counts or timings — those are later
  stages' work. Direction, not execution.
- Do not propose or imply approval of your own concept. A named human selects
  one, and that decision is not yours.
- Do not describe a screen, feature or capability that the factual constraints
  and the supplied capture inventory do not establish.`;

/** Appends the shared product-launch constraints to an earlier, immutable version. */
export function withProductLaunch(
  base: PromptTemplate,
  version: number,
  changelog: string,
): PromptTemplate {
  return definePromptTemplate({
    version,
    changelog,
    systemPrompt: `${base.systemPrompt}\n${PRODUCT_LAUNCH_ADDENDUM}`,
  });
}

/** The Creative Director's version: the shared constraints plus the concept contract. */
export function withLaunchConceptCompetition(
  base: PromptTemplate,
  version: number,
  changelog: string,
): PromptTemplate {
  return definePromptTemplate({
    version,
    changelog,
    systemPrompt: `${base.systemPrompt}\n${PRODUCT_LAUNCH_ADDENDUM}\n${LAUNCH_CONCEPT_ADDENDUM}`,
  });
}

import type { CampaignStrategistResult } from '@combat/agents';
import {
  LAUNCH_ASSESSMENT_NOTICE,
  LAUNCH_ASSET_ROLES,
  type LaunchAssetFeasibility,
  type LaunchAssetRole,
  type LaunchConcept,
  type LaunchConceptAssessment,
  type LaunchDimensionAssessment,
  type LaunchGoverningProfile,
  type OriginalityAssessment,
  type OriginalityEvaluationEntry,
  type ProductLaunchBrief,
} from '@combat/domain';

import type { CampaignRequest } from '../campaign-request';
import { ASSET_ROLES, type AssetRole, type ProductionAsset } from '../production-assets';
import type { ConceptCandidate } from './concept-competition';

/**
 * Benchmark assessment of one concept, as decision support for the reviewer.
 *
 * The line this module refuses to cross is the one between *measuring* and
 * *judging*. Six dimensions are decided here because there is something real to
 * decide them from: the approved asset inventory, the approved capture
 * inventory, the delivery platform, the requested durations, the concept's own
 * cited facts and the deterministic originality evaluator's verdict. The other
 * four — strategic clarity, emotional impact, brand distinctiveness, narrative
 * coherence — are craft judgements, and this system says so rather than
 * inventing a score that would look like evidence in a review meeting.
 *
 * Nothing here predicts performance, and nothing here can call a concept
 * agency quality: `agencyGradeClaim` is a literal with one value.
 */

/**
 * The concept vocabulary and the production register must name the same asset
 * roles. `packages/domain` cannot import the production register, so the
 * equality is asserted here, in both directions, at compile time.
 */
const _roleVocabularyIsShared: readonly LaunchAssetRole[] = ASSET_ROLES;
const _roleVocabularyIsSharedBack: readonly AssetRole[] = LAUNCH_ASSET_ROLES;
void _roleVocabularyIsShared;
void _roleVocabularyIsSharedBack;

const SHORT_FORM_PLATFORMS: readonly string[] = ['TIKTOK', 'INSTAGRAM_REELS', 'YOUTUBE_SHORTS'];
/** The longest cut these vertical feeds reliably carry, as a suitability signal only. */
const SHORT_FORM_CEILING_SECONDS = 60;

export interface LaunchInventory {
  readonly assets: readonly ProductionAsset[];
  readonly outputEligibleCaptureIds: ReadonlySet<string>;
  readonly reviewRequiredCaptureIds: ReadonlySet<string>;
}

function normalisedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * The concept's own assertive prose.
 *
 * `prohibitedImplications` is deliberately excluded, for the same reason the
 * agent-safe walk exempts prohibition fields: it is where the agent states what
 * the concept must never be read as implying, so it necessarily quotes the
 * prohibition, and scanning it would flag exactly the compliance that was asked
 * for.
 */
export function conceptAssertions(concept: LaunchConcept): readonly string[] {
  return [
    concept.title,
    concept.centralIdea,
    concept.intendedAudienceResponse,
    concept.narrativeStructure.direction,
    concept.emotionalArc.direction,
    concept.productPresence.direction,
    concept.interfacePresentation.direction,
    concept.pacing.direction,
    concept.soundDesign.direction,
    concept.endFrame.direction,
    concept.combatCultureRelationship,
    concept.cinematographyDirection,
    concept.motionDesignDirection,
    concept.typographyDirection,
    ...concept.factualProductClaims.map((claim) => claim.claim),
  ];
}

/**
 * Prohibited claims the concept states outright.
 *
 * Contiguous word-sequence containment after normalisation: precise enough to
 * be explainable to whoever wrote the concept, and deliberately not a
 * similarity score — "0.71 similar to a prohibited claim" is not something a
 * reviewer can act on, and a threshold nobody can justify is not governance.
 * A claim expressed in different words is a judgement, and a human makes it.
 */
export function findProhibitedClaimEchoes(
  concept: LaunchConcept,
  prohibitedClaims: readonly string[],
): readonly string[] {
  const assertions = conceptAssertions(concept).map(normalisedWords);
  return prohibitedClaims.filter((claim) => {
    const needle = normalisedWords(claim);
    return needle.length > 0 && assertions.some((words) => containsSequence(words, needle));
  });
}

/** What the approved inventory can actually supply, by role. */
function assetIdsByRole(assets: readonly ProductionAsset[]): Map<AssetRole, string[]> {
  const byRole = new Map<AssetRole, string[]>();
  for (const asset of assets) {
    byRole.set(asset.role, [...(byRole.get(asset.role) ?? []), asset.id]);
  }
  return byRole;
}

export function assessAssetFeasibility(
  concept: LaunchConcept,
  inventory: LaunchInventory,
): LaunchAssetFeasibility {
  const byRole = assetIdsByRole(inventory.assets);
  const missingRequiredRoles: LaunchAssetRole[] = [];
  const missingPreferredRoles: LaunchAssetRole[] = [];
  const satisfiedByAssetIds: string[] = [];

  for (const requirement of concept.assetRoleRequirements) {
    const available = byRole.get(requirement.assetRole) ?? [];
    if (available.length === 0) {
      if (requirement.necessity === 'REQUIRED') missingRequiredRoles.push(requirement.assetRole);
      else missingPreferredRoles.push(requirement.assetRole);
      continue;
    }
    satisfiedByAssetIds.push(...available);
  }

  const missingCaptureIds = concept.feasibility.requiredCaptureIds.filter(
    (captureId) => !inventory.outputEligibleCaptureIds.has(captureId),
  );

  const verdict =
    missingRequiredRoles.length > 0 || missingCaptureIds.length > 0
      ? 'INFEASIBLE'
      : missingPreferredRoles.length > 0
        ? 'FEASIBLE_WITH_SUBSTITUTION'
        : 'FEASIBLE';

  return {
    verdict,
    missingRequiredRoles,
    missingPreferredRoles,
    missingCaptureIds,
    satisfiedByAssetIds: [...new Set(satisfiedByAssetIds)].sort(),
  };
}

export interface ConceptAssessmentOptions {
  readonly candidate: ConceptCandidate;
  readonly conceptVersion: number;
  readonly inventory: LaunchInventory;
  readonly request: CampaignRequest;
  readonly launchBrief: ProductLaunchBrief;
  readonly originality: OriginalityAssessment;
  readonly governingProfiles: readonly LaunchGoverningProfile[];
}

export function assessLaunchConcept(options: ConceptAssessmentOptions): LaunchConceptAssessment {
  const { candidate, inventory, request, launchBrief, originality } = options;
  const concept = candidate.concept;
  const assetFeasibility = assessAssetFeasibility(concept, inventory);
  const echoedClaims = findProhibitedClaimEchoes(concept, launchBrief.prohibitedClaims);
  const blockingReasons: string[] = [];

  const humanDimension = (
    dimension: LaunchDimensionAssessment['dimension'],
    finding: string,
  ): LaunchDimensionAssessment => ({
    dimension,
    basis: 'HUMAN_JUDGEMENT_REQUIRED',
    verdict: 'NOT_ASSESSED',
    finding,
    evidence: [],
  });

  // --- product comprehension ------------------------------------------------
  const citedFactIds = [...new Set(concept.factualProductClaims.map((claim) => claim.factId))];
  const productComprehension: LaunchDimensionAssessment =
    echoedClaims.length > 0
      ? {
          dimension: 'PRODUCT_COMPREHENSION',
          basis: 'DETERMINISTIC_STRUCTURAL_SIGNAL',
          verdict: 'BLOCKING',
          finding: `the concept states ${echoedClaims.length} prohibited claim(s) outright`,
          evidence: echoedClaims.slice(0, 12).map((claim) => `prohibited claim stated: ${claim}`),
        }
      : {
          dimension: 'PRODUCT_COMPREHENSION',
          basis: 'DETERMINISTIC_STRUCTURAL_SIGNAL',
          verdict: 'SUPPORTED',
          finding: `every claim cites a supplied product fact (${citedFactIds.length} of ${request.productFacts.length} facts used); no prohibited claim is stated`,
          evidence: citedFactIds.slice(0, 12).map((factId) => `claim cites productFact ${factId}`),
        };
  if (echoedClaims.length > 0) {
    blockingReasons.push(
      `states prohibited claim(s): ${echoedClaims.map((claim) => `"${claim}"`).join(', ')}`,
    );
  }

  // --- visual feasibility ----------------------------------------------------
  const verticalCapable = inventory.assets.filter(
    (asset) =>
      asset.kind !== 'AUDIO' &&
      (asset.declaredHeightPx === undefined ||
        asset.declaredWidthPx === undefined ||
        asset.declaredHeightPx >= asset.declaredWidthPx),
  );
  const visualFeasibility: LaunchDimensionAssessment = {
    dimension: 'VISUAL_FEASIBILITY',
    basis: 'MEASURED_FROM_INVENTORY',
    verdict: verticalCapable.length > 0 ? 'SUPPORTED' : 'NEEDS_ATTENTION',
    finding:
      verticalCapable.length > 0
        ? `${verticalCapable.length} of ${inventory.assets.length} approved assets are vertical-capable by their declared dimensions`
        : 'no approved visual asset is vertical-capable by its declared dimensions',
    evidence: [
      `declared dimensions only — every asset is re-measured with ffprobe at render time, and a disagreement is recorded there`,
      `master is ${request.targetDurationSeconds}s, 9:16`,
    ],
  };

  // --- asset feasibility -----------------------------------------------------
  const assetDimension: LaunchDimensionAssessment = {
    dimension: 'ASSET_FEASIBILITY',
    basis: 'MEASURED_FROM_INVENTORY',
    verdict:
      assetFeasibility.verdict === 'INFEASIBLE'
        ? 'BLOCKING'
        : assetFeasibility.verdict === 'FEASIBLE_WITH_SUBSTITUTION'
          ? 'NEEDS_ATTENTION'
          : 'SUPPORTED',
    finding: `${assetFeasibility.verdict} against the approved inventory`,
    evidence: [
      ...assetFeasibility.missingRequiredRoles.map(
        (role) => `no approved asset for REQUIRED ${role}`,
      ),
      ...assetFeasibility.missingPreferredRoles.map(
        (role) => `no approved asset for PREFERRED ${role}`,
      ),
      ...assetFeasibility.missingCaptureIds.map(
        (captureId) =>
          `required capture "${captureId}" is absent or not output-eligible${
            inventory.reviewRequiredCaptureIds.has(captureId)
              ? ' (it was captured for inspection only)'
              : ''
          }`,
      ),
      `${assetFeasibility.satisfiedByAssetIds.length} approved asset(s) can serve the required roles`,
    ].slice(0, 12),
  };
  if (assetFeasibility.verdict === 'INFEASIBLE') {
    blockingReasons.push(
      `cannot be produced from the approved inventory: ${[
        ...assetFeasibility.missingRequiredRoles.map((role) => `missing ${role}`),
        ...assetFeasibility.missingCaptureIds.map((id) => `missing capture ${id}`),
      ].join(', ')}`,
    );
  }

  // --- sound opportunity -----------------------------------------------------
  const audioAssets = inventory.assets.filter((asset) => asset.kind === 'AUDIO');
  const needsAudioBed = ['MUSIC_LED', 'RHYTHM_LED_DESIGN', 'AMBIENCE_LED'].includes(
    concept.soundDesign.kind,
  );
  const voiceLed = concept.soundDesign.kind === 'VOICE_LED';
  const soundDimension: LaunchDimensionAssessment = {
    dimension: 'SOUND_OPPORTUNITY',
    basis: 'MEASURED_FROM_INVENTORY',
    verdict:
      voiceLed || (needsAudioBed && audioAssets.length === 0) ? 'NEEDS_ATTENTION' : 'SUPPORTED',
    finding: voiceLed
      ? 'this concept is voice-led, and the deterministic render path produces no voice-over — a voice track has to be supplied as an approved audio asset'
      : needsAudioBed && audioAssets.length === 0
        ? `this concept's sound direction (${concept.soundDesign.kind}) needs an audio bed and the approved inventory has none`
        : `sound direction ${concept.soundDesign.kind} is supportable with ${audioAssets.length} approved audio asset(s)`,
    evidence: audioAssets.slice(0, 8).map((asset) => `approved audio asset ${asset.id}`),
  };

  // --- originality -----------------------------------------------------------
  const originalityDimension: LaunchDimensionAssessment = {
    dimension: 'ORIGINALITY_RISK',
    basis: 'DETERMINISTIC_STRUCTURAL_SIGNAL',
    verdict:
      originality.riskLevel === 'HIGH'
        ? 'BLOCKING'
        : originality.riskLevel === 'MEDIUM'
          ? 'NEEDS_ATTENTION'
          : 'SUPPORTED',
    finding: `deterministic originality risk is ${originality.riskLevel}`,
    evidence: originality.signals
      .slice(0, 12)
      .map((signal) => `${signal.severity} ${signal.code} (${signal.agentRole})`),
  };
  if (originality.blocked) {
    blockingReasons.push('the deterministic originality gate returned HIGH risk');
  }

  // --- platform suitability --------------------------------------------------
  const shortForm = SHORT_FORM_PLATFORMS.includes(request.platform);
  const oversizedVariants = launchBrief.requiredVariants.filter(
    (variant) => variant.durationSeconds > request.targetDurationSeconds,
  );
  const platformDimension: LaunchDimensionAssessment = {
    dimension: 'PLATFORM_SUITABILITY',
    basis: 'DETERMINISTIC_STRUCTURAL_SIGNAL',
    verdict:
      (shortForm && request.targetDurationSeconds > SHORT_FORM_CEILING_SECONDS) ||
      oversizedVariants.length > 0
        ? 'NEEDS_ATTENTION'
        : 'SUPPORTED',
    finding: `${request.platform} master of ${request.targetDurationSeconds}s with ${launchBrief.requiredVariants.length} required variant(s)`,
    evidence: [
      ...(shortForm ? [`${request.platform} is a vertical short-form feed`] : []),
      ...oversizedVariants.map(
        (variant) =>
          `variant "${variant.id}" is ${variant.durationSeconds}s, longer than the master`,
      ),
      `concept's own duration note: ${concept.feasibility.durationFitNote.slice(0, 200)}`,
    ].slice(0, 12),
  };

  const dimensions: LaunchDimensionAssessment[] = [
    humanDimension(
      'STRATEGIC_CLARITY',
      'Whether this concept states one clear proposition is a craft judgement. Read the central idea against the positioning and the desired audience perception.',
    ),
    productComprehension,
    humanDimension(
      'EMOTIONAL_IMPACT',
      `Whether the ${concept.emotionalArc.kind} arc actually lands is a craft judgement no measurement substitutes for.`,
    ),
    humanDimension(
      'BRAND_DISTINCTIVENESS',
      'Whether this could only be this brand’s advertisement is a craft judgement. Compare it against the brand identity and the other candidates.',
    ),
    humanDimension(
      'NARRATIVE_COHERENCE',
      `Whether ${concept.narrativeStructure.kind} resolving on ${concept.endFrame.kind} holds together is a craft judgement.`,
    ),
    visualFeasibility,
    assetDimension,
    soundDimension,
    originalityDimension,
    platformDimension,
  ];

  return {
    assessmentVersion: 1,
    conceptId: candidate.conceptId,
    conceptVersion: options.conceptVersion,
    dimensions,
    assetFeasibility,
    originality,
    governingProfiles: [...options.governingProfiles],
    selectable: blockingReasons.length === 0,
    blockingReasons,
    agencyGradeClaim: 'NOT_ASSESSED',
    requiresHumanApproval: true,
    notice: LAUNCH_ASSESSMENT_NOTICE,
  };
}

/**
 * What the originality evaluator reads for one concept.
 *
 * The strategist entry is included because its output is upstream of every
 * candidate; the concept entry carries this candidate's own prose. Divergence
 * records and reasoning are excluded for the reasons `buildOriginalityEntries`
 * documents — a compliance statement is not evidence of copying.
 */
export function conceptOriginalityEntries(options: {
  readonly candidate: ConceptCandidate;
  readonly strategy: CampaignStrategistResult;
  readonly strategyContext?: ConceptCandidate['context'];
}): readonly OriginalityEvaluationEntry[] {
  const { candidate, strategy } = options;
  return [
    {
      agentRole: 'CAMPAIGN_STRATEGIST',
      ...(options.strategyContext ? { context: options.strategyContext } : {}),
      ...(strategy.creativeMemoryDivergence
        ? { divergence: strategy.creativeMemoryDivergence }
        : {}),
      outputText: [
        strategy.audienceProfile.name,
        ...strategy.audienceProfile.painPoints,
        strategy.strategy.positioning,
        strategy.strategy.targetAudienceSummary,
        ...strategy.strategy.keyMessages,
        ...strategy.strategy.toneGuidelines,
      ],
    },
    {
      agentRole: 'CREATIVE_DIRECTOR',
      ...(candidate.context ? { context: candidate.context } : {}),
      ...(candidate.divergence ? { divergence: candidate.divergence } : {}),
      outputText: [
        candidate.director.logline,
        candidate.director.visualDirection,
        candidate.director.narrativeArc,
        ...candidate.director.referenceNotes,
        ...conceptAssertions(candidate.concept),
        candidate.concept.originalityRationale,
      ],
    },
  ];
}

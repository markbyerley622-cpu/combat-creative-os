import {
  ApprovedUsage,
  LicenceFamily,
  MediaRightsDecision,
  MediaRightsFacts,
  RightsOutcome,
} from './contracts';

/**
 * The licence policy: which families may be used, which always need a person,
 * and which are refused outright.
 *
 * Three structural rules, in this order, and the order is the policy:
 *
 * 1. **Rejection is absolute.** A refused licence family, or a refused
 *    provider restriction, ends the evaluation. Nothing later can rescue it —
 *    not a clean measurement, not a high score, not an operator's insistence.
 * 2. **Review is sticky.** Any single review trigger makes the whole decision
 *    `REVIEW_REQUIRED`, however many clean facts sit beside it. There is no
 *    scoring, no threshold and no majority: "two of the three risk fields are
 *    fine" is not a rights position.
 * 3. **Automatic eligibility is the residue.** It is what is left when nothing
 *    objected — never something a fact can affirmatively grant.
 *
 * And the rule that matters most: `AUTOMATICALLY_ELIGIBLE` is not an approval.
 * It means the policy raises no objection to a human approving this item. The
 * approval is a separate, named, dated record, and there is no code path in
 * this repository that writes one.
 */

export const RIGHTS_POLICY_VERSION = 'MEDIA_RIGHTS_POLICY_V1';

/**
 * Families that may pass without a mandatory human step, subject to every
 * other check below.
 *
 * `CC_BY` is here because attribution is a *generatable* obligation: we can
 * produce the credit line from the facts we hold and carry it into
 * `CREDITS.md`. `CC_BY_SA` is deliberately absent — share-alike is an
 * obligation on the *derivative work*, which is a decision about how the
 * finished advertisement is licensed, and that is not a decision code makes.
 */
const AUTOMATICALLY_ELIGIBLE_FAMILIES: readonly LicenceFamily[] = [
  'CC0',
  'PUBLIC_DOMAIN',
  'PUBLIC_DOMAIN_MARK',
  'US_GOVERNMENT_PUBLIC_DOMAIN',
  'CC_BY',
  'PEXELS_LICENCE',
  'PIXABAY_CONTENT_LICENCE',
];

/** Families that always require a person, however clean everything else is. */
const REVIEW_REQUIRED_FAMILIES: readonly LicenceFamily[] = ['CC_BY_SA'];

/**
 * Families that are refused, with the reason stated per family.
 *
 * Every one of these is a licence that cannot support a paid or organic brand
 * advertisement, and being told which specific term blocks it is far more
 * useful than "not permitted".
 */
const REJECTED_FAMILIES: Readonly<Partial<Record<LicenceFamily, string>>> = {
  CC_BY_NC: 'NonCommercial licences forbid advertising use, which is a commercial use',
  CC_BY_NC_SA: 'NonCommercial licences forbid advertising use, which is a commercial use',
  CC_BY_NC_ND:
    'NonCommercial forbids advertising use and NoDerivatives forbids the editing every advertisement requires',
  CC_BY_ND:
    'NoDerivatives forbids cropping, cutting, colour work and overlay — an advertisement is a derivative work by construction',
  EDITORIAL_ONLY:
    'editorial-only material may accompany news or commentary and may never promote a product or service',
  PERSONAL_USE_ONLY: 'personal-use-only material may not be used by or for a business',
  STANDARD_YOUTUBE_LICENCE:
    'the standard YouTube licence grants rights to YouTube, not to third parties, and permits no downloading or reuse',
  ALL_RIGHTS_RESERVED: 'no reuse is permitted without a written licence from the rights holder',
  UNKNOWN:
    'the licence could not be established. "We are not sure" is the state real libraries are in, and treating it as permitted is how unlicensed footage ships',
};

/**
 * Restriction phrases that refuse an item regardless of its licence family.
 *
 * Matched as lowercase substrings of a provider's own restriction text. A
 * substring rule is right here and wrong for path segments: this is prose
 * written by a licensor, and "no commercial use" appearing anywhere inside it
 * is the licensor saying so.
 */
const REJECTING_RESTRICTION_PHRASES: readonly { readonly phrase: string; readonly why: string }[] =
  [
    { phrase: 'no commercial use', why: 'the source states commercial use is not permitted' },
    { phrase: 'non-commercial', why: 'the source states the material is non-commercial' },
    { phrase: 'noncommercial', why: 'the source states the material is non-commercial' },
    { phrase: 'editorial use only', why: 'the source states the material is editorial-only' },
    { phrase: 'no derivative', why: 'the source forbids derivative works' },
    { phrase: 'personal use only', why: 'the source limits use to personal use' },
    { phrase: 'not for advertising', why: 'the source forbids advertising use' },
    { phrase: 'rights managed', why: 'rights-managed material needs a negotiated per-use licence' },
  ];

/**
 * Restriction phrases that force a human decision.
 *
 * These are conditions rather than prohibitions — an obligation the operator
 * may well be able to meet, but not one code can verify has been met.
 */
const REVIEW_RESTRICTION_PHRASES: readonly { readonly phrase: string; readonly why: string }[] = [
  { phrase: 'release', why: 'the source refers to a model or property release' },
  { phrase: 'endorsement', why: 'the source raises an endorsement condition' },
  { phrase: 'trademark', why: 'the source raises a trademark condition' },
  { phrase: 'identifiable', why: 'the source refers to identifiable people' },
  { phrase: 'attribution required', why: 'the source requires a specific credit' },
  { phrase: 'share-alike', why: 'the source imposes a share-alike obligation on derivatives' },
  { phrase: 'sharealike', why: 'the source imposes a share-alike obligation on derivatives' },
  {
    phrase: 'do not imply',
    why: 'the source restricts what the material may be shown as implying',
  },
];

export interface EvaluateRightsInput {
  readonly facts: MediaRightsFacts;
  /**
   * Whether the item is US-government work published through DVIDS. Those
   * carry a non-endorsement obligation and frequently show identifiable
   * service members, so they never clear automatically.
   */
  readonly isGovernmentPublicAffairs?: boolean;
}

/**
 * Builds a credit line from the facts we hold.
 *
 * Prefers the provider's own attribution text when it supplied one — a
 * licensor's wording is the wording it asked for. Falls back to
 * `creator (licence) via landing page`, which is what CC BY actually requires:
 * author, licence, and a link back.
 */
export function buildAttribution(facts: MediaRightsFacts, landingPageUrl: string): string {
  if (facts.attributionText && facts.attributionText.trim().length > 0) {
    return facts.attributionText.trim().slice(0, 600);
  }
  const licence = facts.licenceUrl
    ? `${facts.declaredLicence} (${facts.licenceUrl})`
    : facts.declaredLicence;
  return `${facts.creator} — ${licence} — ${landingPageUrl}`.slice(0, 600);
}

function includesAny(
  restrictions: readonly string[],
  table: readonly { readonly phrase: string; readonly why: string }[],
): readonly string[] {
  const hits: string[] = [];
  for (const restriction of restrictions) {
    const lowered = restriction.toLowerCase();
    for (const entry of table) {
      if (lowered.includes(entry.phrase) && !hits.includes(entry.why)) hits.push(entry.why);
    }
  }
  return hits;
}

/**
 * Evaluates one candidate's rights facts against the policy.
 *
 * Every path returns reasons. A decision with no stated reason is not
 * reviewable, and this pipeline's entire claim is that its decisions can be
 * re-read later against the rules that produced them.
 */
export function evaluateMediaRights(
  input: EvaluateRightsInput & { landingPageUrl: string },
): MediaRightsDecision {
  const { facts } = input;
  const rejections: string[] = [];
  const reviews: string[] = [];

  // 1 — refusals.
  const familyRejection = REJECTED_FAMILIES[facts.licenceFamily];
  if (familyRejection) {
    rejections.push(`${facts.declaredLicence} is refused: ${familyRejection}`);
  }
  for (const why of includesAny(facts.sourceRestrictions, REJECTING_RESTRICTION_PHRASES)) {
    rejections.push(why);
  }
  if (facts.commercialUse === 'PROHIBITED') {
    rejections.push('the source states commercial use is prohibited');
  }
  if (facts.derivativeUse === 'PROHIBITED') {
    rejections.push(
      'the source states derivative use is prohibited, and every advertisement is a derivative work',
    );
  }

  if (rejections.length > 0) {
    return {
      outcome: 'REJECTED' satisfies RightsOutcome,
      policyVersion: RIGHTS_POLICY_VERSION,
      reasons: rejections,
      candidateUsages: [],
    };
  }

  // 2 — review triggers. Each one is sufficient on its own.
  if (REVIEW_REQUIRED_FAMILIES.includes(facts.licenceFamily)) {
    reviews.push(
      `${facts.declaredLicence} imposes a share-alike obligation on the finished advertisement. How this repository's output is licensed is not a decision code may make.`,
    );
  }
  if (!AUTOMATICALLY_ELIGIBLE_FAMILIES.includes(facts.licenceFamily)) {
    if (!REVIEW_REQUIRED_FAMILIES.includes(facts.licenceFamily)) {
      reviews.push(
        `${facts.declaredLicence} is not in the automatically-eligible set and must be read by a person`,
      );
    }
  }
  if (facts.recognizablePersonRisk !== 'NONE_APPARENT') {
    reviews.push(
      facts.recognizablePersonRisk === 'PRESENT'
        ? 'identifiable people are present — advertising use of a person’s likeness needs a model release, which no stock licence warrants'
        : 'whether identifiable people are present could not be established',
    );
  }
  if (facts.trademarkOrLogoRisk !== 'NONE_APPARENT') {
    reviews.push(
      facts.trademarkOrLogoRisk === 'PRESENT'
        ? 'trademarks, logos or brand marks are present, and a stock licence does not license a third party’s mark'
        : 'whether trademarks or logos are present could not be established',
    );
  }
  if (facts.endorsementRisk === 'MEDIUM' || facts.endorsementRisk === 'HIGH') {
    reviews.push(`endorsement risk is ${facts.endorsementRisk}`);
  }
  if (facts.endorsementRisk === 'UNKNOWN') {
    reviews.push('endorsement risk could not be established');
  }
  if (facts.modelReleaseStatus === 'NOT_PROVIDED' || facts.modelReleaseStatus === 'UNKNOWN') {
    reviews.push(`the model release status is ${facts.modelReleaseStatus}`);
  }
  if (facts.propertyReleaseStatus === 'NOT_PROVIDED' || facts.propertyReleaseStatus === 'UNKNOWN') {
    reviews.push(`the property release status is ${facts.propertyReleaseStatus}`);
  }
  if (facts.paidAdvertisingUse !== 'PERMITTED') {
    reviews.push(
      facts.paidAdvertisingUse === 'PROHIBITED'
        ? 'paid advertising use is prohibited — organic use may still be approvable, paid use is not'
        : 'paid advertising permission could not be established from the source terms',
    );
  }
  if (facts.commercialUse === 'UNKNOWN') {
    reviews.push('commercial-use permission could not be established from the source terms');
  }
  if (facts.derivativeUse === 'UNKNOWN') {
    reviews.push('derivative-use permission could not be established from the source terms');
  }
  if (input.isGovernmentPublicAffairs) {
    reviews.push(
      'US government public-affairs material carries a non-endorsement obligation: it must not be presented as an endorsement by the department, the service or any pictured service member',
    );
  }
  for (const why of includesAny(facts.sourceRestrictions, REVIEW_RESTRICTION_PHRASES)) {
    reviews.push(why);
  }

  const attribution = requiresAttribution(facts.licenceFamily)
    ? buildAttribution(facts, input.landingPageUrl)
    : undefined;

  if (reviews.length > 0) {
    return {
      outcome: 'REVIEW_REQUIRED' satisfies RightsOutcome,
      policyVersion: RIGHTS_POLICY_VERSION,
      reasons: reviews,
      // A reviewer may approve any of the three; the policy states what it did
      // not object to, and paid social is excluded when paid use is unsettled.
      candidateUsages: [...permittedUsagesUnderReview(facts)],
      ...(attribution ? { requiredAttribution: attribution } : {}),
    };
  }

  return {
    outcome: 'AUTOMATICALLY_ELIGIBLE' satisfies RightsOutcome,
    policyVersion: RIGHTS_POLICY_VERSION,
    reasons: [
      `${facts.declaredLicence} permits commercial derivative use, no identifiable person or mark was reported, and no source restriction objected. This is not an approval: a named human must still record one.`,
    ],
    candidateUsages: ['INTERNAL_EVALUATION', 'ORGANIC_SOCIAL', 'PAID_SOCIAL'],
    ...(attribution ? { requiredAttribution: attribution } : {}),
  };
}

/**
 * Usages the policy leaves open to a reviewer when review is required.
 *
 * Paid social drops out the moment paid permission is anything but
 * `PERMITTED` — a reviewer may still write the approval, but they must do it
 * against a usage the policy has explicitly flagged rather than one it
 * silently offered.
 */
function permittedUsagesUnderReview(facts: MediaRightsFacts): readonly ApprovedUsage[] {
  const usages: ApprovedUsage[] = ['INTERNAL_EVALUATION'];
  if (facts.commercialUse !== 'PROHIBITED') usages.push('ORGANIC_SOCIAL');
  if (facts.paidAdvertisingUse === 'PERMITTED') usages.push('PAID_SOCIAL');
  return usages;
}

/** Families whose terms compel a visible credit. */
export function requiresAttribution(family: LicenceFamily): boolean {
  return family === 'CC_BY' || family === 'CC_BY_SA' || family === 'US_GOVERNMENT_PUBLIC_DOMAIN';
}

/**
 * Whether a recorded approval actually covers the usage being attempted, at a
 * given instant.
 *
 * Separate from `evaluateMediaRights` because it answers a different question:
 * the policy says what may be approved, this says what *was*. Expiry is checked
 * against a caller-supplied instant — nothing in this package reads a clock.
 */
export function approvalCoversUsage(
  approval: {
    readonly approvedUsages: readonly ApprovedUsage[];
    readonly effectiveDate: string;
    readonly expiresAt?: string;
  },
  usage: ApprovedUsage,
  now: Date,
): { readonly covered: boolean; readonly reason: string } {
  if (!approval.approvedUsages.includes(usage)) {
    return {
      covered: false,
      reason: `the approval covers ${approval.approvedUsages.join(', ')} and not ${usage}`,
    };
  }
  const effective = new Date(approval.effectiveDate);
  if (Number.isNaN(effective.getTime())) {
    return { covered: false, reason: 'the approval has an unreadable effective date' };
  }
  if (effective.getTime() > now.getTime()) {
    return {
      covered: false,
      reason: `the approval does not take effect until ${approval.effectiveDate}`,
    };
  }
  if (approval.expiresAt) {
    const expiry = new Date(approval.expiresAt);
    if (Number.isNaN(expiry.getTime())) {
      return { covered: false, reason: 'the approval has an unreadable expiry date' };
    }
    if (expiry.getTime() <= now.getTime()) {
      return { covered: false, reason: `the approval expired on ${approval.expiresAt}` };
    }
  }
  return { covered: true, reason: `covered by the approval for ${usage}` };
}

/**
 * `INTERNAL_EVALUATION` is not a production grade.
 *
 * An approval limited to it produces a labelled demonstration and never a
 * campaign asset. Callers ask this rather than testing the array themselves so
 * the rule has exactly one implementation.
 */
export function isInternalEvaluationOnly(approval: {
  readonly approvedUsages: readonly ApprovedUsage[];
}): boolean {
  return (
    approval.approvedUsages.length > 0 &&
    approval.approvedUsages.every((usage) => usage === 'INTERNAL_EVALUATION')
  );
}

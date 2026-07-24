import type { AspectRatio, CampaignBriefContent, DeliveryPlatform } from '@combat/domain';

/**
 * Pure form-state <-> API-contract transforms for the brief editor,
 * extracted from the page component so they're unit-testable without a
 * React rendering setup (apps/dashboard has no RTL/jsdom install — see
 * package.json).
 */
export interface DraftFields {
  campaignName: string;
  productName: string;
  productDescription: string;
  objective: string;
  targetAudience: string;
  customerProblem: string;
  valueProposition: string;
  productFeatures: string;
  targetPlatforms: DeliveryPlatform[];
  aspectRatios: AspectRatio[];
  durationsSeconds: string;
  brandVoice: string;
  visualDirection: string;
  requiredMessaging: string;
  callToAction: string;
  references: string;
  assetReferences: string;
  prohibitedClaims: string;
  budgetCents: number;
  locale: string;
  notes: string;
}

export const EMPTY_DRAFT: DraftFields = {
  campaignName: '',
  productName: '',
  productDescription: '',
  objective: '',
  targetAudience: '',
  customerProblem: '',
  valueProposition: '',
  productFeatures: '',
  targetPlatforms: [],
  aspectRatios: [],
  durationsSeconds: '',
  brandVoice: '',
  visualDirection: '',
  requiredMessaging: '',
  callToAction: '',
  references: '',
  assetReferences: '',
  prohibitedClaims: '',
  budgetCents: 0,
  locale: 'en-US',
  notes: '',
};

export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function toContent(draft: DraftFields): CampaignBriefContent {
  return {
    ...draft,
    productFeatures: splitList(draft.productFeatures),
    requiredMessaging: splitList(draft.requiredMessaging),
    references: splitList(draft.references),
    assetReferences: splitList(draft.assetReferences),
    prohibitedClaims: splitList(draft.prohibitedClaims),
    durationsSeconds: draft.durationsSeconds
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    budgetCents: Number(draft.budgetCents) || 0,
  };
}

export function fromLoadedBrief(brief: CampaignBriefContent): DraftFields {
  return {
    ...brief,
    productFeatures: brief.productFeatures.join(', '),
    requiredMessaging: brief.requiredMessaging.join(', '),
    references: brief.references.join(', '),
    assetReferences: brief.assetReferences.join(', '),
    prohibitedClaims: brief.prohibitedClaims.join(', '),
    durationsSeconds: brief.durationsSeconds.join(', '),
    notes: brief.notes ?? '',
  };
}

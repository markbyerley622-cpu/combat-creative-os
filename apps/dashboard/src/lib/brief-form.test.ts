import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, fromLoadedBrief, splitList, toContent, type DraftFields } from './brief-form';

describe('splitList', () => {
  it('splits, trims, and drops empty entries', () => {
    expect(splitList('a, b ,  , c')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for an empty string', () => {
    expect(splitList('')).toEqual([]);
  });
});

describe('toContent', () => {
  it('converts comma-separated draft fields into array fields the API expects', () => {
    const draft: DraftFields = {
      ...EMPTY_DRAFT,
      productFeatures: 'widgets, gadgets',
      durationsSeconds: '15, 10, 6',
      targetPlatforms: ['INSTAGRAM_REELS'],
      aspectRatios: ['9:16'],
      budgetCents: 500000,
    };

    const content = toContent(draft);

    expect(content.productFeatures).toEqual(['widgets', 'gadgets']);
    expect(content.durationsSeconds).toEqual([15, 10, 6]);
    expect(content.budgetCents).toBe(500000);
  });

  it('drops non-positive/non-numeric duration entries rather than sending invalid data', () => {
    const draft: DraftFields = { ...EMPTY_DRAFT, durationsSeconds: '15, abc, -3, 0, 6' };
    expect(toContent(draft).durationsSeconds).toEqual([15, 6]);
  });

  it('coerces a non-numeric budget to 0 rather than sending NaN', () => {
    const draft: DraftFields = { ...EMPTY_DRAFT, budgetCents: Number('not-a-number') };
    expect(toContent(draft).budgetCents).toBe(0);
  });
});

describe('fromLoadedBrief / toContent round-trip', () => {
  it('preserves array content through a load -> edit -> submit cycle', () => {
    const original = toContent({
      ...EMPTY_DRAFT,
      campaignName: 'Launch Q3',
      productFeatures: 'a, b',
      requiredMessaging: 'try it free',
      durationsSeconds: '15',
      targetPlatforms: ['TIKTOK'],
      aspectRatios: ['1:1'],
    });

    const draft = fromLoadedBrief(original);
    const roundTripped = toContent(draft);

    expect(roundTripped).toEqual(original);
  });

  it('defaults a missing notes field to an empty string, never undefined, for the controlled input', () => {
    const content = toContent(EMPTY_DRAFT);
    const draft = fromLoadedBrief({ ...content, notes: undefined });
    expect(draft.notes).toBe('');
  });
});

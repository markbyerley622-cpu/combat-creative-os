import { describe, expect, it } from 'vitest';

import type { ResolvedAsset } from './asset-resolution';
import { hashPrompt, type CampaignRequest } from './campaign-request';
import {
  MissingShotSourceError,
  relevanceVocabulary,
  selectSources,
  storyBeatFor,
  type ScriptedShot,
} from './source-selection';

function request(): CampaignRequest {
  const campaignPrompt = 'Open on the number of events, then details, predictions and discussion.';
  return {
    requestVersion: 1,
    name: 'r',
    workspaceId: '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e',
    campaignId: '3c9b7a24-8f61-4d0e-9a37-5b2c8e14d7f0',
    brandName: 'Combat Reviews',
    objective: 'Drive installs',
    targetAudience: 'Fans',
    platform: 'TIKTOK',
    targetDurationSeconds: 15,
    productFacts: [
      { id: 'p', label: 'Predictions', detail: 'Community predictions before every card.' },
    ],
    eventFacts: [{ id: 'e', label: 'Events', detail: '12 events scheduled this weekend.' }],
    keyMessages: [],
    mandatories: [],
    cta: { headline: 'Download Free', durationSeconds: 3 },
    brandKit: {
      logoAssetId: 'logo',
      primaryColorHex: '#0B0B0F',
      accentColorHex: '#FF3B30',
      captionFontFamily: 'Arial',
      safeAreaTopPx: 220,
      safeAreaBottomPx: 420,
    },
    sourceAssetManifest: './a.json',
    outputDirectory: '.aamp-output/runs',
    generation: {
      source: 'SOURCE_ONLY',
      comfyuiProfile: 'LTX_2_3_DRAFT',
      generatedShotCount: 0,
      maxGeneratedShotSeconds: 4,
    },
    campaignPrompt,
    promptSha256: hashPrompt(campaignPrompt),
    sourceAssetManifestPath: 'C:/c/a.json',
    requestPath: 'C:/c/r.json',
  } as CampaignRequest;
}

function asset(
  id: string,
  role: 'SOURCE_CLIP' | 'APP_SCREENSHOT' | 'BRAND_CARD' | 'LOGO' | 'MUSIC',
  kind: 'VIDEO' | 'IMAGE' | 'AUDIO',
  beats: string[] = [],
  extra: Partial<ResolvedAsset> = {},
): ResolvedAsset {
  return {
    asset: {
      id,
      path: `./${id}`,
      kind,
      role,
      description: `${id} asset`,
      rights: {
        classification: 'OWNED',
        owner: 'Combat Reviews',
        permittedOutputUse: true,
        restrictions: [],
      },
      beats: beats as never,
      tags: [],
    } as never,
    absolutePath: `C:/c/${id}`,
    sizeBytes: 1000,
    checksumSha256: 'a'.repeat(64),
    measuredWidthPx: 1080,
    measuredHeightPx: 1920,
    ...(kind === 'VIDEO' ? { measuredDurationSeconds: 10 } : {}),
    discrepancies: [],
    ...extra,
  };
}

const shots: ScriptedShot[] = [
  { index: 0, description: 'hook', durationSeconds: 2, beat: 'HOOK' },
  { index: 1, description: 'promise', durationSeconds: 2, beat: 'PROMISE' },
  { index: 2, description: 'feature a', durationSeconds: 2, beat: 'FEATURE' },
  { index: 3, description: 'feature b', durationSeconds: 2, beat: 'FEATURE' },
  { index: 4, description: 'feature c', durationSeconds: 2, beat: 'FEATURE' },
  { index: 5, description: 'cta', durationSeconds: 3, beat: 'CTA' },
];

const library = [
  asset('clip-hook', 'SOURCE_CLIP', 'VIDEO', ['HOOK']),
  asset('clip-event', 'SOURCE_CLIP', 'VIDEO', ['EVENT_DETAIL']),
  asset('screen-info', 'APP_SCREENSHOT', 'IMAGE', ['INFORMATION']),
  asset('screen-prediction', 'APP_SCREENSHOT', 'IMAGE', ['PREDICTION']),
  asset('screen-discussion', 'APP_SCREENSHOT', 'IMAGE', ['DISCUSSION']),
  asset('brand-card', 'BRAND_CARD', 'IMAGE', ['CTA']),
];

describe('story beat mapping', () => {
  it('walks successive FEATURE shots through the information arc', () => {
    expect(storyBeatFor('HOOK', 0)).toBe('HOOK');
    expect(storyBeatFor('PROMISE', 0)).toBe('EVENT_DETAIL');
    expect(storyBeatFor('FEATURE', 0)).toBe('INFORMATION');
    expect(storyBeatFor('FEATURE', 1)).toBe('PREDICTION');
    expect(storyBeatFor('FEATURE', 2)).toBe('DISCUSSION');
    expect(storyBeatFor('CTA', 0)).toBe('CTA');
  });
});

describe('deterministic selection', () => {
  it('produces the requested event → information → prediction → discussion arc', () => {
    const selections = selectSources({ request: request(), shots, assets: library });

    expect(selections.map((selection) => selection.storyBeat)).toEqual([
      'HOOK',
      'EVENT_DETAIL',
      'INFORMATION',
      'PREDICTION',
      'DISCUSSION',
      'CTA',
    ]);
    expect(selections.map((selection) => selection.asset.asset.id)).toEqual([
      'clip-hook',
      'clip-event',
      'screen-info',
      'screen-prediction',
      'screen-discussion',
      'brand-card',
    ]);
  });

  it('is byte-identical across repeated runs of the same request', () => {
    const a = selectSources({ request: request(), shots, assets: library });
    const b = selectSources({ request: request(), shots, assets: [...library].reverse() });
    expect(a.map((s) => s.asset.asset.id)).toEqual(b.map((s) => s.asset.asset.id));
  });

  it('records why each asset won', () => {
    const [first] = selectSources({ request: request(), shots, assets: library });
    expect(first!.reasons.join(' ')).toContain('declares the HOOK beat');
  });

  it('never selects a video shorter than the shot it must fill', () => {
    const shortClip = asset('clip-short', 'SOURCE_CLIP', 'VIDEO', ['HOOK'], {
      measuredDurationSeconds: 0.5,
    });
    const [first] = selectSources({
      request: request(),
      shots: [shots[0]!],
      assets: [shortClip, asset('screen-info', 'APP_SCREENSHOT', 'IMAGE', ['HOOK'])],
    });
    expect(first!.asset.asset.id).not.toBe('clip-short');
  });

  it('falls back to a designed brand card rather than unrelated footage', () => {
    const [only] = selectSources({
      request: request(),
      shots: [{ index: 0, description: 'x', durationSeconds: 30, beat: 'HOOK' }],
      assets: [
        asset('clip-short', 'SOURCE_CLIP', 'VIDEO', ['HOOK'], { measuredDurationSeconds: 1 }),
        asset('brand-card', 'BRAND_CARD', 'IMAGE', ['CTA']),
      ],
    });
    // The too-short clip is ineligible, so the only thing left is the designed
    // card — and the selection is flagged as a fallback so a reviewer can see
    // that this shot has no real footage behind it.
    expect(only!.asset.asset.id).toBe('brand-card');
    expect(only!.usedBrandCardFallback).toBe(true);
  });

  it('raises a typed error when nothing fits and there is no brand card', () => {
    expect(() =>
      selectSources({
        request: request(),
        shots: [{ index: 0, description: 'x', durationSeconds: 30, beat: 'HOOK' }],
        assets: [
          asset('clip-short', 'SOURCE_CLIP', 'VIDEO', ['HOOK'], { measuredDurationSeconds: 1 }),
        ],
      }),
    ).toThrow(MissingShotSourceError);
  });

  it('never selects a logo or a music bed as a scene', () => {
    const selections = selectSources({
      request: request(),
      shots: [shots[0]!],
      assets: [
        asset('logo', 'LOGO', 'IMAGE'),
        asset('music', 'MUSIC', 'AUDIO'),
        asset('brand-card', 'BRAND_CARD', 'IMAGE'),
      ],
    });
    expect(selections[0]!.asset.asset.role).toBe('BRAND_CARD');
  });
});

describe('relevance vocabulary', () => {
  it('draws significant words from the campaign facts, sorted for stability', () => {
    const vocabulary = relevanceVocabulary(request());
    expect(vocabulary).toContain('predictions');
    expect(vocabulary).toContain('weekend');
    expect([...vocabulary]).toEqual([...vocabulary].sort());
  });
});

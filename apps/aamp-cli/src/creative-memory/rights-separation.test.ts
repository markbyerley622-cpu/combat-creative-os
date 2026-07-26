import { describe, expect, it } from 'vitest';

import {
  assertReferenceClassification,
  InMemoryReferenceStore,
  ReferenceRightsViolationError,
} from '@combat/database';
import {
  FORBIDDEN_REFERENCE_CLASSIFICATIONS,
  REFERENCE_PROCESSING_STATES,
  REFERENCE_RIGHTS_CLASSIFICATIONS,
  ReferenceIngestionManifestV1Schema,
  isForbiddenReferenceClassification,
  permitsLocalAnalysis,
  referenceGrantsNoOutputRights,
} from '@combat/domain';
import { OUTPUT_ELIGIBLE_USAGE_CLASSES, SOURCE_USAGE_CLASSES } from '@combat/media';

import { parseProductionAssetManifest } from '../production-assets';

/**
 * The legal separation between inspiration and production, asserted rather
 * than documented.
 *
 * These are the tests that matter most in this milestone. Every other failure
 * here costs time; a failure of this boundary puts a third party's
 * advertisement into something we publish.
 */

const VALID_ENTRY = {
  referenceId: 'r1',
  title: 'A reference',
  brand: 'Some brand',
  localAnalysisPath: './ref.mp4',
  accessBasis: 'OPERATOR_LAWFUL_COPY',
  rightsClassification: 'ANALYSIS_ONLY',
  rightsHolder: 'Third party',
  permittedUses: ['private structural analysis'],
  prohibitedUses: ['no use in any produced advertisement or other output'],
  businessRoles: ['CREATIVE_DIRECTION'],
};

const manifestWith = (references: unknown[]) => ({
  manifestVersion: 1,
  library: 'test',
  workspaceId: '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e',
  references,
});

describe('reference rights can never authorise output', () => {
  it('grants no output rights for any classification, exhaustively', () => {
    for (const classification of REFERENCE_RIGHTS_CLASSIFICATIONS) {
      expect(referenceGrantsNoOutputRights(classification)).toBe(true);
    }
  });

  it('shares no value with the renderer’s output-eligible usage classes', () => {
    const outputEligible = new Set<string>(OUTPUT_ELIGIBLE_USAGE_CLASSES);
    for (const classification of REFERENCE_RIGHTS_CLASSIFICATIONS) {
      expect(outputEligible.has(classification), `${classification} is output-eligible`).toBe(
        false,
      );
    }
  });

  it('does not contain the renderer’s LICENSED_FOR_OUTPUT class at all', () => {
    expect(SOURCE_USAGE_CLASSES).toContain('LICENSED_FOR_OUTPUT');
    expect(REFERENCE_RIGHTS_CLASSIFICATIONS as readonly string[]).not.toContain(
      'LICENSED_FOR_OUTPUT',
    );
    expect(REFERENCE_RIGHTS_CLASSIFICATIONS as readonly string[]).not.toContain('PRODUCTION_ASSET');
  });

  it('names the forbidden classifications and refuses them at the repository boundary', () => {
    for (const forbidden of FORBIDDEN_REFERENCE_CLASSIFICATIONS) {
      expect(isForbiddenReferenceClassification(forbidden)).toBe(true);
      expect(() => assertReferenceClassification(forbidden)).toThrow(ReferenceRightsViolationError);
    }
  });

  it('refuses a manifest entry that claims an output-permitting use', () => {
    const result = ReferenceIngestionManifestV1Schema.safeParse(
      manifestWith([{ ...VALID_ENTRY, permittedUses: ['use in a produced advertisement'] }]),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('never output-eligible');
  });

  it('refuses a manifest entry that fails to prohibit output use', () => {
    const result = ReferenceIngestionManifestV1Schema.safeParse(
      manifestWith([{ ...VALID_ENTRY, prohibitedUses: ['no redistribution'] }]),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('must explicitly prohibit output use');
  });

  it('cannot spell an output classification in a reference manifest', () => {
    const result = ReferenceIngestionManifestV1Schema.safeParse(
      manifestWith([{ ...VALID_ENTRY, rightsClassification: 'LICENSED_FOR_OUTPUT' }]),
    );
    expect(result.success).toBe(false);
  });

  it('keeps READY_FOR_RETRIEVAL from meaning output-permitted', () => {
    expect(REFERENCE_PROCESSING_STATES).toContain('READY_FOR_RETRIEVAL');
    // The state exists; it still grants nothing.
    for (const classification of REFERENCE_RIGHTS_CLASSIFICATIONS) {
      expect(referenceGrantsNoOutputRights(classification)).toBe(true);
    }
  });
});

describe('references cannot enter production source selection', () => {
  it('is refused by the production asset manifest as ANALYSIS_ONLY', () => {
    expect(() =>
      parseProductionAssetManifest({
        manifestVersion: 1,
        library: 'attempted smuggling',
        assets: [
          {
            id: 'logo',
            path: './logo.png',
            kind: 'IMAGE',
            role: 'LOGO',
            description: 'logo',
            rights: { classification: 'OWNED', owner: 'CR', permittedOutputUse: true },
          },
          {
            id: 'agency-benchmark',
            path: './benchmark.mp4',
            kind: 'VIDEO',
            role: 'SOURCE_CLIP',
            description: 'an award-winning agency advertisement',
            rights: {
              classification: 'ANALYSIS_ONLY',
              owner: 'Third-party agency',
              permittedOutputUse: true,
            },
          },
        ],
      }),
    ).toThrow(/must never enter a production asset manifest/);
  });

  it('has no reference classification the production manifest would accept', () => {
    for (const classification of REFERENCE_RIGHTS_CLASSIFICATIONS) {
      const result = (() => {
        try {
          parseProductionAssetManifest({
            manifestVersion: 1,
            library: 'attempted smuggling',
            assets: [
              {
                id: 'logo',
                path: './logo.png',
                kind: 'IMAGE',
                role: 'LOGO',
                description: 'logo',
                rights: { classification: 'OWNED', owner: 'CR', permittedOutputUse: true },
              },
              {
                id: 'reference',
                path: './ref.mp4',
                kind: 'VIDEO',
                role: 'SOURCE_CLIP',
                description: 'a reference',
                rights: { classification, owner: 'Third party', permittedOutputUse: true },
              },
            ],
          });
          return 'ACCEPTED';
        } catch {
          return 'REFUSED';
        }
      })();
      expect(result, `${classification} was accepted into a production manifest`).toBe('REFUSED');
    }
  });
});

describe('link-only references expose no invented local path', () => {
  it('refuses a link-only entry that supplies a local path', () => {
    const result = ReferenceIngestionManifestV1Schema.safeParse(
      manifestWith([
        {
          ...VALID_ENTRY,
          rightsClassification: 'LINK_ONLY',
          officialUrl: 'https://example.com/ad',
          localAnalysisPath: './somehow-downloaded.mp4',
        },
      ]),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('must acquire no media');
  });

  it('refuses a link-only entry that supplies a checksum', () => {
    const { localAnalysisPath: _drop, ...rest } = VALID_ENTRY;
    const result = ReferenceIngestionManifestV1Schema.safeParse(
      manifestWith([
        {
          ...rest,
          rightsClassification: 'LINK_ONLY',
          officialUrl: 'https://example.com/ad',
          expectedChecksumSha256: 'a'.repeat(64),
        },
      ]),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('no bytes to hash');
  });

  it('requires an official URL for a link-only entry', () => {
    const { localAnalysisPath: _drop, ...rest } = VALID_ENTRY;
    const result = ReferenceIngestionManifestV1Schema.safeParse(
      manifestWith([{ ...rest, rightsClassification: 'LINK_ONLY' }]),
    );
    expect(result.success).toBe(false);
  });

  it('marks link-only as ineligible for local analysis', () => {
    expect(permitsLocalAnalysis('LINK_ONLY')).toBe(false);
    expect(permitsLocalAnalysis('ANALYSIS_ONLY')).toBe(true);
    expect(permitsLocalAnalysis('OWNED_REFERENCE')).toBe(true);
  });
});

describe('cross-workspace access is denied', () => {
  it('does not return another workspace’s reference', async () => {
    const store = new InMemoryReferenceStore();
    const mine = '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e';
    const theirs = '11111111-2222-4333-8444-555555555555';

    await store.referenceAdvertisement.create({
      data: { workspaceId: theirs, referenceKey: 'their-ad', title: 'Theirs', brand: 'Them' },
    });

    const visible = await store.referenceAdvertisement.findMany({ where: { workspaceId: mine } });
    expect(visible).toHaveLength(0);

    const byKey = await store.referenceAdvertisement.findFirst({
      where: { workspaceId: mine, referenceKey: 'their-ad' },
    });
    expect(byKey).toBeNull();
  });

  it('scopes checksum lookups per workspace, so one tenant cannot probe another', async () => {
    const store = new InMemoryReferenceStore();
    await store.referenceMedia.create({
      data: {
        workspaceId: '11111111-2222-4333-8444-555555555555',
        referenceAdvertisementId: 'a',
        checksumSha256: 'b'.repeat(64),
      },
    });

    const found = await store.referenceMedia.findFirst({
      where: {
        workspaceId: '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e',
        checksumSha256: 'b'.repeat(64),
      },
    });
    expect(found).toBeNull();
  });
});

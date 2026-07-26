import { describe, expect, it } from 'vitest';

import {
  assertReferenceMayBeGenerationInput,
  describeReferenceProvenance,
  gateReferenceImages,
} from './reference-rights';
import type { ReferenceImageInput } from '../video-generation';

const NOW = new Date('2026-07-26T00:00:00Z');

function reference(overrides: Partial<ReferenceImageInput> = {}): ReferenceImageInput {
  return {
    assetId: 'asset-1',
    rights: {
      usageClass: 'OWNED',
      rightsHolder: 'Combat Reviews',
      licenseType: 'FULL_BUY_OUT',
    },
    ...overrides,
  };
}

describe('generation-input rights gate', () => {
  it('admits OWNED, LICENSED_FOR_OUTPUT and GENERATED references', () => {
    for (const usageClass of ['OWNED', 'LICENSED_FOR_OUTPUT', 'GENERATED'] as const) {
      expect(() =>
        assertReferenceMayBeGenerationInput(
          reference({
            rights: { usageClass, rightsHolder: 'Combat Reviews', licenseType: 'X' },
          }),
          { now: NOW },
        ),
      ).not.toThrow();
    }
  });

  it('refuses an ANALYSIS_ONLY reference, non-retryably', () => {
    try {
      assertReferenceMayBeGenerationInput(
        reference({
          rights: {
            usageClass: 'ANALYSIS_ONLY',
            rightsHolder: 'Third party',
            licenseType: 'REFERENCE',
          },
        }),
        { now: NOW },
      );
      expect.unreachable('expected the ANALYSIS_ONLY reference to be refused');
    } catch (error) {
      expect(error).toMatchObject({
        failure: { reason: 'PROVIDER_REJECTED', retryable: false },
      });
      expect((error as Error).message).toContain('never sent as generation input');
    }
  });

  it('fails closed when rights metadata is missing entirely', () => {
    expect(() => assertReferenceMayBeGenerationInput({ assetId: 'asset-1' }, { now: NOW })).toThrow(
      /no rights metadata/,
    );
  });

  it('fails closed on an unrecognised usage class', () => {
    expect(() =>
      assertReferenceMayBeGenerationInput(
        reference({
          rights: {
            usageClass: 'SOMETHING_NEW' as never,
            rightsHolder: 'X',
            licenseType: 'Y',
          },
        }),
        { now: NOW },
      ),
    ).toThrow(/not eligible as generation input/);
  });

  it('refuses a reference whose licence has expired', () => {
    expect(() =>
      assertReferenceMayBeGenerationInput(
        reference({
          rights: {
            usageClass: 'LICENSED_FOR_OUTPUT',
            rightsHolder: 'Stock house',
            licenseType: 'LIMITED_USAGE',
            expiresAt: '2026-07-25T00:00:00Z',
          },
        }),
        { now: NOW },
      ),
    ).toThrow(/expired/);
  });

  it('admits a reference whose licence is still current', () => {
    expect(() =>
      assertReferenceMayBeGenerationInput(
        reference({
          rights: {
            usageClass: 'LICENSED_FOR_OUTPUT',
            rightsHolder: 'Stock house',
            licenseType: 'LIMITED_USAGE',
            expiresAt: '2027-01-01T00:00:00Z',
          },
        }),
        { now: NOW },
      ),
    ).not.toThrow();
  });

  it('refuses an unparseable expiry rather than ignoring it', () => {
    expect(() =>
      assertReferenceMayBeGenerationInput(
        reference({
          rights: {
            usageClass: 'OWNED',
            rightsHolder: 'Combat Reviews',
            licenseType: 'FULL_BUY_OUT',
            expiresAt: 'next tuesday',
          },
        }),
        { now: NOW },
      ),
    ).toThrow(/unparseable licence expiry/);
  });

  it('refuses a reference that names no rights holder', () => {
    expect(() =>
      assertReferenceMayBeGenerationInput(
        reference({
          rights: { usageClass: 'OWNED', rightsHolder: '   ', licenseType: 'FULL_BUY_OUT' },
        }),
        { now: NOW },
      ),
    ).toThrow(/names no rights holder/);
  });

  it('throws on the first refusal rather than silently dropping references', () => {
    expect(() =>
      gateReferenceImages(
        [
          reference({ assetId: 'ok' }),
          reference({
            assetId: 'bad',
            rights: {
              usageClass: 'ANALYSIS_ONLY',
              rightsHolder: 'Third party',
              licenseType: 'REFERENCE',
            },
          }),
        ],
        { now: NOW },
      ),
    ).toThrow(/bad/);
  });
});

describe('reference provenance', () => {
  it('records each reference’s asset id, role and usage class', () => {
    expect(
      describeReferenceProvenance([
        reference({ assetId: 'a', role: 'START_FRAME' }),
        reference({ assetId: 'b' }),
      ]),
    ).toEqual([
      { assetId: 'a', role: 'START_FRAME', usageClass: 'OWNED' },
      { assetId: 'b', role: 'STYLE', usageClass: 'OWNED' },
    ]);
  });
});

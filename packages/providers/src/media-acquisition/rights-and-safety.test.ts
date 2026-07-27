import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertLifecycleTransition,
  MEDIA_CANDIDATE_STATES,
  mediaAcquisitionGrantsNoReferenceUse,
  MEDIA_ACQUISITION_PROVIDERS,
  MediaLifecycleError,
  type LicenceFamily,
  type MediaRightsFacts,
} from './contracts';
import {
  approvalCoversUsage,
  buildAttribution,
  evaluateMediaRights,
  isInternalEvaluationOnly,
  requiresAttribution,
} from './rights-policy';
import { assertAllowedUrl, downloadMediaBytes, MediaHttpError, sniffMediaBytes } from './http';
import { startFakeMediaApi, type FakeMediaApi } from './testing/fake-media-api';

/**
 * The rules that decide whether third-party footage may be published, and the
 * network boundary that decides what may be fetched at all.
 *
 * These are the two places where a defect is not a bug report — it is either an
 * infringement or a request made from inside the network on somebody else's
 * behalf. Everything here is exhaustive by intent rather than representative.
 */

const CLEAN_FACTS: MediaRightsFacts = {
  declaredLicence: 'CC0 1.0',
  licenceFamily: 'CC0',
  creator: 'A Photographer',
  commercialUse: 'PERMITTED',
  derivativeUse: 'PERMITTED',
  paidAdvertisingUse: 'PERMITTED',
  recognizablePersonRisk: 'NONE_APPARENT',
  trademarkOrLogoRisk: 'NONE_APPARENT',
  endorsementRisk: 'LOW',
  modelReleaseStatus: 'NOT_APPLICABLE',
  propertyReleaseStatus: 'NOT_APPLICABLE',
  sourceRestrictions: [],
};

const LANDING = 'https://example.test/item/1';

function evaluate(overrides: Partial<MediaRightsFacts>, isGovernmentPublicAffairs = false) {
  return evaluateMediaRights({
    facts: { ...CLEAN_FACTS, ...overrides },
    landingPageUrl: LANDING,
    isGovernmentPublicAffairs,
  });
}

describe('the licence allow/review/reject matrix', () => {
  const automaticallyEligible: readonly LicenceFamily[] = [
    'CC0',
    'PUBLIC_DOMAIN',
    'PUBLIC_DOMAIN_MARK',
    'US_GOVERNMENT_PUBLIC_DOMAIN',
    'CC_BY',
    'PEXELS_LICENCE',
    'PIXABAY_CONTENT_LICENCE',
  ];

  it.each(automaticallyEligible)('%s clears the policy when nothing else objects', (family) => {
    expect(evaluate({ licenceFamily: family }).outcome).toBe('AUTOMATICALLY_ELIGIBLE');
  });

  const rejected: readonly LicenceFamily[] = [
    'CC_BY_NC',
    'CC_BY_ND',
    'CC_BY_NC_SA',
    'CC_BY_NC_ND',
    'EDITORIAL_ONLY',
    'PERSONAL_USE_ONLY',
    'STANDARD_YOUTUBE_LICENCE',
    'ALL_RIGHTS_RESERVED',
    'UNKNOWN',
  ];

  it.each(rejected)('%s is refused with the specific term named', (family) => {
    const decision = evaluate({ licenceFamily: family });
    expect(decision.outcome).toBe('REJECTED');
    expect(decision.reasons.join(' ').length).toBeGreaterThan(20);
    expect(decision.candidateUsages).toEqual([]);
  });

  it('CC BY-SA always needs a person, because share-alike binds the finished advertisement', () => {
    const decision = evaluate({ licenceFamily: 'CC_BY_SA' });
    expect(decision.outcome).toBe('REVIEW_REQUIRED');
    expect(decision.reasons.join(' ')).toContain('share-alike');
  });

  it('a rejection is absolute — a clean risk profile beside it changes nothing', () => {
    expect(
      evaluate({
        licenceFamily: 'CC_BY_NC',
        recognizablePersonRisk: 'NONE_APPARENT',
        trademarkOrLogoRisk: 'NONE_APPARENT',
        endorsementRisk: 'LOW',
      }).outcome,
    ).toBe('REJECTED');
  });

  it('review is sticky — one trigger beside many clean facts still means review', () => {
    expect(evaluate({ recognizablePersonRisk: 'PRESENT' }).outcome).toBe('REVIEW_REQUIRED');
    expect(evaluate({ trademarkOrLogoRisk: 'PRESENT' }).outcome).toBe('REVIEW_REQUIRED');
    expect(evaluate({ endorsementRisk: 'HIGH' }).outcome).toBe('REVIEW_REQUIRED');
    expect(evaluate({ modelReleaseStatus: 'NOT_PROVIDED' }).outcome).toBe('REVIEW_REQUIRED');
    expect(evaluate({ propertyReleaseStatus: 'UNKNOWN' }).outcome).toBe('REVIEW_REQUIRED');
  });

  it('identifiable people are always a review, and the reason says why', () => {
    const decision = evaluate({ recognizablePersonRisk: 'PRESENT' });
    expect(decision.reasons.join(' ')).toContain('model release');
  });

  it('drops paid social from the candidate usages when paid permission is unsettled', () => {
    const decision = evaluate({ paidAdvertisingUse: 'UNKNOWN' });
    expect(decision.outcome).toBe('REVIEW_REQUIRED');
    expect(decision.candidateUsages).toEqual(['INTERNAL_EVALUATION', 'ORGANIC_SOCIAL']);
  });

  it('refuses on a prohibiting restriction phrase whatever the licence family says', () => {
    const decision = evaluate({ sourceRestrictions: ['Editorial use only. No advertising.'] });
    expect(decision.outcome).toBe('REJECTED');
  });

  it('reviews on a conditional restriction phrase', () => {
    const decision = evaluate({
      sourceRestrictions: ['A model release is required for commercial use.'],
    });
    expect(decision.outcome).toBe('REVIEW_REQUIRED');
  });

  it('forces a review for US government public-affairs material, every time', () => {
    const decision = evaluate({ licenceFamily: 'US_GOVERNMENT_PUBLIC_DOMAIN' }, true);
    expect(decision.outcome).toBe('REVIEW_REQUIRED');
    expect(decision.reasons.join(' ')).toContain('non-endorsement');
  });

  it('never reports automatic eligibility as an approval', () => {
    const decision = evaluate({});
    expect(decision.reasons.join(' ')).toContain('not an approval');
  });

  it('generates a CC BY credit line from the facts', () => {
    const decision = evaluate({
      licenceFamily: 'CC_BY',
      declaredLicence: 'CC BY 4.0',
      licenceUrl: 'https://cc.test/by',
    });
    expect(requiresAttribution('CC_BY')).toBe(true);
    expect(decision.requiredAttribution).toBe(
      'A Photographer — CC BY 4.0 (https://cc.test/by) — https://example.test/item/1',
    );
  });

  it('prefers the provider’s own attribution wording when it supplied one', () => {
    expect(buildAttribution({ ...CLEAN_FACTS, attributionText: 'Photo by X, CC0' }, LANDING)).toBe(
      'Photo by X, CC0',
    );
  });

  it('requires no credit for CC0 or a stock licence', () => {
    expect(requiresAttribution('CC0')).toBe(false);
    expect(requiresAttribution('PEXELS_LICENCE')).toBe(false);
  });
});

describe('approval coverage', () => {
  const approval = {
    approvedUsages: ['INTERNAL_EVALUATION', 'ORGANIC_SOCIAL'] as const,
    effectiveDate: '2026-07-01T00:00:00.000Z',
  };
  const now = new Date('2026-07-27T00:00:00.000Z');

  it('covers an approved usage in date', () => {
    expect(approvalCoversUsage(approval, 'ORGANIC_SOCIAL', now).covered).toBe(true);
  });

  it('refuses a usage outside the approval', () => {
    expect(approvalCoversUsage(approval, 'PAID_SOCIAL', now).covered).toBe(false);
  });

  it('refuses before the effective date and after the expiry', () => {
    expect(
      approvalCoversUsage(approval, 'ORGANIC_SOCIAL', new Date('2026-06-01T00:00:00.000Z')).covered,
    ).toBe(false);
    expect(
      approvalCoversUsage(
        { ...approval, expiresAt: '2026-07-10T00:00:00.000Z' },
        'ORGANIC_SOCIAL',
        now,
      ).covered,
    ).toBe(false);
  });

  it('identifies an internal-evaluation-only approval as a different kind of permission', () => {
    expect(isInternalEvaluationOnly({ approvedUsages: ['INTERNAL_EVALUATION'] })).toBe(true);
    expect(
      isInternalEvaluationOnly({ approvedUsages: ['INTERNAL_EVALUATION', 'ORGANIC_SOCIAL'] }),
    ).toBe(false);
  });
});

describe('the lifecycle', () => {
  it('advances exactly one station at a time', () => {
    for (let index = 0; index + 1 < MEDIA_CANDIDATE_STATES.length; index += 1) {
      expect(() =>
        assertLifecycleTransition(
          MEDIA_CANDIDATE_STATES[index] as never,
          MEDIA_CANDIDATE_STATES[index + 1] as never,
        ),
      ).not.toThrow();
    }
  });

  it('refuses a skip and names what was skipped', () => {
    expect(() => assertLifecycleTransition('DISCOVERED', 'OUTPUT_ELIGIBLE')).toThrow(
      MediaLifecycleError,
    );
    try {
      assertLifecycleTransition('DISCOVERED', 'OUTPUT_ELIGIBLE');
    } catch (error) {
      expect((error as Error).message).toContain('RIGHTS_REVIEW_REQUIRED');
    }
  });

  it('refuses "downloaded therefore eligible" specifically', () => {
    expect(() => assertLifecycleTransition('DOWNLOADED', 'OUTPUT_ELIGIBLE')).toThrow(/INSPECTED/);
  });

  it('never runs backwards and never repeats a state', () => {
    expect(() => assertLifecycleTransition('INSPECTED', 'DOWNLOADED')).toThrow(/backwards/);
    expect(() => assertLifecycleTransition('INSPECTED', 'INSPECTED')).toThrow(/itself/);
  });

  it('lets any station reject, and makes rejection terminal', () => {
    expect(() => assertLifecycleTransition('DISCOVERED', 'REJECTED')).not.toThrow();
    expect(() => assertLifecycleTransition('REJECTED', 'DISCOVERED')).toThrow(/terminal/);
  });
});

describe('production and Creative Memory stay separate', () => {
  it.each(MEDIA_ACQUISITION_PROVIDERS)(
    '%s material may never be indexed as a reference',
    (provider) => {
      expect(mediaAcquisitionGrantsNoReferenceUse(provider)).toBe(true);
    },
  );
});

describe('the URL policy', () => {
  const policy = { allowedHosts: ['api.pexels.com', '.pexels.com'] };

  it('accepts an allowlisted https host', () => {
    expect(assertAllowedUrl('https://api.pexels.com/v1/search', policy).host).toBe(
      'api.pexels.com',
    );
    expect(assertAllowedUrl('https://videos.pexels.com/x.mp4', policy).host).toBe(
      'videos.pexels.com',
    );
  });

  it('refuses a host that is not on the list', () => {
    expect(() => assertAllowedUrl('https://attacker.invalid/x', policy)).toThrow(/allowlist/);
  });

  it('refuses http, credentials in the URL, and literal addresses', () => {
    expect(() => assertAllowedUrl('http://api.pexels.com/x', policy)).toThrow(/must be https/);
    expect(() => assertAllowedUrl('https://user:pw@api.pexels.com/x', policy)).toThrow(
      /credentials/,
    );
    expect(() => assertAllowedUrl('https://93.184.216.34/x', policy)).toThrow(
      /literal address|private|loopback/,
    );
  });

  it('refuses the cloud metadata service and private space by name', () => {
    expect(() => assertAllowedUrl('https://169.254.169.254/latest/meta-data/', policy)).toThrow(
      /metadata/,
    );
    expect(() => assertAllowedUrl('https://10.0.0.5/x', policy)).toThrow(/private address space/);
    expect(() => assertAllowedUrl('https://192.168.1.1/x', policy)).toThrow(
      /private address space/,
    );
    expect(() => assertAllowedUrl('https://172.16.0.1/x', policy)).toThrow(/private address space/);
  });

  it('refuses loopback unless a test explicitly opts in', () => {
    expect(() => assertAllowedUrl('https://localhost/x', policy)).toThrow(/loopback/);
    expect(
      assertAllowedUrl('http://127.0.0.1:1234/x', {
        allowedHosts: ['127.0.0.1'],
        allowLoopback: true,
        allowInsecure: true,
      }).port,
    ).toBe('1234');
  });

  it('refuses a suffix near-miss rather than accepting it', () => {
    expect(() => assertAllowedUrl('https://api.pexels.com.attacker.invalid/x', policy)).toThrow(
      /allowlist/,
    );
  });
});

describe('byte sniffing', () => {
  it('recognises the containers each media kind can legitimately use', () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(sniffMediaBytes(mp4, 'VIDEO').matched).toBe(true);
    expect(sniffMediaBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'IMAGE').matched).toBe(true);
    expect(sniffMediaBytes(new Uint8Array([0x49, 0x44, 0x33, 0x03]), 'AUDIO').matched).toBe(true);
  });

  it('refuses a JPEG offered as video', () => {
    expect(sniffMediaBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'VIDEO').matched).toBe(false);
  });

  it('refuses markup, JSON and empty bodies, which is what a quota page looks like', () => {
    const html = new TextEncoder().encode('<!doctype html><html>');
    expect(sniffMediaBytes(html, 'VIDEO')).toEqual({ matched: false, label: 'a markup document' });
    expect(sniffMediaBytes(new TextEncoder().encode('{"error":1}'), 'VIDEO').label).toBe(
      'a JSON document',
    );
    expect(sniffMediaBytes(new Uint8Array(), 'VIDEO').label).toBe('empty');
  });
});

describe('redirect handling', () => {
  let api: FakeMediaApi;

  beforeEach(async () => {
    api = await startFakeMediaApi();
  });
  afterEach(async () => {
    await api.close();
  });

  const loopbackPolicy = (origin: string) => ({
    allowedHosts: [new URL(origin).hostname],
    allowLoopback: true,
    allowInsecure: true,
  });

  it('refuses a redirect that leaves the allowlist', async () => {
    await expect(
      downloadMediaBytes(
        `${api.origin}/trap/redirect-offsite`,
        'VIDEO',
        loopbackPolicy(api.origin),
        {
          requestTimeoutMs: 2000,
          userAgent: 'test',
          maxBytes: 1_000_000,
        },
      ),
    ).rejects.toMatchObject({ kind: 'REDIRECT_ESCAPE' });
  });

  it('refuses a redirect to the cloud metadata service', async () => {
    await expect(
      downloadMediaBytes(
        `${api.origin}/trap/redirect-metadata`,
        'VIDEO',
        loopbackPolicy(api.origin),
        {
          requestTimeoutMs: 2000,
          userAgent: 'test',
          maxBytes: 1_000_000,
        },
      ),
    ).rejects.toMatchObject({ kind: 'REDIRECT_ESCAPE' });
  });

  it('bounds a redirect loop rather than following it forever', async () => {
    await expect(
      downloadMediaBytes(`${api.origin}/trap/redirect-loop`, 'VIDEO', loopbackPolicy(api.origin), {
        requestTimeoutMs: 2000,
        userAgent: 'test',
        maxBytes: 1_000_000,
      }),
    ).rejects.toBeInstanceOf(MediaHttpError);
  });
});

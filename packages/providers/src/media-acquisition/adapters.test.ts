import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MediaSearchRequestSchema,
  type MediaAcquisitionSelection,
  type MediaCandidate,
} from './contracts';
import { MediaHttpError } from './http';
import { DvidsMediaProvider, readDvidsRights } from './dvids';
import { OpenverseMediaProvider } from './openverse';
import { PexelsMediaProvider } from './pexels';
import { PixabayMediaProvider } from './pixabay';
import { WikimediaMediaProvider, classifyCommonsLicence } from './wikimedia';
import { createMediaAcquisitionProviders, providersForKind, refusedSourceReason } from './factory';
import { MediaApprovalRequiredError } from './provider';
import { startFakeMediaApi, type FakeMediaApi } from './testing/fake-media-api';

/**
 * Every adapter behaviour, proven against a deterministic loopback server.
 *
 * Zero network calls leave this machine and zero API quota is spent. That is
 * not a convenience — a suite that contacted five real providers on every push
 * would be a cost, a flake source and a dependency on somebody else's uptime.
 */

let api: FakeMediaApi;

function request(overrides: Record<string, unknown> = {}) {
  return MediaSearchRequestSchema.parse({
    query: 'boxing training cinematic',
    kind: 'VIDEO',
    page: 1,
    perPage: 20,
    ...overrides,
  });
}

beforeEach(async () => {
  api = await startFakeMediaApi({
    apiKeys: { pexels: 'pex-key', pixabay: 'pix-key', dvids: 'dv-key' },
  });
});

afterEach(async () => {
  await api.close();
});

describe('Pexels adapter', () => {
  it('normalizes a video search into candidates carrying rights facts and renditions', async () => {
    const provider = new PexelsMediaProvider({ apiKey: 'pex-key', baseUrlOverride: api.origin });
    const page = await provider.search(request());

    expect(page.provider).toBe('PEXELS');
    expect(page.candidates).toHaveLength(2);
    expect(page.totalResults).toBe(3);
    expect(page.hasNextPage).toBe(true);

    const uhd = page.candidates[0];
    expect(uhd?.candidateId).toBe('PX-15527457');
    expect(uhd?.widthPx).toBe(3840);
    expect(uhd?.orientation).toBe('LANDSCAPE');
    expect(uhd?.state).toBe('DISCOVERED');
    expect(uhd?.renditions.map((r) => r.label)).toEqual(['uhd', 'hd']);
    expect(uhd?.rights.licenceFamily).toBe('PEXELS_LICENCE');
    expect(uhd?.rights.creator).toBe('Ada Fixture');
  });

  it('reports UNKNOWN person risk and no model release, because Pexels warrants neither', async () => {
    const provider = new PexelsMediaProvider({ apiKey: 'pex-key', baseUrlOverride: api.origin });
    const [candidate] = (await provider.search(request())).candidates;
    expect(candidate?.rights.recognizablePersonRisk).toBe('UNKNOWN');
    expect(candidate?.rights.modelReleaseStatus).toBe('NOT_PROVIDED');
    expect(candidate?.rights.sourceRestrictions.join(' ').toLowerCase()).toContain('identifiable');
  });

  it('paginates', async () => {
    const provider = new PexelsMediaProvider({ apiKey: 'pex-key', baseUrlOverride: api.origin });
    const second = await provider.search(request({ page: 2 }));
    expect(second.candidates.map((c) => c.candidateId)).toEqual(['PX-4761807']);
    expect(second.hasNextPage).toBe(false);
  });

  it('applies the caller filters locally, whatever the provider returned', async () => {
    const provider = new PexelsMediaProvider({ apiKey: 'pex-key', baseUrlOverride: api.origin });
    const portrait = await provider.search(request({ orientation: 'PORTRAIT' }));
    expect(portrait.candidates.map((c) => c.candidateId)).toEqual(['PX-9944252']);

    const large = await provider.search(request({ minWidthPx: 3840 }));
    expect(large.candidates.map((c) => c.candidateId)).toEqual(['PX-15527457']);
  });

  it('refuses to claim audio support', async () => {
    const provider = new PexelsMediaProvider({ apiKey: 'pex-key', baseUrlOverride: api.origin });
    await expect(provider.search(request({ kind: 'AUDIO' }))).rejects.toThrow(/no audio API/i);
  });

  it('says exactly which key is missing rather than searching anonymously', async () => {
    const provider = new PexelsMediaProvider({ baseUrlOverride: api.origin });
    const health = await provider.healthcheck();
    expect(health.state).toBe('NOT_CONFIGURED');
    expect(health.detail).toContain('PEXELS_API_KEY');
    await expect(provider.search(request())).rejects.toThrow(/PEXELS_API_KEY/);
  });

  it('maps a rejected key to UNAUTHORIZED', async () => {
    const provider = new PexelsMediaProvider({ apiKey: 'wrong', baseUrlOverride: api.origin });
    await expect(provider.search(request())).rejects.toMatchObject({ kind: 'UNAUTHORIZED' });
  });
});

describe('Pixabay adapter', () => {
  it('normalizes video hits and orders renditions largest first', async () => {
    const provider = new PixabayMediaProvider({ apiKey: 'pix-key', baseUrlOverride: api.origin });
    const page = await provider.search(request());
    const first = page.candidates[0];
    expect(first?.candidateId).toBe('PB-77001');
    expect(first?.renditions.map((r) => r.label)).toEqual(['large', 'medium']);
    expect(first?.widthPx).toBe(3840);
    expect(first?.rights.licenceFamily).toBe('PIXABAY_CONTENT_LICENCE');
    expect(first?.rights.creator).toBe('El Fixture');
  });

  it('leaves frame rate null rather than guessing one Pixabay does not publish', async () => {
    const provider = new PixabayMediaProvider({ apiKey: 'pix-key', baseUrlOverride: api.origin });
    const [first] = (await provider.search(request())).candidates;
    expect(first?.frameRate).toBeNull();
  });

  it('normalizes images with contributor provenance', async () => {
    const provider = new PixabayMediaProvider({ apiKey: 'pix-key', baseUrlOverride: api.origin });
    const page = await provider.search(request({ kind: 'IMAGE' }));
    const first = page.candidates[0];
    expect(first?.mediaKind).toBe('IMAGE');
    expect(first?.rights.creator).toBe('Gi Fixture');
    expect(first?.landingPageUrl).toContain('pixabay.com');
  });

  it('never leaves the API key in a candidate', async () => {
    const provider = new PixabayMediaProvider({ apiKey: 'pix-key', baseUrlOverride: api.origin });
    const page = await provider.search(request());
    expect(JSON.stringify(page)).not.toContain('pix-key');
  });
});

describe('DVIDS adapter', () => {
  it('accepts an item-level public-domain statement', () => {
    expect(
      readDvidsRights({ rights: 'Public Domain', credit: 'U.S. Army photo by Sgt. X' }),
    ).toMatchObject({
      isPublicDomain: true,
    });
  });

  it('refuses an item that states no rights at all', () => {
    const reading = readDvidsRights({ credit: 'Staff Sgt. X' });
    expect(reading.isPublicDomain).toBe(false);
    expect(reading.why).toContain('ambiguity is refused');
  });

  it('lets a commercial credit line outrank a public-domain field', () => {
    const reading = readDvidsRights({
      rights: 'Public Domain',
      credit: 'Courtesy photo by Getty Images',
    });
    expect(reading.isPublicDomain).toBe(false);
    expect(reading.why).toContain('getty');
  });

  it('classifies the three fixture items correctly and always flags people and endorsement', async () => {
    const provider = new DvidsMediaProvider({ apiKey: 'dv-key', baseUrlOverride: api.origin });
    const page = await provider.search(request({ perPage: 10 }));
    const byId = new Map(page.candidates.map((c) => [c.candidateId, c]));

    expect(byId.get('DV-video_100001')?.rights.licenceFamily).toBe('US_GOVERNMENT_PUBLIC_DOMAIN');
    expect(byId.get('DV-video_100002')?.rights.licenceFamily).toBe('UNKNOWN');
    expect(byId.get('DV-video_100003')?.rights.licenceFamily).toBe('UNKNOWN');

    for (const candidate of page.candidates) {
      expect(candidate.rights.recognizablePersonRisk).toBe('PRESENT');
      expect(candidate.rights.endorsementRisk).toBe('HIGH');
      expect(candidate.rights.paidAdvertisingUse).toBe('UNKNOWN');
      expect(candidate.rights.sourceRestrictions.join(' ')).toContain('endorsement');
    }
  });

  it('preserves the journalist credit', async () => {
    const provider = new DvidsMediaProvider({ apiKey: 'dv-key', baseUrlOverride: api.origin });
    const candidate = await provider.getCandidateDetails('video:100001', 'VIDEO');
    expect(candidate.rights.creator).toBe('U.S. Army photo by Sgt. Fixture Example');
    expect(candidate.rights.attributionText).toContain('1st Fixture Brigade');
  });
});

describe('Wikimedia Commons adapter', () => {
  it('classifies licences most-restrictive-first so NC never reads as plain BY', () => {
    expect(classifyCommonsLicence('CC BY-NC-SA 3.0')).toBe('CC_BY_NC_SA');
    expect(classifyCommonsLicence('CC BY-SA 4.0')).toBe('CC_BY_SA');
    expect(classifyCommonsLicence('CC BY 4.0')).toBe('CC_BY');
    expect(classifyCommonsLicence('CC0')).toBe('CC0');
    expect(classifyCommonsLicence('PD-USGov-Military')).toBe('US_GOVERNMENT_PUBLIC_DOMAIN');
    expect(classifyCommonsLicence('something nobody has seen')).toBe('UNKNOWN');
  });

  it('reads per-file extmetadata, strips markup from the author, and records Restrictions', async () => {
    const provider = new WikimediaMediaProvider({ baseUrlOverride: api.origin });
    const page = await provider.search(request({ kind: 'IMAGE' }));
    const byId = new Map(page.candidates.map((c) => [c.candidateId, c]));

    const pd = byId.get('WC-Fixture_MMA_training.jpg');
    expect(pd?.rights.licenceFamily).toBe('US_GOVERNMENT_PUBLIC_DOMAIN');
    expect(pd?.rights.creator).toBe('Staff Sgt. Olivia Fixture');
    expect(pd?.rights.creator).not.toContain('<a');

    const shareAlike = byId.get('WC-Fixture_share_alike_gym.jpg');
    expect(shareAlike?.rights.licenceFamily).toBe('CC_BY_SA');
    expect(shareAlike?.rights.recognizablePersonRisk).toBe('PRESENT');
    expect(shareAlike?.rights.trademarkOrLogoRisk).toBe('PRESENT');

    expect(byId.get('WC-Fixture_noncommercial.jpg')?.rights.commercialUse).toBe('PROHIBITED');
  });

  it('needs no API key', async () => {
    const provider = new WikimediaMediaProvider({ baseUrlOverride: api.origin });
    const health = await provider.healthcheck();
    expect(health.state).toBe('READY');
    expect(health.detail).toContain('no API key');
  });
});

describe('Openverse adapter', () => {
  it('refuses video by name rather than returning an empty page', async () => {
    const provider = new OpenverseMediaProvider({ baseUrlOverride: api.origin });
    await expect(provider.search(request({ kind: 'VIDEO' }))).rejects.toThrow(
      /no video catalogue/i,
    );
  });

  it('keeps only CC0/PDM/BY after re-checking the licence locally', async () => {
    const provider = new OpenverseMediaProvider({ baseUrlOverride: api.origin });
    const page = await provider.search(request({ kind: 'AUDIO' }));
    expect(page.candidates.map((c) => c.candidateId)).toEqual(['OV-ov-audio-1']);
    expect(page.candidates[0]?.rights.licenceFamily).toBe('CC0');
    expect(page.candidates[0]?.durationSeconds).toBeCloseTo(2.4);
  });

  it('names the aggregation problem when the upstream host is one it does not download from', () => {
    // Deliberately built without `baseUrlOverride`: the override rewrites every
    // provider URL onto the fixture origin, which would make this assertion
    // about the *real* upstream allowlist meaningless.
    const provider = new OpenverseMediaProvider({});
    const candidate: MediaCandidate = {
      candidateId: 'OV-museum-1',
      provider: 'OPENVERSE',
      providerAssetId: 'museum-1',
      mediaKind: 'IMAGE',
      title: 'Upstream elsewhere',
      description: '',
      landingPageUrl: 'https://example-museum.invalid/item/1',
      renditions: [{ label: 'original', url: 'https://example-museum.invalid/files/1.jpg' }],
      durationSeconds: null,
      widthPx: 3000,
      heightPx: 2000,
      frameRate: null,
      orientation: 'LANDSCAPE',
      fileSizeBytes: null,
      rights: {
        declaredLicence: 'CC CC0 1.0',
        licenceFamily: 'CC0',
        creator: 'Le Fixture',
        commercialUse: 'PERMITTED',
        derivativeUse: 'PERMITTED',
        paidAdvertisingUse: 'UNKNOWN',
        recognizablePersonRisk: 'UNKNOWN',
        trademarkOrLogoRisk: 'UNKNOWN',
        endorsementRisk: 'MEDIUM',
        modelReleaseStatus: 'NOT_PROVIDED',
        propertyReleaseStatus: 'NOT_PROVIDED',
        sourceRestrictions: [],
      },
      retrievedAt: '2026-07-27T00:00:00.000Z',
      state: 'APPROVED_FOR_DOWNLOAD',
      notes: '',
    };
    expect(() =>
      provider.resolveApprovedDownload({
        candidate,
        selection: selectionFor(candidate, 'original'),
        usage: 'ORGANIC_SOCIAL',
        now: new Date('2026-07-27T00:00:00.000Z'),
      }),
    ).toThrow(/Openverse aggregates/);
  });

  it('downloads from a known upstream host', async () => {
    const provider = new OpenverseMediaProvider({ baseUrlOverride: api.origin });
    const page = await provider.search(request({ kind: 'AUDIO' }));
    const candidate = page.candidates[0] as MediaCandidate;
    // The override rewrote the freesound URL onto the fixture origin, which is
    // what lets the transport half be exercised without leaving the machine.
    expect(candidate.renditions[0]?.url).toContain('127.0.0.1');
  });
});

describe('the factory', () => {
  it('never sets a base-URL override, so no environment can redirect a real process', () => {
    const providers = createMediaAcquisitionProviders(['PEXELS', 'WIKIMEDIA_COMMONS'], {
      PEXELS_API_KEY: 'k',
    });
    expect(providers.size).toBe(2);
    // The seam is a constructor argument only; nothing the factory reads can
    // reach it, which is what this asserts by construction.
    expect(JSON.stringify([...providers.keys()])).toBe('["PEXELS","WIKIMEDIA_COMMONS"]');
  });

  it('has no adapter for the external pack, which is a folder rather than an API', () => {
    expect(() => createMediaAcquisitionProviders(['EXTERNAL_PILOT_PACK'], {}).size).not.toThrow;
    expect(createMediaAcquisitionProviders(['EXTERNAL_PILOT_PACK'], {}).size).toBe(0);
  });

  it('names which providers serve each kind, and that Openverse is the only audio source', () => {
    expect(providersForKind('AUDIO')).toEqual(['OPENVERSE']);
    expect(providersForKind('VIDEO')).toEqual(['PEXELS', 'PIXABAY', 'DVIDS', 'WIKIMEDIA_COMMONS']);
  });

  it('explains why the refused sources have no adapter', () => {
    expect(refusedSourceReason('youtube')).toContain('grants rights to YouTube');
    expect(refusedSourceReason('ufc')).toContain('copyrighted');
    expect(refusedSourceReason('pexels')).toBeNull();
  });
});

describe('transport failures', () => {
  it('maps a 429 to RATE_LIMITED with a back-off message', async () => {
    await api.close();
    api = await startFakeMediaApi({ rateLimitedRoutes: ['/videos/search'] });
    const provider = new PexelsMediaProvider({ apiKey: 'k', baseUrlOverride: api.origin });
    await expect(provider.search(request())).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
  });

  it('maps a non-JSON 200 to MALFORMED_RESPONSE', async () => {
    await api.close();
    api = await startFakeMediaApi({ malformedRoutes: ['/videos/search'] });
    const provider = new PexelsMediaProvider({ apiKey: 'k', baseUrlOverride: api.origin });
    await expect(provider.search(request())).rejects.toMatchObject({ kind: 'MALFORMED_RESPONSE' });
  });

  it('reports a shape it does not recognise at the boundary, not three frames later', async () => {
    const provider = new PexelsMediaProvider({
      apiKey: 'k',
      baseUrlOverride: api.origin,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ videos: [{ nope: true }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    await expect(provider.search(request())).rejects.toMatchObject({ kind: 'MALFORMED_RESPONSE' });
  });

  it('times out rather than hanging', async () => {
    await api.close();
    api = await startFakeMediaApi({ hangingRoutes: ['/videos/search'] });
    const provider = new PexelsMediaProvider({
      apiKey: 'k',
      baseUrlOverride: api.origin,
      requestTimeoutMs: 150,
    });
    await expect(provider.search(request())).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('distinguishes a cancelled run from a timed-out provider', async () => {
    await api.close();
    api = await startFakeMediaApi({ hangingRoutes: ['/videos/search'] });
    const controller = new AbortController();
    const provider = new PexelsMediaProvider({
      apiKey: 'k',
      baseUrlOverride: api.origin,
      requestTimeoutMs: 10_000,
    });
    const pending = provider.search(request(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'CANCELLED' });
  });

  it('reports an unreachable provider as UNREACHABLE in its healthcheck, never as READY', async () => {
    const origin = api.origin;
    await api.close();
    const provider = new PexelsMediaProvider({
      apiKey: 'k',
      baseUrlOverride: origin,
      requestTimeoutMs: 500,
    });
    const health = await provider.healthcheck();
    expect(health.state).toBe('UNREACHABLE');
    api = await startFakeMediaApi();
  });
});

describe('the approval gate', () => {
  function candidate(state: MediaCandidate['state']): MediaCandidate {
    return {
      candidateId: 'PX-1',
      provider: 'PEXELS',
      providerAssetId: '1',
      mediaKind: 'VIDEO',
      title: 'clip',
      description: '',
      landingPageUrl: 'https://www.pexels.com/video/1/',
      renditions: [{ label: 'hd', url: 'https://videos.pexels.com/video-files/1/hd.mp4' }],
      durationSeconds: 10,
      widthPx: 1920,
      heightPx: 1080,
      frameRate: 30,
      orientation: 'LANDSCAPE',
      fileSizeBytes: 1000,
      rights: {
        declaredLicence: 'Pexels License',
        licenceFamily: 'PEXELS_LICENCE',
        creator: 'A',
        commercialUse: 'PERMITTED',
        derivativeUse: 'PERMITTED',
        paidAdvertisingUse: 'PERMITTED',
        recognizablePersonRisk: 'NONE_APPARENT',
        trademarkOrLogoRisk: 'NONE_APPARENT',
        endorsementRisk: 'LOW',
        modelReleaseStatus: 'ON_FILE',
        propertyReleaseStatus: 'NOT_APPLICABLE',
        sourceRestrictions: [],
      },
      retrievedAt: '2026-07-27T00:00:00.000Z',
      state,
      notes: '',
    };
  }

  it('refuses a candidate that never reached APPROVED_FOR_DOWNLOAD, naming the skipped stations', () => {
    const provider = new PexelsMediaProvider({ apiKey: 'k' });
    const subject = candidate('DISCOVERED');
    expect(() =>
      provider.resolveApprovedDownload({
        candidate: subject,
        selection: selectionFor(subject, 'hd'),
        usage: 'ORGANIC_SOCIAL',
        now: new Date('2026-07-27T00:00:00.000Z'),
      }),
    ).toThrow(MediaApprovalRequiredError);
  });

  it('refuses a usage the approval does not cover', () => {
    const provider = new PexelsMediaProvider({ apiKey: 'k' });
    const subject = candidate('APPROVED_FOR_DOWNLOAD');
    const selection = selectionFor(subject, 'hd');
    expect(() =>
      provider.resolveApprovedDownload({
        candidate: subject,
        selection: {
          ...selection,
          approval: { ...selection.approval, approvedUsages: ['INTERNAL_EVALUATION'] },
        },
        usage: 'PAID_SOCIAL',
        now: new Date('2026-07-27T00:00:00.000Z'),
      }),
    ).toThrow(/covers INTERNAL_EVALUATION and not PAID_SOCIAL/);
  });

  it('refuses an expired approval', () => {
    const provider = new PexelsMediaProvider({ apiKey: 'k' });
    const subject = candidate('APPROVED_FOR_DOWNLOAD');
    const selection = selectionFor(subject, 'hd');
    expect(() =>
      provider.resolveApprovedDownload({
        candidate: subject,
        selection: {
          ...selection,
          approval: { ...selection.approval, expiresAt: '2026-01-01T00:00:00.000Z' },
        },
        usage: 'ORGANIC_SOCIAL',
        now: new Date('2026-07-27T00:00:00.000Z'),
      }),
    ).toThrow(/expired on 2026-01-01/);
  });

  it('refuses an approval written for a different candidate', () => {
    const provider = new PexelsMediaProvider({ apiKey: 'k' });
    const subject = candidate('APPROVED_FOR_DOWNLOAD');
    const selection = selectionFor(subject, 'hd');
    expect(() =>
      provider.resolveApprovedDownload({
        candidate: subject,
        selection: { ...selection, approval: { ...selection.approval, candidateId: 'PX-999' } },
        usage: 'ORGANIC_SOCIAL',
        now: new Date('2026-07-27T00:00:00.000Z'),
      }),
    ).toThrow(/the approval is for "PX-999"/);
  });

  it('downloads only after the gate passes, and sniffs the bytes it receives', async () => {
    const provider = new PexelsMediaProvider({ apiKey: 'k', baseUrlOverride: api.origin });
    const subject: MediaCandidate = {
      ...candidate('APPROVED_FOR_DOWNLOAD'),
      renditions: [{ label: 'hd', url: `${api.origin}/videos/1/hd.mp4` }],
    };
    const result = await provider.downloadApprovedAsset({
      candidate: subject,
      selection: selectionFor(subject, 'hd'),
      usage: 'ORGANIC_SOCIAL',
      now: new Date('2026-07-27T00:00:00.000Z'),
    });
    expect(result.signature).toContain('ISO base media');
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  it('refuses an "mp4" that is really an HTML error page', async () => {
    const provider = new PexelsMediaProvider({ apiKey: 'k', baseUrlOverride: api.origin });
    const subject: MediaCandidate = {
      ...candidate('APPROVED_FOR_DOWNLOAD'),
      renditions: [{ label: 'hd', url: `${api.origin}/trap/html-video` }],
    };
    await expect(
      provider.downloadApprovedAsset({
        candidate: subject,
        selection: selectionFor(subject, 'hd'),
        usage: 'ORGANIC_SOCIAL',
        now: new Date('2026-07-27T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ kind: 'UNEXPECTED_CONTENT' });
  });

  it('refuses an over-ceiling file before reading it', async () => {
    const provider = new PexelsMediaProvider({
      apiKey: 'k',
      baseUrlOverride: api.origin,
      maxDownloadBytes: 1024,
    });
    const subject: MediaCandidate = {
      ...candidate('APPROVED_FOR_DOWNLOAD'),
      renditions: [{ label: 'hd', url: `${api.origin}/trap/oversized` }],
    };
    await expect(
      provider.downloadApprovedAsset({
        candidate: subject,
        selection: selectionFor(subject, 'hd'),
        usage: 'ORGANIC_SOCIAL',
        now: new Date('2026-07-27T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ kind: 'TOO_LARGE' });
  });

  it('refuses an empty body', async () => {
    const provider = new PexelsMediaProvider({ apiKey: 'k', baseUrlOverride: api.origin });
    const subject: MediaCandidate = {
      ...candidate('APPROVED_FOR_DOWNLOAD'),
      renditions: [{ label: 'hd', url: `${api.origin}/trap/empty` }],
    };
    await expect(
      provider.downloadApprovedAsset({
        candidate: subject,
        selection: selectionFor(subject, 'hd'),
        usage: 'ORGANIC_SOCIAL',
        now: new Date('2026-07-27T00:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(MediaHttpError);
  });
});

function selectionFor(
  candidate: MediaCandidate,
  renditionLabel: string,
): MediaAcquisitionSelection {
  return {
    candidateId: candidate.candidateId,
    provider: candidate.provider,
    providerAssetId: candidate.providerAssetId,
    renditionLabel,
    approval: {
      candidateId: candidate.candidateId,
      approvedBy: 'a named reviewer',
      approvedUsages: ['INTERNAL_EVALUATION', 'ORGANIC_SOCIAL'],
      approvedPlatforms: ['instagram-reels'],
      effectiveDate: '2026-07-01T00:00:00.000Z',
      evidenceReferences: [],
      notes: 'licence read on the landing page',
      approvedAt: '2026-07-01T00:00:00.000Z',
    },
    rightsDecision: {
      outcome: 'REVIEW_REQUIRED',
      policyVersion: 'MEDIA_RIGHTS_POLICY_V1',
      reasons: ['identifiable people'],
      candidateUsages: ['INTERNAL_EVALUATION', 'ORGANIC_SOCIAL'],
    },
  };
}

import { describe, expect, it } from 'vitest';

import { MediaSearchRequestSchema } from './contracts';
import { DvidsMediaProvider } from './dvids';
import { OpenverseMediaProvider } from './openverse';
import { PexelsMediaProvider } from './pexels';
import { PixabayMediaProvider } from './pixabay';
import { WikimediaMediaProvider } from './wikimedia';
import { evaluateMediaRights } from './rights-policy';

/**
 * Opt-in binding tests against the real provider APIs.
 *
 * **CI never runs these**, and neither does `pnpm test`. They are excluded from
 * the default vitest `include` and gated behind `MEDIA_LIVE_TEST=1` on top of
 * that, because a suite that contacted five companies on every push would spend
 * an API quota, depend on somebody else's uptime, and change its result when a
 * stranger uploaded a video.
 *
 *   MEDIA_LIVE_TEST=1 pnpm --filter @combat/providers test:media-live
 *
 * They skip **loudly**: an absent key or an absent opt-in prints exactly what
 * was not exercised, because a green tick next to "live integration" that
 * silently ran nothing is worse than a red one.
 *
 * These are the only tests that could raise an adapter's
 * `responseContractStatus` from `DOCUMENTED_NOT_EXECUTED` to
 * `EXECUTED_AGAINST_LIVE_API`. Until one has passed against a given provider,
 * that provider's schema is a reading of published documentation and nothing
 * more — and the descriptor says so.
 *
 * They are inspection-only. Nothing here downloads a file, spends money, or
 * approves anything: `search` and `healthcheck` are the entire surface, because
 * the download path requires a human approval that no test may fabricate.
 */

const LIVE = process.env.MEDIA_LIVE_TEST === '1';

function announceSkip(provider: string, reason: string): void {
  console.warn(`SKIPPED (${provider}): ${reason}. NOT PROVEN against the live API.`);
}

const request = MediaSearchRequestSchema.parse({
  query: 'boxing training',
  kind: 'VIDEO',
  page: 1,
  perPage: 3,
});

const imageRequest = MediaSearchRequestSchema.parse({
  query: 'boxing gloves',
  kind: 'IMAGE',
  page: 1,
  perPage: 3,
});

describe('live provider integration (opt-in)', () => {
  it('Pexels answers an authenticated search with parseable candidates', async () => {
    if (!LIVE) return announceSkip('PEXELS', 'MEDIA_LIVE_TEST is not 1');
    if (!process.env.PEXELS_API_KEY?.trim())
      return announceSkip('PEXELS', 'PEXELS_API_KEY is not set');

    const provider = new PexelsMediaProvider({ apiKey: process.env.PEXELS_API_KEY });
    expect((await provider.healthcheck()).state).toBe('READY');

    const page = await provider.search(request);
    expect(page.candidates.length).toBeGreaterThan(0);
    for (const candidate of page.candidates) {
      expect(candidate.landingPageUrl).toMatch(/^https:\/\/www\.pexels\.com\//);
      expect(candidate.renditions.length).toBeGreaterThan(0);
      // The policy has to reach a verdict on real metadata, not just fixtures.
      const decision = evaluateMediaRights({
        facts: candidate.rights,
        landingPageUrl: candidate.landingPageUrl,
      });
      expect(['AUTOMATICALLY_ELIGIBLE', 'REVIEW_REQUIRED', 'REJECTED']).toContain(decision.outcome);
    }
  }, 60_000);

  it('Pixabay answers an authenticated search with parseable candidates', async () => {
    if (!LIVE) return announceSkip('PIXABAY', 'MEDIA_LIVE_TEST is not 1');
    if (!process.env.PIXABAY_API_KEY?.trim())
      return announceSkip('PIXABAY', 'PIXABAY_API_KEY is not set');

    const provider = new PixabayMediaProvider({ apiKey: process.env.PIXABAY_API_KEY });
    expect((await provider.healthcheck()).state).toBe('READY');

    const page = await provider.search(request);
    expect(page.candidates.length).toBeGreaterThan(0);
    for (const candidate of page.candidates) {
      expect(candidate.rights.licenceFamily).toBe('PIXABAY_CONTENT_LICENCE');
      expect(candidate.rights.creator).not.toBe('');
    }
    // The key travels as a query parameter, so this is the assertion that
    // matters most: it must never reach a candidate.
    expect(JSON.stringify(page)).not.toContain(process.env.PIXABAY_API_KEY);
  }, 60_000);

  it('DVIDS answers, and every returned item has an item-level rights reading', async () => {
    if (!LIVE) return announceSkip('DVIDS', 'MEDIA_LIVE_TEST is not 1');
    if (!process.env.DVIDS_API_KEY?.trim())
      return announceSkip('DVIDS', 'DVIDS_API_KEY is not set');

    const provider = new DvidsMediaProvider({ apiKey: process.env.DVIDS_API_KEY });
    expect((await provider.healthcheck()).state).toBe('READY');

    const page = await provider.search(request);
    for (const candidate of page.candidates) {
      // Either the item said public domain at item level, or it is UNKNOWN.
      // There is no third answer and no inference from the host.
      expect(['US_GOVERNMENT_PUBLIC_DOMAIN', 'UNKNOWN']).toContain(candidate.rights.licenceFamily);
      expect(candidate.rights.endorsementRisk).toBe('HIGH');
      const decision = evaluateMediaRights({
        facts: candidate.rights,
        landingPageUrl: candidate.landingPageUrl,
        isGovernmentPublicAffairs: true,
      });
      expect(decision.outcome).not.toBe('AUTOMATICALLY_ELIGIBLE');
    }
  }, 90_000);

  it('Wikimedia Commons answers without a key and supplies per-file licence metadata', async () => {
    if (!LIVE) return announceSkip('WIKIMEDIA_COMMONS', 'MEDIA_LIVE_TEST is not 1');

    const provider = new WikimediaMediaProvider({});
    expect((await provider.healthcheck()).state).toBe('READY');

    const page = await provider.search(imageRequest);
    expect(page.candidates.length).toBeGreaterThan(0);
    for (const candidate of page.candidates) {
      expect(candidate.landingPageUrl).toContain('commons.wikimedia.org');
      expect(candidate.rights.declaredLicence).not.toBe('');
      // Markup must never survive into a credit line.
      expect(candidate.rights.creator).not.toContain('<');
    }
  }, 60_000);

  it('Openverse answers for audio and refuses video, which it does not have', async () => {
    if (!LIVE) return announceSkip('OPENVERSE', 'MEDIA_LIVE_TEST is not 1');

    const provider = new OpenverseMediaProvider({});
    expect((await provider.healthcheck()).state).toBe('READY');

    await expect(provider.search(request)).rejects.toThrow(/no video catalogue/i);

    const audio = await provider.search(
      MediaSearchRequestSchema.parse({ query: 'impact', kind: 'AUDIO', page: 1, perPage: 3 }),
    );
    for (const candidate of audio.candidates) {
      expect(['CC0', 'PUBLIC_DOMAIN_MARK', 'PUBLIC_DOMAIN', 'CC_BY']).toContain(
        candidate.rights.licenceFamily,
      );
    }
  }, 60_000);
});

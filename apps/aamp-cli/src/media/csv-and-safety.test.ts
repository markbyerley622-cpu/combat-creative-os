import { describe, expect, it } from 'vitest';

import { CsvParseError, parseCsv, readCsvTable } from './csv';
import {
  assertMediaArtefactSafe,
  hostOfUrl,
  safeSourceUrl,
  UnsafeMediaArtefactError,
} from './media-safety';
import { escapeHtml, renderGallery } from './gallery';
import type { MediaAcquisitionRun, MediaCandidate } from '@combat/providers';

describe('the CSV reader', () => {
  it('keeps commas and newlines inside quoted fields', () => {
    const rows = parseCsv('a,b\n"one, two","line\nbreak"\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['one, two', 'line\nbreak'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"he said ""no"""\n')[1]).toEqual(['he said "no"']);
  });

  it('strips a UTF-8 BOM so the first column name is not corrupted', () => {
    const table = readCsvTable('\ufeffcandidate_id,provider\nPX-1,Pexels\n', 'x.csv');
    expect(table.columns[0]).toBe('candidate_id');
    expect(table.rows[0]?.get('candidate_id')).toBe('PX-1');
  });

  it('refuses a document that ends inside a quoted field', () => {
    expect(() => parseCsv('a\n"never closed', 'broken.csv')).toThrow(CsvParseError);
  });

  it('reads a missing column as empty rather than refusing the document', () => {
    const table = readCsvTable('candidate_id\nPX-1\n', 'x.csv');
    expect(table.rows[0]?.get('creator')).toBe('');
    expect(table.rows[0]?.has('creator')).toBe(false);
  });

  it('reports a 1-based source line an operator can find in a spreadsheet', () => {
    const table = readCsvTable('a\nfirst\nsecond\n', 'x.csv');
    expect(table.rows.map((row) => row.line)).toEqual([2, 3]);
  });
});

describe('artefact safety', () => {
  it('refuses an API key wherever it appears', () => {
    expect(() => assertMediaArtefactSafe({ apiKey: 'x' })).toThrow(UnsafeMediaArtefactError);
    expect(() => assertMediaArtefactSafe({ nested: { api_key: 'x' } })).toThrow(
      UnsafeMediaArtefactError,
    );
    expect(() => assertMediaArtefactSafe({ list: [{ key: 'x' }] })).toThrow(
      UnsafeMediaArtefactError,
    );
  });

  it('refuses a credential in a query string, which is how Pixabay authenticates', () => {
    expect(() =>
      assertMediaArtefactSafe({ url: 'https://pixabay.com/api/?key=abcd1234&q=boxing' }),
    ).toThrow(/credential in a query string/);
  });

  it('refuses the download-URL fields somebody adds while debugging', () => {
    expect(() => assertMediaArtefactSafe({ directDownloadUrl: 'https://cdn.test/a.mp4' })).toThrow(
      /forbidden field/,
    );
    expect(() => assertMediaArtefactSafe({ signedUrl: 'https://cdn.test/a.mp4' })).toThrow(
      /forbidden field/,
    );
  });

  it('refuses a local absolute path in a shared artefact', () => {
    expect(() => assertMediaArtefactSafe({ path: 'C:\\Users\\someone\\Desktop\\pack' })).toThrow(
      /local paths belong only/,
    );
    expect(() => assertMediaArtefactSafe({ path: '/home/someone/pack' })).toThrow(
      /local paths belong only/,
    );
  });

  it('permits a local path only where the artefact exists to hold one', () => {
    expect(() =>
      assertMediaArtefactSafe({ path: 'C:\\Users\\someone\\Desktop\\pack' }, 'private', {
        allowLocalPaths: true,
      }),
    ).not.toThrow();
  });

  it('still refuses a credential inside the private artefact', () => {
    expect(() =>
      assertMediaArtefactSafe({ token: 'x' }, 'private', { allowLocalPaths: true }),
    ).toThrow(UnsafeMediaArtefactError);
  });

  it('reports every violation rather than the first', () => {
    try {
      assertMediaArtefactSafe({ apiKey: 'a', nested: { token: 'b' } });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as UnsafeMediaArtefactError).violations).toHaveLength(2);
    }
  });

  it('drops a query string rather than filtering it', () => {
    expect(safeSourceUrl('https://pixabay.com/api/?key=secret&q=x')).toBe(
      'https://pixabay.com/api/',
    );
    expect(hostOfUrl('https://CDN.Pixabay.com/a.mp4')).toBe('cdn.pixabay.com');
  });
});

describe('the gallery', () => {
  const candidate: MediaCandidate = {
    candidateId: 'PX-1',
    provider: 'PEXELS',
    providerAssetId: '1',
    // A stock catalogue holding markup in a title is ordinary, not exotic.
    mediaKind: 'VIDEO',
    title: '<script>alert("x")</script> Boxing',
    description: '',
    landingPageUrl: 'https://www.pexels.com/video/1/',
    previewUrl: 'https://images.pexels.com/videos/1/thumb.jpg',
    renditions: [],
    durationSeconds: 12,
    widthPx: 3840,
    heightPx: 2160,
    frameRate: 30,
    orientation: 'LANDSCAPE',
    fileSizeBytes: null,
    rights: {
      declaredLicence: 'Pexels License',
      licenceFamily: 'PEXELS_LICENCE',
      creator: 'Ada & "Bo"',
      commercialUse: 'PERMITTED',
      derivativeUse: 'PERMITTED',
      paidAdvertisingUse: 'PERMITTED',
      recognizablePersonRisk: 'UNKNOWN',
      trademarkOrLogoRisk: 'UNKNOWN',
      endorsementRisk: 'MEDIUM',
      modelReleaseStatus: 'NOT_PROVIDED',
      propertyReleaseStatus: 'NOT_PROVIDED',
      sourceRestrictions: [],
    },
    retrievedAt: '2026-07-27T00:00:00.000Z',
    state: 'RIGHTS_REVIEW_REQUIRED',
    rightsDecision: {
      outcome: 'REVIEW_REQUIRED',
      policyVersion: 'MEDIA_RIGHTS_POLICY_V1',
      reasons: ['identifiable people may be present'],
      candidateUsages: ['INTERNAL_EVALUATION', 'ORGANIC_SOCIAL'],
    },
    notes: '',
  };

  const run: MediaAcquisitionRun = {
    runVersion: 1,
    runId: 'search-20260727-abc',
    workspaceId: 'combat-reviews',
    origin: 'PROVIDER_SEARCH',
    startedAt: '2026-07-27T00:00:00.000Z',
    providersQueried: ['PEXELS'],
    candidates: [candidate],
    providerProblems: [],
    paidProviderCalls: 0,
  };

  const html = renderGallery({
    run,
    galleryDirectory: 'C:/tmp/gallery',
    now: new Date('2026-07-27T00:00:00.000Z'),
  });

  it('escapes third-party prose', () => {
    expect(escapeHtml('<b>&"x"</b>')).toBe('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('makes no automatic network request — remote previews are links, never images', () => {
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
    expect(html).toContain('makes no network request on its own');
  });

  it('carries no script tag at all', () => {
    expect(html.toLowerCase()).not.toContain('<script');
  });

  it('says on its face that nothing shown is approved', () => {
    expect(html).toContain('NOTHING HERE IS APPROVED');
    expect(html).toContain('is not permission');
  });

  it('shows the rights outcome, the reasons and the risk flags', () => {
    expect(html).toContain('REVIEW_REQUIRED');
    expect(html).toContain('identifiable people may be present');
    expect(html).toContain('model release: NOT_PROVIDED');
  });

  it('never claims to have measured creative quality', () => {
    expect(html).toContain('No score on this page is a judgement of creative quality');
  });
});

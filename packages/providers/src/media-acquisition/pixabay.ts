import { z } from 'zod';

import {
  type MediaCandidate,
  type MediaKind,
  type MediaRendition,
  type MediaRightsFacts,
  type MediaSearchPage,
  type MediaSearchRequest,
} from './contracts';
import { downloadMediaBytes, fetchProviderJson, MediaHttpError } from './http';
import {
  applyRequestFilters,
  boundedText,
  buildCandidate,
  candidateIdFor,
  DEFAULT_MAX_DOWNLOAD_BYTES,
  orientationParam,
  originFor,
  parseProviderResponse,
  requireApiKey,
  resolveHttpOptions,
  rewriteForOverride,
  urlPolicyFor,
  type MediaAdapterConfig,
  type MediaAdapterDescriptor,
} from './adapter-support';
import { hostOf } from './pexels';
import {
  assertDownloadPermitted,
  healthFromError,
  type DownloadApprovedAssetInput,
  type DownloadedMediaBytes,
  type MediaAcquisitionProvider,
  type MediaProviderCallOptions,
  type MediaProviderHealth,
  type MediaRightsEvidence,
  type ResolvedMediaUrl,
} from './provider';

/**
 * Pixabay, through its official API only.
 *
 * The Pixabay Content Licence permits commercial use and modification without
 * attribution, and — unusually among free sources — states its restrictions in
 * terms that map cleanly onto advertising: identifiable persons may not be
 * shown in a bad light or in connection with sensitive subjects, and content
 * showing identifiable people, brands or logos must not be used commercially
 * without permission from the depicted party.
 *
 * That last clause is the reason every Pixabay candidate carries `UNKNOWN`
 * person and trademark risk rather than an optimistic `NONE_APPARENT`: the API
 * publishes tags, not releases, and a tag list is not a clearance.
 *
 * Contributor provenance (`user`, `pageURL`) is preserved on every candidate
 * even though the licence does not compel a credit — a credits file that names
 * the photographer is the difference between "we believe this is licensed" and
 * "here is who made it and where it came from".
 */

export const PIXABAY_DESCRIPTOR: MediaAdapterDescriptor = {
  provider: 'PIXABAY',
  supportedKinds: ['VIDEO', 'IMAGE'],
  requiresApiKey: true,
  apiKeyEnvVar: 'PIXABAY_API_KEY',
  apiHosts: ['pixabay.com'],
  downloadHosts: ['pixabay.com', 'cdn.pixabay.com', '.pixabay.com'],
  responseContractStatus: 'DOCUMENTED_NOT_EXECUTED',
  licenceTermsUrl: 'https://pixabay.com/service/license-summary/',
};

const PIXABAY_ORIGIN = 'https://pixabay.com';

const PIXABAY_RESTRICTIONS: readonly string[] = [
  'Content may not be redistributed or sold on other stock or wallpaper platforms.',
  'Identifiable persons may not be portrayed in a bad light or in a way that is offensive.',
  'Content showing identifiable persons, brands or logos must not be used commercially without permission from the depicted party or rights holder.',
  'Content may not be used in a way that implies endorsement.',
  'Content may not be used to create pornographic, unlawful, defamatory or misleading material.',
];

const PixabayImageHitSchema = z
  .object({
    id: z.number(),
    pageURL: z.string(),
    type: z.string().optional(),
    tags: z.string().optional(),
    previewURL: z.string().optional(),
    webformatURL: z.string().optional(),
    webformatWidth: z.number().optional(),
    webformatHeight: z.number().optional(),
    largeImageURL: z.string().optional(),
    fullHDURL: z.string().optional(),
    imageWidth: z.number().optional(),
    imageHeight: z.number().optional(),
    imageSize: z.number().optional(),
    user: z.string().optional(),
    user_id: z.number().optional(),
  })
  .passthrough();

const PixabayImageResponseSchema = z
  .object({
    total: z.number().optional(),
    totalHits: z.number().optional(),
    hits: z.array(PixabayImageHitSchema).default([]),
  })
  .passthrough();

const PixabayVideoStreamSchema = z
  .object({
    url: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
    size: z.number().optional(),
    thumbnail: z.string().optional(),
  })
  .passthrough();

const PixabayVideoHitSchema = z
  .object({
    id: z.number(),
    pageURL: z.string(),
    type: z.string().optional(),
    tags: z.string().optional(),
    duration: z.number().optional(),
    videos: z.record(PixabayVideoStreamSchema).default({}),
    user: z.string().optional(),
    user_id: z.number().optional(),
  })
  .passthrough();

const PixabayVideoResponseSchema = z
  .object({
    total: z.number().optional(),
    totalHits: z.number().optional(),
    hits: z.array(PixabayVideoHitSchema).default([]),
  })
  .passthrough();

function pixabayRights(user: string | undefined, pageUrl: string): MediaRightsFacts {
  const creator = boundedText(user, 300, 'NOT_STATED');
  return {
    declaredLicence: 'Pixabay Content License',
    licenceFamily: 'PIXABAY_CONTENT_LICENCE',
    licenceUrl: PIXABAY_DESCRIPTOR.licenceTermsUrl,
    creator,
    creatorUrl: pageUrl,
    attributionText: `${creator} via Pixabay`,
    commercialUse: 'PERMITTED',
    derivativeUse: 'PERMITTED',
    // The licence permits commercial use, but the identifiable-persons clause
    // makes paid advertising a per-item question rather than a licence-level
    // one. `UNKNOWN` is the accurate answer and it forces the review.
    paidAdvertisingUse: 'UNKNOWN',
    recognizablePersonRisk: 'UNKNOWN',
    trademarkOrLogoRisk: 'UNKNOWN',
    endorsementRisk: 'MEDIUM',
    modelReleaseStatus: 'NOT_PROVIDED',
    propertyReleaseStatus: 'NOT_PROVIDED',
    sourceRestrictions: [...PIXABAY_RESTRICTIONS],
  };
}

/** Pixabay's own stream labels, largest first so rendition choice is stable. */
const VIDEO_STREAM_ORDER = ['large', 'medium', 'small', 'tiny'];

export class PixabayMediaProvider implements MediaAcquisitionProvider {
  readonly id = 'PIXABAY' as const;

  constructor(private readonly config: MediaAdapterConfig = {}) {}

  async healthcheck(options: MediaProviderCallOptions = {}): Promise<MediaProviderHealth> {
    const configured = Boolean(this.config.apiKey?.trim());
    if (!configured) {
      return {
        provider: this.id,
        state: 'NOT_CONFIGURED',
        detail: 'PIXABAY_API_KEY is not set. Create a free key at https://pixabay.com/api/docs/.',
        supportedKinds: PIXABAY_DESCRIPTOR.supportedKinds,
        credentialConfigured: false,
      };
    }
    try {
      await fetchProviderJson(
        this.url('/api/', { q: 'test', per_page: '3' }),
        urlPolicyFor(PIXABAY_DESCRIPTOR, this.config, 'API'),
        resolveHttpOptions(this.config, options.signal),
      );
      return {
        provider: this.id,
        state: 'READY',
        detail: 'the API answered an authenticated request',
        supportedKinds: PIXABAY_DESCRIPTOR.supportedKinds,
        credentialConfigured: true,
      };
    } catch (error) {
      return healthFromError(this.id, PIXABAY_DESCRIPTOR.supportedKinds, true, error);
    }
  }

  async search(
    request: MediaSearchRequest,
    options: MediaProviderCallOptions = {},
  ): Promise<MediaSearchPage> {
    if (request.kind === 'AUDIO') {
      throw new MediaHttpError(
        'REJECTED',
        'Pixabay publishes music and sound effects on its site but exposes no audio search API; claiming audio support here would be a fabrication',
      );
    }
    const retrievedAt = new Date();
    const params: Record<string, string> = {
      q: request.query,
      // Pixabay's per-page floor is 3 and ceiling is 200.
      per_page: String(Math.min(Math.max(request.perPage, 3), 200)),
      page: String(request.page),
      safesearch: 'true',
    };
    const orientation = orientationParam(request.orientation);

    if (request.kind === 'IMAGE') {
      if (orientation === 'portrait') params.orientation = 'vertical';
      if (orientation === 'landscape') params.orientation = 'horizontal';
      if (request.minWidthPx) params.min_width = String(request.minWidthPx);
      if (request.minHeightPx) params.min_height = String(request.minHeightPx);
      params.image_type = 'photo';

      const body = await fetchProviderJson(
        this.url('/api/', params),
        urlPolicyFor(PIXABAY_DESCRIPTOR, this.config, 'API'),
        resolveHttpOptions(this.config, options.signal),
      );
      const parsed = parseProviderResponse(PixabayImageResponseSchema, body, this.id, '/api/');
      const candidates = parsed.hits.map((hit) => this.toImageCandidate(hit, retrievedAt));
      const totalHits = parsed.totalHits ?? null;
      return {
        provider: this.id,
        candidates: applyRequestFilters(candidates, request),
        page: request.page,
        perPage: request.perPage,
        totalResults: totalHits,
        hasNextPage:
          totalHits === null
            ? parsed.hits.length >= request.perPage
            : request.page * request.perPage < totalHits,
      };
    }

    const body = await fetchProviderJson(
      this.url('/api/videos/', params),
      urlPolicyFor(PIXABAY_DESCRIPTOR, this.config, 'API'),
      resolveHttpOptions(this.config, options.signal),
    );
    const parsed = parseProviderResponse(PixabayVideoResponseSchema, body, this.id, '/api/videos/');
    const candidates = parsed.hits.map((hit) => this.toVideoCandidate(hit, retrievedAt));
    const totalHits = parsed.totalHits ?? null;
    return {
      provider: this.id,
      candidates: applyRequestFilters(candidates, request),
      page: request.page,
      perPage: request.perPage,
      totalResults: totalHits,
      hasNextPage:
        totalHits === null
          ? parsed.hits.length >= request.perPage
          : request.page * request.perPage < totalHits,
    };
  }

  async getCandidateDetails(
    providerAssetId: string,
    kind: MediaKind,
    options: MediaProviderCallOptions = {},
  ): Promise<MediaCandidate> {
    if (kind === 'AUDIO')
      throw new MediaHttpError('REJECTED', 'Pixabay exposes no audio search API');
    // Pixabay has no per-item route; `id=` on the search endpoint is the
    // documented way to fetch one item.
    const route = kind === 'IMAGE' ? '/api/' : '/api/videos/';
    const body = await fetchProviderJson(
      this.url(route, { id: providerAssetId }),
      urlPolicyFor(PIXABAY_DESCRIPTOR, this.config, 'API'),
      resolveHttpOptions(this.config, options.signal),
    );
    const retrievedAt = new Date();
    if (kind === 'IMAGE') {
      const parsed = parseProviderResponse(PixabayImageResponseSchema, body, this.id, route);
      const hit = parsed.hits[0];
      if (!hit) throw new MediaHttpError('REJECTED', `Pixabay has no image ${providerAssetId}`);
      return this.toImageCandidate(hit, retrievedAt);
    }
    const parsed = parseProviderResponse(PixabayVideoResponseSchema, body, this.id, route);
    const hit = parsed.hits[0];
    if (!hit) throw new MediaHttpError('REJECTED', `Pixabay has no video ${providerAssetId}`);
    return this.toVideoCandidate(hit, retrievedAt);
  }

  resolvePreview(candidate: MediaCandidate): ResolvedMediaUrl | null {
    if (!candidate.previewUrl) return null;
    return {
      url: candidate.previewUrl,
      host: hostOf(candidate.previewUrl),
      renditionLabel: 'preview',
      widthPx: null,
      heightPx: null,
      fileSizeBytes: null,
    };
  }

  resolveApprovedDownload(input: DownloadApprovedAssetInput): ResolvedMediaUrl {
    assertDownloadPermitted(input);
    const rendition = input.candidate.renditions.find(
      (entry) => entry.label === input.selection.renditionLabel,
    );
    if (!rendition) {
      throw new MediaHttpError(
        'REJECTED',
        `"${input.selection.renditionLabel}" is not one of ${input.candidate.candidateId}'s renditions`,
      );
    }
    return {
      url: rendition.url,
      host: hostOf(rendition.url),
      renditionLabel: rendition.label,
      widthPx: rendition.widthPx ?? null,
      heightPx: rendition.heightPx ?? null,
      fileSizeBytes: rendition.fileSizeBytes ?? null,
    };
  }

  captureRightsEvidence(candidate: MediaCandidate, capturedAt: Date): MediaRightsEvidence {
    return {
      candidateId: candidate.candidateId,
      provider: this.id,
      declaredLicence: candidate.rights.declaredLicence,
      licenceUrl: candidate.rights.licenceUrl ?? null,
      landingPageUrl: candidate.landingPageUrl,
      creator: candidate.rights.creator,
      creatorUrl: candidate.rights.creatorUrl ?? null,
      restrictions: candidate.rights.sourceRestrictions,
      evidenceBasis: 'PROVIDER_PUBLISHED_TERMS',
      capturedAt: capturedAt.toISOString(),
    };
  }

  async downloadApprovedAsset(
    input: DownloadApprovedAssetInput,
    options: MediaProviderCallOptions = {},
  ): Promise<DownloadedMediaBytes> {
    const resolved = this.resolveApprovedDownload(input);
    const result = await downloadMediaBytes(
      resolved.url,
      input.candidate.mediaKind,
      urlPolicyFor(PIXABAY_DESCRIPTOR, this.config, 'DOWNLOAD'),
      {
        ...resolveHttpOptions(this.config, options.signal),
        maxBytes: this.config.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES,
      },
    );
    return {
      bytes: result.bytes,
      downloadHost: result.finalHost,
      renditionLabel: resolved.renditionLabel,
      contentType: result.contentType,
      signature: result.signature,
    };
  }

  /**
   * Builds a request URL with the API key attached.
   *
   * Pixabay takes the key as a query parameter — there is no header form — so
   * the key is unavoidably in the URL. It is therefore never persisted, never
   * logged, and never carried into an artefact: provenance records a host and a
   * pathname, and `assertMediaArtefactSafe` refuses a credential-shaped query
   * string outright.
   */
  private url(route: string, params: Record<string, string>): string {
    const origin = originFor(PIXABAY_DESCRIPTOR, this.config, PIXABAY_ORIGIN);
    const search = new URLSearchParams({
      key: requireApiKey(PIXABAY_DESCRIPTOR, this.config),
      ...params,
    });
    return `${origin}${route}?${search.toString()}`;
  }

  private toImageCandidate(
    hit: z.infer<typeof PixabayImageHitSchema>,
    retrievedAt: Date,
  ): MediaCandidate {
    const renditions: MediaRendition[] = [];
    // `fullHDURL` and `imageURL` are only present for accounts Pixabay has
    // granted full-resolution access; absence is normal, not an error.
    if (hit.fullHDURL) {
      renditions.push({
        label: 'fullHD',
        url: rewriteForOverride(hit.fullHDURL, this.config),
        fileType: 'jpg',
      });
    }
    if (hit.largeImageURL) {
      renditions.push({
        label: 'large',
        url: rewriteForOverride(hit.largeImageURL, this.config),
        ...(hit.imageWidth ? { widthPx: hit.imageWidth } : {}),
        ...(hit.imageHeight ? { heightPx: hit.imageHeight } : {}),
        ...(hit.imageSize ? { fileSizeBytes: hit.imageSize } : {}),
        fileType: 'jpg',
      });
    }
    if (hit.webformatURL) {
      renditions.push({
        label: 'webformat',
        url: rewriteForOverride(hit.webformatURL, this.config),
        ...(hit.webformatWidth ? { widthPx: hit.webformatWidth } : {}),
        ...(hit.webformatHeight ? { heightPx: hit.webformatHeight } : {}),
        fileType: 'jpg',
      });
    }

    return buildCandidate({
      provider: this.id,
      candidateId: candidateIdFor('PB', String(hit.id)),
      providerAssetId: String(hit.id),
      mediaKind: 'IMAGE',
      title: boundedText(hit.tags, 300, `Pixabay image ${hit.id}`),
      description: boundedText(hit.tags, 2000),
      landingPageUrl: hit.pageURL,
      ...(hit.previewURL ? { previewUrl: rewriteForOverride(hit.previewURL, this.config) } : {}),
      renditions,
      durationSeconds: null,
      widthPx: hit.imageWidth ?? null,
      heightPx: hit.imageHeight ?? null,
      frameRate: null,
      fileSizeBytes: hit.imageSize ?? null,
      rights: pixabayRights(hit.user, hit.pageURL),
      retrievedAt,
    });
  }

  private toVideoCandidate(
    hit: z.infer<typeof PixabayVideoHitSchema>,
    retrievedAt: Date,
  ): MediaCandidate {
    const renditions: MediaRendition[] = VIDEO_STREAM_ORDER.filter(
      (label) => hit.videos[label]?.url,
    ).map((label) => {
      const stream = hit.videos[label] as z.infer<typeof PixabayVideoStreamSchema>;
      return {
        label,
        url: rewriteForOverride(stream.url, this.config),
        ...(stream.width ? { widthPx: stream.width } : {}),
        ...(stream.height ? { heightPx: stream.height } : {}),
        ...(stream.size ? { fileSizeBytes: stream.size } : {}),
        fileType: 'mp4',
      };
    });
    const largest = renditions[0];
    const thumbnail = hit.videos.large?.thumbnail ?? hit.videos.medium?.thumbnail;

    return buildCandidate({
      provider: this.id,
      candidateId: candidateIdFor('PB', String(hit.id)),
      providerAssetId: String(hit.id),
      mediaKind: 'VIDEO',
      title: boundedText(hit.tags, 300, `Pixabay video ${hit.id}`),
      description: boundedText(hit.tags, 2000),
      landingPageUrl: hit.pageURL,
      ...(thumbnail ? { previewUrl: rewriteForOverride(thumbnail, this.config) } : {}),
      renditions,
      durationSeconds: hit.duration ?? null,
      widthPx: largest?.widthPx ?? null,
      heightPx: largest?.heightPx ?? null,
      // Pixabay publishes no frame rate. Left null rather than assumed — the
      // quality profile measures it from the file, and a guess here would be
      // indistinguishable from a measurement downstream.
      frameRate: null,
      fileSizeBytes: largest?.fileSizeBytes ?? null,
      rights: pixabayRights(hit.user, hit.pageURL),
      retrievedAt,
    });
  }
}

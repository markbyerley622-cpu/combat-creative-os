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
import {
  assertDownloadPermitted,
  healthFromError,
  resolveSelectedRendition,
  type DownloadApprovedAssetInput,
  type DownloadedMediaBytes,
  type MediaAcquisitionProvider,
  type MediaProviderCallOptions,
  type MediaProviderHealth,
  type MediaRightsEvidence,
  type ResolvedMediaUrl,
} from './provider';

/**
 * Pexels, through its official API only.
 *
 * The Pexels Licence permits commercial use, including advertising, without
 * attribution — which makes it one of the few free sources whose terms actually
 * reach a paid campaign. It also carries restrictions that no licence text can
 * discharge for us: identifiable people are not model-released, and the terms
 * forbid implying endorsement by a person or brand. So every Pexels candidate
 * arrives with `recognizablePersonRisk: UNKNOWN` and `modelReleaseStatus:
 * NOT_PROVIDED`, which the rights policy turns into a mandatory human review.
 *
 * That is not pessimism about Pexels. It is the honest reading of "we do not
 * warrant model releases" for a system whose output is an advertisement.
 *
 * Only the selected original is fetched. There is no bulk download, no
 * mirroring, no crawl and no path that indexes Pexels material into Creative
 * Memory — it is production content, not a benchmark.
 */

export const PEXELS_DESCRIPTOR: MediaAdapterDescriptor = {
  provider: 'PEXELS',
  supportedKinds: ['VIDEO', 'IMAGE'],
  requiresApiKey: true,
  apiKeyEnvVar: 'PEXELS_API_KEY',
  apiHosts: ['api.pexels.com'],
  downloadHosts: ['videos.pexels.com', 'images.pexels.com', '.pexels.com', 'player.vimeo.com'],
  responseContractStatus: 'DOCUMENTED_NOT_EXECUTED',
  licenceTermsUrl: 'https://www.pexels.com/license/',
};

const PEXELS_ORIGIN = 'https://api.pexels.com';

/**
 * Restrictions the Pexels Licence states, carried verbatim onto every
 * candidate.
 *
 * Verbatim matters: the rights policy matches restriction *prose*, and a
 * paraphrase that dropped "identifiable" would silently stop triggering the
 * review that the phrase exists to trigger.
 */
const PEXELS_RESTRICTIONS: readonly string[] = [
  'Identifiable people may not be shown in a bad light or in a way that is offensive.',
  'Do not imply endorsement of products by people or brands appearing in the content.',
  'Do not sell unaltered copies, and do not redistribute the content on other stock platforms.',
  'Do not use the content as part of a trade mark, design mark or trade name.',
  'Pexels does not warrant that a model release or property release exists for any content.',
];

const PexelsVideoFileSchema = z
  .object({
    id: z.number().optional(),
    quality: z.string().nullable().optional(),
    file_type: z.string().nullable().optional(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    fps: z.number().nullable().optional(),
    link: z.string(),
    size: z.number().nullable().optional(),
  })
  .passthrough();

const PexelsVideoSchema = z
  .object({
    id: z.number(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    duration: z.number().nullable().optional(),
    url: z.string(),
    image: z.string().nullable().optional(),
    user: z
      .object({
        id: z.number().optional(),
        name: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    video_files: z.array(PexelsVideoFileSchema).default([]),
  })
  .passthrough();

const PexelsVideoSearchSchema = z
  .object({
    page: z.number().optional(),
    per_page: z.number().optional(),
    total_results: z.number().optional(),
    next_page: z.string().optional(),
    videos: z.array(PexelsVideoSchema).default([]),
  })
  .passthrough();

const PexelsPhotoSchema = z
  .object({
    id: z.number(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    url: z.string(),
    photographer: z.string().nullable().optional(),
    photographer_url: z.string().nullable().optional(),
    alt: z.string().nullable().optional(),
    src: z.record(z.string()).default({}),
  })
  .passthrough();

const PexelsPhotoSearchSchema = z
  .object({
    page: z.number().optional(),
    per_page: z.number().optional(),
    total_results: z.number().optional(),
    next_page: z.string().optional(),
    photos: z.array(PexelsPhotoSchema).default([]),
  })
  .passthrough();

function pexelsRights(creator: string, creatorUrl: string | null): MediaRightsFacts {
  return {
    declaredLicence: 'Pexels License',
    licenceFamily: 'PEXELS_LICENCE',
    licenceUrl: PEXELS_DESCRIPTOR.licenceTermsUrl,
    creator: boundedText(creator, 300, 'NOT_STATED'),
    ...(creatorUrl ? { creatorUrl } : {}),
    // Not required by the licence, but generated anyway: Pexels asks for a
    // courtesy credit and a credits file costs nothing to carry.
    attributionText: `${boundedText(creator, 200, 'Unknown photographer')} via Pexels`,
    commercialUse: 'PERMITTED',
    derivativeUse: 'PERMITTED',
    // The licence permits advertising. Whether *this clip* may run in a paid ad
    // depends on whether anyone in it is identifiable, which the API cannot say.
    paidAdvertisingUse: 'PERMITTED',
    recognizablePersonRisk: 'UNKNOWN',
    trademarkOrLogoRisk: 'UNKNOWN',
    endorsementRisk: 'MEDIUM',
    modelReleaseStatus: 'NOT_PROVIDED',
    propertyReleaseStatus: 'NOT_PROVIDED',
    sourceRestrictions: [...PEXELS_RESTRICTIONS],
  };
}

function videoRenditions(
  video: z.infer<typeof PexelsVideoSchema>,
  config: MediaAdapterConfig,
): MediaRendition[] {
  return video.video_files
    .filter((file) => typeof file.link === 'string' && file.link.length > 0)
    .map((file) => ({
      label: boundedText(file.quality, 60, 'unlabelled'),
      url: rewriteForOverride(file.link, config),
      ...(file.width ? { widthPx: file.width } : {}),
      ...(file.height ? { heightPx: file.height } : {}),
      ...(file.fps ? { frameRate: file.fps } : {}),
      ...(file.size ? { fileSizeBytes: file.size } : {}),
      ...(file.file_type ? { fileType: boundedText(file.file_type, 40) } : {}),
    }));
}

function photoRenditions(
  photo: z.infer<typeof PexelsPhotoSchema>,
  config: MediaAdapterConfig,
): MediaRendition[] {
  // `original` first; the rest are provider-generated downscales and exist so
  // an operator can choose a smaller file deliberately rather than by accident.
  const order = ['original', 'large2x', 'large', 'portrait', 'landscape', 'medium'];
  return order
    .filter((label) => typeof photo.src[label] === 'string')
    .map((label) => ({
      label,
      url: rewriteForOverride(photo.src[label] as string, config),
      ...(label === 'original' && photo.width ? { widthPx: photo.width } : {}),
      ...(label === 'original' && photo.height ? { heightPx: photo.height } : {}),
      fileType: 'jpg',
    }));
}

export class PexelsMediaProvider implements MediaAcquisitionProvider {
  readonly id = 'PEXELS' as const;

  constructor(private readonly config: MediaAdapterConfig = {}) {}

  async healthcheck(options: MediaProviderCallOptions = {}): Promise<MediaProviderHealth> {
    const configured = Boolean(this.config.apiKey?.trim());
    if (!configured) {
      return {
        provider: this.id,
        state: 'NOT_CONFIGURED',
        detail: 'PEXELS_API_KEY is not set. Create a free key at https://www.pexels.com/api/.',
        supportedKinds: PEXELS_DESCRIPTOR.supportedKinds,
        credentialConfigured: false,
      };
    }
    try {
      // The cheapest documented call that requires authentication.
      await fetchProviderJson(
        `${originFor(PEXELS_DESCRIPTOR, this.config, PEXELS_ORIGIN)}/v1/search?query=test&per_page=1`,
        urlPolicyFor(PEXELS_DESCRIPTOR, this.config, 'API'),
        resolveHttpOptions(this.config, options.signal),
        { authorization: requireApiKey(PEXELS_DESCRIPTOR, this.config) },
      );
      return {
        provider: this.id,
        state: 'READY',
        detail: 'the API answered an authenticated request',
        supportedKinds: PEXELS_DESCRIPTOR.supportedKinds,
        credentialConfigured: true,
      };
    } catch (error) {
      return healthFromError(this.id, PEXELS_DESCRIPTOR.supportedKinds, true, error);
    }
  }

  async search(
    request: MediaSearchRequest,
    options: MediaProviderCallOptions = {},
  ): Promise<MediaSearchPage> {
    if (request.kind === 'AUDIO') {
      throw new MediaHttpError(
        'REJECTED',
        'Pexels publishes no audio API; asking for audio here would be a fabrication',
      );
    }
    const key = requireApiKey(PEXELS_DESCRIPTOR, this.config);
    const origin = originFor(PEXELS_DESCRIPTOR, this.config, PEXELS_ORIGIN);
    const retrievedAt = new Date();

    const params = new URLSearchParams({
      query: request.query,
      per_page: String(request.perPage),
      page: String(request.page),
    });
    const orientation = orientationParam(request.orientation);
    if (orientation) params.set('orientation', orientation);
    // `size` is Pexels' own coarse quality filter; large means >= 4K for video
    // and >= 24MP for photos, which matches this milestone's source floor.
    if ((request.minWidthPx ?? 0) >= 3840) params.set('size', 'large');
    else if ((request.minWidthPx ?? 0) >= 1920) params.set('size', 'medium');

    const route = request.kind === 'VIDEO' ? '/videos/search' : '/v1/search';
    const body = await fetchProviderJson(
      `${origin}${route}?${params.toString()}`,
      urlPolicyFor(PEXELS_DESCRIPTOR, this.config, 'API'),
      resolveHttpOptions(this.config, options.signal),
      { authorization: key },
    );

    if (request.kind === 'VIDEO') {
      const parsed = parseProviderResponse(PexelsVideoSearchSchema, body, this.id, route);
      const candidates = parsed.videos.map((video) => this.toVideoCandidate(video, retrievedAt));
      return {
        provider: this.id,
        candidates: applyRequestFilters(candidates, request),
        page: parsed.page ?? request.page,
        perPage: parsed.per_page ?? request.perPage,
        totalResults: parsed.total_results ?? null,
        hasNextPage: Boolean(parsed.next_page),
      };
    }

    const parsed = parseProviderResponse(PexelsPhotoSearchSchema, body, this.id, route);
    const candidates = parsed.photos.map((photo) => this.toPhotoCandidate(photo, retrievedAt));
    return {
      provider: this.id,
      candidates: applyRequestFilters(candidates, request),
      page: parsed.page ?? request.page,
      perPage: parsed.per_page ?? request.perPage,
      totalResults: parsed.total_results ?? null,
      hasNextPage: Boolean(parsed.next_page),
    };
  }

  async getCandidateDetails(
    providerAssetId: string,
    kind: MediaKind,
    options: MediaProviderCallOptions = {},
  ): Promise<MediaCandidate> {
    if (kind === 'AUDIO') {
      throw new MediaHttpError('REJECTED', 'Pexels publishes no audio API');
    }
    const key = requireApiKey(PEXELS_DESCRIPTOR, this.config);
    const origin = originFor(PEXELS_DESCRIPTOR, this.config, PEXELS_ORIGIN);
    const route =
      kind === 'VIDEO'
        ? `/videos/videos/${encodeURIComponent(providerAssetId)}`
        : `/v1/photos/${encodeURIComponent(providerAssetId)}`;
    const body = await fetchProviderJson(
      `${origin}${route}`,
      urlPolicyFor(PEXELS_DESCRIPTOR, this.config, 'API'),
      resolveHttpOptions(this.config, options.signal),
      { authorization: key },
    );
    const retrievedAt = new Date();
    return kind === 'VIDEO'
      ? this.toVideoCandidate(
          parseProviderResponse(PexelsVideoSchema, body, this.id, route),
          retrievedAt,
        )
      : this.toPhotoCandidate(
          parseProviderResponse(PexelsPhotoSchema, body, this.id, route),
          retrievedAt,
        );
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
    const rendition = resolveSelectedRendition(input.candidate, input.selection.renditionLabel);
    if (!rendition) {
      throw new MediaHttpError(
        'REJECTED',
        `"${input.selection.renditionLabel}" is not one of ${input.candidate.candidateId}'s renditions (${input.candidate.renditions.map((entry) => entry.label).join(', ') || 'none'})`,
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
      // Pexels publishes one licence for the whole library rather than a
      // per-item licence field, so the basis is the published terms.
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
      urlPolicyFor(PEXELS_DESCRIPTOR, this.config, 'DOWNLOAD'),
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

  private toVideoCandidate(
    video: z.infer<typeof PexelsVideoSchema>,
    retrievedAt: Date,
  ): MediaCandidate {
    const renditions = videoRenditions(video, this.config);
    const largest = [...renditions].sort(
      (a, b) => (b.widthPx ?? 0) * (b.heightPx ?? 0) - (a.widthPx ?? 0) * (a.heightPx ?? 0),
    )[0];
    return buildCandidate({
      provider: this.id,
      candidateId: candidateIdFor('PX', String(video.id)),
      providerAssetId: String(video.id),
      mediaKind: 'VIDEO',
      title: boundedText(
        video.url.split('/').filter(Boolean).pop()?.replace(/-/g, ' '),
        300,
        `Pexels video ${video.id}`,
      ),
      landingPageUrl: video.url,
      ...(video.image ? { previewUrl: rewriteForOverride(video.image, this.config) } : {}),
      renditions,
      durationSeconds: video.duration ?? null,
      widthPx: video.width ?? largest?.widthPx ?? null,
      heightPx: video.height ?? largest?.heightPx ?? null,
      frameRate: largest?.frameRate ?? null,
      fileSizeBytes: largest?.fileSizeBytes ?? null,
      rights: pexelsRights(video.user?.name ?? 'NOT_STATED', video.user?.url ?? null),
      retrievedAt,
    });
  }

  private toPhotoCandidate(
    photo: z.infer<typeof PexelsPhotoSchema>,
    retrievedAt: Date,
  ): MediaCandidate {
    return buildCandidate({
      provider: this.id,
      candidateId: candidateIdFor('PX', String(photo.id)),
      providerAssetId: String(photo.id),
      mediaKind: 'IMAGE',
      title: boundedText(photo.alt, 300, `Pexels photo ${photo.id}`),
      landingPageUrl: photo.url,
      ...(photo.src.medium
        ? { previewUrl: rewriteForOverride(photo.src.medium, this.config) }
        : {}),
      renditions: photoRenditions(photo, this.config),
      durationSeconds: null,
      widthPx: photo.width ?? null,
      heightPx: photo.height ?? null,
      frameRate: null,
      fileSizeBytes: null,
      rights: pexelsRights(photo.photographer ?? 'NOT_STATED', photo.photographer_url ?? null),
      retrievedAt,
    });
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '<unparsable>';
  }
}

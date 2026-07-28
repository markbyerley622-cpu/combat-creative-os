import { z } from 'zod';

import {
  type LicenceFamily,
  type MediaCandidate,
  type MediaKind,
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
  originFor,
  parseProviderResponse,
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
 * Openverse — audio and images only.
 *
 * **It has no video.** Openverse indexes openly-licensed images and audio, and
 * this adapter refuses a video request by name rather than returning an empty
 * page: an empty result reads as "nothing matched your query", which would be a
 * false statement about the catalogue.
 *
 * Openverse is an *aggregator*, which changes the download rule entirely.
 * The `url` field points at whichever upstream host actually holds the file —
 * Flickr, Wikimedia, Freesound, a museum, a personal site. Following that
 * blindly would turn a search response into arbitrary outbound requests, so
 * downloads are restricted to a small allowlist of upstream hosts whose terms
 * are known. Anything else is refused with the host named, and an operator can
 * acquire it deliberately by hand.
 *
 * Licence filtering is applied server-side *and* re-checked locally. Openverse
 * accepts a `license` parameter, and a request that quietly widened it would be
 * indistinguishable from one that worked.
 */

export const OPENVERSE_DESCRIPTOR: MediaAdapterDescriptor = {
  provider: 'OPENVERSE',
  supportedKinds: ['IMAGE', 'AUDIO'],
  requiresApiKey: false,
  apiKeyEnvVar: null,
  apiHosts: ['api.openverse.org', 'api.openverse.engineering'],
  /**
   * Upstream hosts this adapter will fetch bytes from.
   *
   * Deliberately short. Each one publishes terms we can read and a stable URL
   * scheme; adding to it is a decision about a new upstream's licensing, not a
   * convenience.
   */
  downloadHosts: [
    'upload.wikimedia.org',
    'live.staticflickr.com',
    'farm1.staticflickr.com',
    'farm2.staticflickr.com',
    'farm3.staticflickr.com',
    'farm4.staticflickr.com',
    'farm5.staticflickr.com',
    'cdn.freesound.org',
    'freesound.org',
  ],
  responseContractStatus: 'DOCUMENTED_NOT_EXECUTED',
  licenceTermsUrl: 'https://openverse.org/terms',
};

const OPENVERSE_ORIGIN = 'https://api.openverse.org';

/**
 * The only licences requested from Openverse.
 *
 * `by-sa` is deliberately absent from the *request*: a share-alike obligation
 * on the finished advertisement is a decision this pipeline does not make
 * automatically, and not asking for it is simpler than asking and then refusing
 * everything that comes back.
 */
const REQUESTED_LICENCES = ['cc0', 'pdm', 'by'] as const;

const OpenverseResultSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    foreign_landing_url: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    creator: z.string().nullable().optional(),
    creator_url: z.string().nullable().optional(),
    license: z.string(),
    license_version: z.string().nullable().optional(),
    license_url: z.string().nullable().optional(),
    provider: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    filesize: z.number().nullable().optional(),
    filetype: z.string().nullable().optional(),
    attribution: z.string().nullable().optional(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    duration: z.number().nullable().optional(),
    thumbnail: z.string().nullable().optional(),
  })
  .passthrough();

const OpenverseResponseSchema = z
  .object({
    result_count: z.number().optional(),
    page_count: z.number().optional(),
    page_size: z.number().optional(),
    page: z.number().optional(),
    results: z.array(OpenverseResultSchema).default([]),
  })
  .passthrough();

/**
 * Maps Openverse's licence slug onto a family.
 *
 * Openverse uses short slugs (`cc0`, `pdm`, `by`, `by-sa`, `by-nc-nd`), so this
 * is an exact-match table rather than a substring walk — the slugs are a closed
 * vocabulary and an unrecognised one must land on `UNKNOWN`, which the rights
 * policy refuses.
 */
export function classifyOpenverseLicence(slug: string): LicenceFamily {
  switch (slug.trim().toLowerCase()) {
    case 'cc0':
      return 'CC0';
    case 'pdm':
      return 'PUBLIC_DOMAIN_MARK';
    case 'by':
      return 'CC_BY';
    case 'by-sa':
      return 'CC_BY_SA';
    case 'by-nc':
      return 'CC_BY_NC';
    case 'by-nd':
      return 'CC_BY_ND';
    case 'by-nc-sa':
      return 'CC_BY_NC_SA';
    case 'by-nc-nd':
      return 'CC_BY_NC_ND';
    case 'sampling+':
    case 'nc-sampling+':
      return 'CC_BY_NC';
    default:
      return 'UNKNOWN';
  }
}

function openverseRights(
  result: z.infer<typeof OpenverseResultSchema>,
  landingPageUrl: string,
): MediaRightsFacts {
  const family = classifyOpenverseLicence(result.license);
  const creator = boundedText(result.creator, 300, 'NOT_STATED');
  const licenceName = result.license_version
    ? `CC ${result.license.toUpperCase()} ${result.license_version}`
    : `CC ${result.license.toUpperCase()}`;
  const commercial =
    family === 'CC0' ||
    family === 'PUBLIC_DOMAIN_MARK' ||
    family === 'PUBLIC_DOMAIN' ||
    family === 'CC_BY' ||
    family === 'CC_BY_SA';

  return {
    declaredLicence: boundedText(licenceName, 200, 'NOT_STATED'),
    licenceFamily: family,
    ...(result.license_url ? { licenceUrl: boundedText(result.license_url, 2000) } : {}),
    creator,
    ...(result.creator_url ? { creatorUrl: boundedText(result.creator_url, 2000) } : {}),
    attributionText: boundedText(
      result.attribution ??
        `${creator} — ${licenceName} — via ${result.source ?? 'Openverse'} (${landingPageUrl})`,
      600,
    ),
    commercialUse: commercial ? 'PERMITTED' : 'PROHIBITED',
    derivativeUse:
      family === 'CC_BY_ND' || family === 'CC_BY_NC_ND'
        ? 'PROHIBITED'
        : commercial
          ? 'PERMITTED'
          : 'UNKNOWN',
    paidAdvertisingUse: 'UNKNOWN',
    recognizablePersonRisk: 'UNKNOWN',
    trademarkOrLogoRisk: 'UNKNOWN',
    endorsementRisk: 'MEDIUM',
    modelReleaseStatus: 'NOT_PROVIDED',
    propertyReleaseStatus: 'NOT_PROVIDED',
    sourceRestrictions: [
      `Openverse aggregates from third-party sources; this item is held by ${result.source ?? 'an unnamed upstream source'} and its terms are the upstream's, not Openverse's.`,
      'Openverse does not verify that an upstream licence statement is correct; the upstream page is the authority.',
      ...(family === 'CC_BY' || family === 'CC_BY_SA'
        ? ['Attribution required by the licence.']
        : []),
    ],
  };
}

export class OpenverseMediaProvider implements MediaAcquisitionProvider {
  readonly id = 'OPENVERSE' as const;

  constructor(private readonly config: MediaAdapterConfig = {}) {}

  async healthcheck(options: MediaProviderCallOptions = {}): Promise<MediaProviderHealth> {
    try {
      await fetchProviderJson(
        `${originFor(OPENVERSE_DESCRIPTOR, this.config, OPENVERSE_ORIGIN)}/v1/images/?q=test&page_size=1`,
        urlPolicyFor(OPENVERSE_DESCRIPTOR, this.config, 'API'),
        resolveHttpOptions(this.config, options.signal),
      );
      return {
        provider: this.id,
        state: 'READY',
        detail: 'the API answered (anonymous access is rate-limited but needs no key)',
        supportedKinds: OPENVERSE_DESCRIPTOR.supportedKinds,
        credentialConfigured: true,
      };
    } catch (error) {
      return healthFromError(this.id, OPENVERSE_DESCRIPTOR.supportedKinds, true, error);
    }
  }

  async search(
    request: MediaSearchRequest,
    options: MediaProviderCallOptions = {},
  ): Promise<MediaSearchPage> {
    if (request.kind === 'VIDEO') {
      throw new MediaHttpError(
        'REJECTED',
        'Openverse indexes images and audio only. It has no video catalogue, and returning an empty page would misrepresent that as "no matches".',
      );
    }
    const route = request.kind === 'AUDIO' ? '/v1/audio/' : '/v1/images/';
    const params = new URLSearchParams({
      q: request.query,
      license: REQUESTED_LICENCES.join(','),
      page: String(request.page),
      page_size: String(Math.min(request.perPage, 20)),
    });
    if (request.kind === 'IMAGE') {
      const orientation = request.orientation;
      if (orientation === 'PORTRAIT') params.set('aspect_ratio', 'tall');
      if (orientation === 'LANDSCAPE') params.set('aspect_ratio', 'wide');
      if (orientation === 'SQUARE') params.set('aspect_ratio', 'square');
    }

    const body = await fetchProviderJson(
      `${originFor(OPENVERSE_DESCRIPTOR, this.config, OPENVERSE_ORIGIN)}${route}?${params.toString()}`,
      urlPolicyFor(OPENVERSE_DESCRIPTOR, this.config, 'API'),
      resolveHttpOptions(this.config, options.signal),
    );
    const parsed = parseProviderResponse(OpenverseResponseSchema, body, this.id, route);
    const retrievedAt = new Date();

    const candidates = parsed.results
      .map((result) => this.toCandidate(result, request.kind, retrievedAt))
      .filter((candidate): candidate is MediaCandidate => candidate !== null)
      // Re-applied locally: a server-side filter that was ignored is
      // indistinguishable from one that worked, and this is the check that
      // notices.
      .filter((candidate) => {
        const family = candidate.rights.licenceFamily;
        return (
          family === 'CC0' ||
          family === 'PUBLIC_DOMAIN_MARK' ||
          family === 'PUBLIC_DOMAIN' ||
          family === 'CC_BY'
        );
      });

    return {
      provider: this.id,
      candidates: applyRequestFilters(candidates, request),
      page: parsed.page ?? request.page,
      perPage: parsed.page_size ?? request.perPage,
      totalResults: parsed.result_count ?? null,
      hasNextPage: (parsed.page ?? request.page) < (parsed.page_count ?? 0),
    };
  }

  async getCandidateDetails(
    providerAssetId: string,
    kind: MediaKind,
    options: MediaProviderCallOptions = {},
  ): Promise<MediaCandidate> {
    if (kind === 'VIDEO') {
      throw new MediaHttpError('REJECTED', 'Openverse has no video catalogue');
    }
    const route = kind === 'AUDIO' ? '/v1/audio/' : '/v1/images/';
    const body = await fetchProviderJson(
      `${originFor(OPENVERSE_DESCRIPTOR, this.config, OPENVERSE_ORIGIN)}${route}${encodeURIComponent(providerAssetId)}/`,
      urlPolicyFor(OPENVERSE_DESCRIPTOR, this.config, 'API'),
      resolveHttpOptions(this.config, options.signal),
    );
    const parsed = parseProviderResponse(OpenverseResultSchema, body, this.id, route);
    const candidate = this.toCandidate(parsed, kind, new Date());
    if (!candidate) {
      throw new MediaHttpError(
        'REJECTED',
        `Openverse item "${providerAssetId}" has no usable file URL`,
      );
    }
    return candidate;
  }

  resolvePreview(candidate: MediaCandidate): ResolvedMediaUrl | null {
    if (!candidate.previewUrl) return null;
    return {
      url: candidate.previewUrl,
      host: hostOf(candidate.previewUrl),
      renditionLabel: 'thumbnail',
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
        `"${input.selection.renditionLabel}" is not one of ${input.candidate.candidateId}'s renditions`,
      );
    }
    // The upstream-host check, stated here as well as in the URL policy, so the
    // refusal names the aggregation problem rather than reading as a generic
    // allowlist miss.
    const host = hostOf(rendition.url);
    const policy = urlPolicyFor(OPENVERSE_DESCRIPTOR, this.config, 'DOWNLOAD');
    const allowed = policy.allowedHosts.some(
      (entry) => host === entry || (entry.startsWith('.') && host.endsWith(entry)),
    );
    if (!allowed) {
      throw new MediaHttpError(
        'DISALLOWED_URL',
        `${input.candidate.candidateId} is held upstream by ${host}, which is not one of the upstream sources this adapter downloads from (${policy.allowedHosts.join(', ')}). Openverse aggregates: the licence is the upstream's, and so is the risk. Acquire it deliberately instead.`,
      );
    }
    return {
      url: rendition.url,
      host,
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
      evidenceBasis: 'PROVIDER_API_FIELD',
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
      urlPolicyFor(OPENVERSE_DESCRIPTOR, this.config, 'DOWNLOAD'),
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

  private toCandidate(
    result: z.infer<typeof OpenverseResultSchema>,
    kind: MediaKind,
    retrievedAt: Date,
  ): MediaCandidate | null {
    if (!result.url) return null;
    const landingPageUrl = result.foreign_landing_url ?? result.url;
    return buildCandidate({
      provider: this.id,
      candidateId: candidateIdFor('OV', result.id),
      providerAssetId: result.id,
      mediaKind: kind,
      title: boundedText(result.title, 300, `Openverse ${result.id}`),
      landingPageUrl,
      ...(result.thumbnail
        ? { previewUrl: rewriteForOverride(result.thumbnail, this.config) }
        : {}),
      renditions: [
        {
          label: 'original',
          url: rewriteForOverride(result.url, this.config),
          ...(result.width ? { widthPx: result.width } : {}),
          ...(result.height ? { heightPx: result.height } : {}),
          ...(result.filesize ? { fileSizeBytes: result.filesize } : {}),
          ...(result.filetype ? { fileType: boundedText(result.filetype, 40) } : {}),
        },
      ],
      durationSeconds: result.duration ? result.duration / 1000 : null,
      widthPx: result.width ?? null,
      heightPx: result.height ?? null,
      frameRate: null,
      fileSizeBytes: result.filesize ?? null,
      rights: openverseRights(result, landingPageUrl),
      retrievedAt,
      notes: `Upstream source: ${result.source ?? 'unnamed'}. Verify the licence on the upstream page before approving.`,
    });
  }
}

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
 * DVIDS — the Defense Visual Information Distribution Service.
 *
 * DVIDS is the strictest adapter here, and deliberately so. Most of what it
 * hosts is US Government work and therefore public domain in the United States,
 * which makes it genuinely valuable: real combat-sports and training footage
 * with no licence fee. But **not all of it is**. DVIDS also carries material
 * produced by contractors, coalition partners and commercial outlets, and that
 * material is separately copyrighted.
 *
 * So this adapter inverts the usual default. A DVIDS item is treated as
 * public domain only when the response *says so at the item level*. Anything
 * ambiguous — an unrecognised rights value, a missing field, a credit line
 * naming a commercial source — is `UNKNOWN`, which the rights policy refuses.
 * Guessing in the other direction would mean publishing somebody's copyrighted
 * footage in an advertisement on the strength of the host it sat on.
 *
 * Two further obligations travel with everything from here, both encoded as
 * restrictions rather than prose in a runbook:
 *
 * - **Credit is preserved.** Public domain removes the requirement, not the
 *   decency; the photographer's name and unit go into `CREDITS.md`.
 * - **No implied endorsement.** Neither the Department of Defense, nor any
 *   service, nor any pictured service member may be presented as endorsing a
 *   product. `isGovernmentPublicAffairs` forces a human review for exactly
 *   this, on every item, without exception.
 */

export const DVIDS_DESCRIPTOR: MediaAdapterDescriptor = {
  provider: 'DVIDS',
  supportedKinds: ['VIDEO', 'IMAGE'],
  requiresApiKey: true,
  apiKeyEnvVar: 'DVIDS_API_KEY',
  apiHosts: ['api.dvidshub.net'],
  downloadHosts: ['d34w7g4gy10iej.cloudfront.net', '.dvidshub.net', 'cdn.dvidshub.net'],
  responseContractStatus: 'DOCUMENTED_NOT_EXECUTED',
  licenceTermsUrl: 'https://www.dvidshub.net/about/copyright',
};

const DVIDS_ORIGIN = 'https://api.dvidshub.net';

/**
 * Values in a DVIDS rights/copyright field that this adapter accepts as an
 * item-level public-domain statement.
 *
 * A closed list, matched case-insensitively against the whole trimmed value —
 * not a substring search. "Public domain" and "not public domain" share a
 * substring, and a rule that cannot tell them apart is worse than no rule.
 */
const PUBLIC_DOMAIN_VALUES: readonly string[] = [
  'public domain',
  'publicdomain',
  'public-domain',
  'no copyright',
  'none',
  'us government work',
  'u.s. government work',
];

/**
 * Credit fragments that mean the item is *not* a government work even if a
 * rights field says otherwise. A contractor's byline outranks a default.
 */
const COMMERCIAL_CREDIT_MARKERS: readonly string[] = [
  'getty',
  'reuters',
  'associated press',
  ' ap ',
  'afp',
  'shutterstock',
  'copyright',
  '©',
  'all rights reserved',
  'used with permission',
  'courtesy photo',
  'courtesy image',
];

const DvidsSearchResultSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    title: z.string().optional(),
    short_description: z.string().optional(),
    thumbnail: z.string().optional(),
    date_published: z.string().optional(),
  })
  .passthrough();

const DvidsSearchResponseSchema = z
  .object({
    page_info: z
      .object({
        total_results: z.number().optional(),
        results_per_page: z.number().optional(),
        page: z.number().optional(),
      })
      .passthrough()
      .optional(),
    results: z.array(DvidsSearchResultSchema).default([]),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

const DvidsFileSchema = z
  .object({
    src: z.string(),
    type: z.string().optional(),
    height: z.number().optional(),
    width: z.number().optional(),
    size: z.number().optional(),
    filename: z.string().optional(),
  })
  .passthrough();

const DvidsAssetSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    credit: z.string().optional(),
    url: z.string().optional(),
    thumbnail: z.string().optional(),
    duration: z.number().optional(),
    aspect_ratio: z.string().optional(),
    unit_name: z.string().optional(),
    branch: z.string().optional(),
    keywords: z.union([z.string(), z.array(z.string())]).optional(),
    /**
     * DVIDS exposes the item's rights position under more than one name
     * depending on asset type and API version. All of them are optional, and
     * an item with none of them is `UNKNOWN` — never "presumed public domain".
     */
    rights: z.string().optional(),
    copyright: z.string().optional(),
    usage: z.string().optional(),
    files: z.array(DvidsFileSchema).default([]),
    image: z.union([DvidsFileSchema, z.array(DvidsFileSchema)]).optional(),
    video: z.union([DvidsFileSchema, z.array(DvidsFileSchema)]).optional(),
  })
  .passthrough();

const DvidsAssetResponseSchema = z
  .object({
    results: DvidsAssetSchema,
  })
  .passthrough();

export interface DvidsRightsReading {
  readonly isPublicDomain: boolean;
  readonly why: string;
}

/**
 * Reads an item's rights position, refusing to assume one.
 *
 * Exported because it is the interesting part of this adapter and deserves its
 * own tests: the boundary between "DVIDS said public domain" and "DVIDS said
 * nothing" is the boundary between lawful reuse and infringement.
 */
export function readDvidsRights(asset: {
  readonly rights?: string;
  readonly copyright?: string;
  readonly usage?: string;
  readonly credit?: string;
}): DvidsRightsReading {
  const credit = (asset.credit ?? '').toLowerCase();
  for (const marker of COMMERCIAL_CREDIT_MARKERS) {
    if (credit.includes(marker)) {
      return {
        isPublicDomain: false,
        why: `the credit line contains "${marker.trim()}", which indicates separately copyrighted or courtesy material rather than a US Government work`,
      };
    }
  }

  const declared = [asset.rights, asset.copyright, asset.usage]
    .map((value) => (value ?? '').trim().toLowerCase())
    .filter((value) => value.length > 0);

  if (declared.length === 0) {
    return {
      isPublicDomain: false,
      why: 'the item states no rights, copyright or usage value. DVIDS hosts both US Government works and separately copyrighted material, so silence is ambiguous and ambiguity is refused.',
    };
  }
  const publicDomain = declared.find((value) => PUBLIC_DOMAIN_VALUES.includes(value));
  if (!publicDomain) {
    return {
      isPublicDomain: false,
      why: `the item declares "${declared[0]}", which is not a recognised item-level public-domain statement`,
    };
  }
  return { isPublicDomain: true, why: `the item declares "${publicDomain}" at item level` };
}

const DVIDS_RESTRICTIONS: readonly string[] = [
  'Use must not imply endorsement by the Department of Defense, any military service, any unit, or any service member appearing in the material.',
  'Military markings, insignia, unit patches and identifiable service members are present in much of this material and require review before advertising use.',
  'Journalist and unit credit must be preserved even where the licence does not compel attribution.',
  'Any item that is not an item-level US Government work is separately copyrighted and is not licensed by this route.',
];

function dvidsRights(
  asset: z.infer<typeof DvidsAssetSchema>,
  reading: DvidsRightsReading,
): MediaRightsFacts {
  const creator = boundedText(asset.credit, 300, 'NOT_STATED');
  const unit = boundedText(asset.unit_name, 200);
  return {
    declaredLicence: reading.isPublicDomain
      ? 'US Government work — public domain (DVIDS item-level)'
      : `DVIDS item with unestablished rights: ${reading.why}`,
    licenceFamily: reading.isPublicDomain ? 'US_GOVERNMENT_PUBLIC_DOMAIN' : 'UNKNOWN',
    licenceUrl: DVIDS_DESCRIPTOR.licenceTermsUrl,
    creator,
    attributionText: unit ? `${creator}, ${unit} / DVIDS` : `${creator} / DVIDS`,
    commercialUse: reading.isPublicDomain ? 'PERMITTED' : 'UNKNOWN',
    derivativeUse: reading.isPublicDomain ? 'PERMITTED' : 'UNKNOWN',
    // Never `PERMITTED`. The copyright position permits it; the
    // non-endorsement obligation and the service members in frame do not
    // settle it, and only a person can.
    paidAdvertisingUse: 'UNKNOWN',
    recognizablePersonRisk: 'PRESENT',
    trademarkOrLogoRisk: 'PRESENT',
    endorsementRisk: 'HIGH',
    modelReleaseStatus: 'NOT_PROVIDED',
    propertyReleaseStatus: 'NOT_PROVIDED',
    sourceRestrictions: [...DVIDS_RESTRICTIONS, `Item-level rights reading: ${reading.why}`],
  };
}

function asFileArray(value: unknown): z.infer<typeof DvidsFileSchema>[] {
  if (!value) return [];
  const parsed = z.array(DvidsFileSchema).safeParse(Array.isArray(value) ? value : [value]);
  return parsed.success ? parsed.data : [];
}

export class DvidsMediaProvider implements MediaAcquisitionProvider {
  readonly id = 'DVIDS' as const;

  constructor(private readonly config: MediaAdapterConfig = {}) {}

  async healthcheck(options: MediaProviderCallOptions = {}): Promise<MediaProviderHealth> {
    if (!this.config.apiKey?.trim()) {
      return {
        provider: this.id,
        state: 'NOT_CONFIGURED',
        detail:
          'DVIDS_API_KEY is not set. Request a key at https://api.dvidshub.net/ — DVIDS issues them to identified organisations.',
        supportedKinds: DVIDS_DESCRIPTOR.supportedKinds,
        credentialConfigured: false,
      };
    }
    try {
      await fetchProviderJson(
        this.url('/search', { q: 'test', max_results: '1' }),
        urlPolicyFor(DVIDS_DESCRIPTOR, this.config, 'API'),
        resolveHttpOptions(this.config, options.signal),
      );
      return {
        provider: this.id,
        state: 'READY',
        detail: 'the API answered an authenticated request',
        supportedKinds: DVIDS_DESCRIPTOR.supportedKinds,
        credentialConfigured: true,
      };
    } catch (error) {
      return healthFromError(this.id, DVIDS_DESCRIPTOR.supportedKinds, true, error);
    }
  }

  async search(
    request: MediaSearchRequest,
    options: MediaProviderCallOptions = {},
  ): Promise<MediaSearchPage> {
    if (request.kind === 'AUDIO') {
      throw new MediaHttpError(
        'REJECTED',
        'this adapter searches DVIDS video and image only; audio is not claimed',
      );
    }
    const body = await fetchProviderJson(
      this.url('/search', {
        q: request.query,
        type: request.kind === 'VIDEO' ? 'video' : 'image',
        max_results: String(request.perPage),
        page: String(request.page),
      }),
      urlPolicyFor(DVIDS_DESCRIPTOR, this.config, 'API'),
      resolveHttpOptions(this.config, options.signal),
    );
    const parsed = parseProviderResponse(DvidsSearchResponseSchema, body, this.id, '/search');

    // DVIDS search returns identifiers and a headline; the rights fields that
    // decide everything live on the asset route. One extra call per item is
    // the cost of never guessing at a licence.
    const candidates: MediaCandidate[] = [];
    for (const result of parsed.results) {
      try {
        candidates.push(await this.getCandidateDetails(result.id, request.kind, options));
      } catch (error) {
        if (error instanceof MediaHttpError && error.kind === 'MALFORMED_RESPONSE') continue;
        throw error;
      }
    }

    const total = parsed.page_info?.total_results ?? null;
    return {
      provider: this.id,
      candidates: applyRequestFilters(candidates, request),
      page: parsed.page_info?.page ?? request.page,
      perPage: parsed.page_info?.results_per_page ?? request.perPage,
      totalResults: total,
      hasNextPage:
        total === null
          ? parsed.results.length >= request.perPage
          : request.page * request.perPage < total,
    };
  }

  async getCandidateDetails(
    providerAssetId: string,
    kind: MediaKind,
    options: MediaProviderCallOptions = {},
  ): Promise<MediaCandidate> {
    if (kind === 'AUDIO') throw new MediaHttpError('REJECTED', 'audio is not claimed for DVIDS');
    const body = await fetchProviderJson(
      this.url('/asset', { id: providerAssetId }),
      urlPolicyFor(DVIDS_DESCRIPTOR, this.config, 'API'),
      resolveHttpOptions(this.config, options.signal),
    );
    const parsed = parseProviderResponse(DvidsAssetResponseSchema, body, this.id, '/asset');
    return this.toCandidate(parsed.results, kind, new Date());
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
    if (input.candidate.rights.licenceFamily !== 'US_GOVERNMENT_PUBLIC_DOMAIN') {
      // A second, independent refusal. The rights policy already rejects
      // `UNKNOWN`, and an approval cannot override a rejection — but this is
      // the specific failure worth naming twice, because the whole DVIDS route
      // depends on it.
      throw new MediaHttpError(
        'REJECTED',
        `${input.candidate.candidateId} is not an item-level US Government work, so it is not licensed by this route. DVIDS hosts separately copyrighted material and this adapter will not download it.`,
      );
    }
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
      creatorUrl: null,
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
      urlPolicyFor(DVIDS_DESCRIPTOR, this.config, 'DOWNLOAD'),
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

  private url(route: string, params: Record<string, string>): string {
    const origin = originFor(DVIDS_DESCRIPTOR, this.config, DVIDS_ORIGIN);
    const search = new URLSearchParams({
      api_key: requireApiKey(DVIDS_DESCRIPTOR, this.config),
      ...params,
    });
    return `${origin}${route}?${search.toString()}`;
  }

  private toCandidate(
    asset: z.infer<typeof DvidsAssetSchema>,
    kind: MediaKind,
    retrievedAt: Date,
  ): MediaCandidate {
    const reading = readDvidsRights(asset);
    const files = [...asset.files, ...asFileArray(asset.video), ...asFileArray(asset.image)].filter(
      (file) => typeof file.src === 'string' && file.src.length > 0,
    );

    const renditions: MediaRendition[] = files.map((file, index) => ({
      label: boundedText(file.type ?? file.filename, 60, `file-${index}`),
      url: rewriteForOverride(file.src, this.config),
      ...(file.width ? { widthPx: file.width } : {}),
      ...(file.height ? { heightPx: file.height } : {}),
      ...(file.size ? { fileSizeBytes: file.size } : {}),
    }));
    const largest = [...renditions].sort(
      (a, b) => (b.widthPx ?? 0) * (b.heightPx ?? 0) - (a.widthPx ?? 0) * (a.heightPx ?? 0),
    )[0];

    return buildCandidate({
      provider: this.id,
      candidateId: candidateIdFor('DV', asset.id),
      providerAssetId: asset.id,
      mediaKind: kind,
      title: boundedText(asset.title, 300, `DVIDS ${asset.id}`),
      description: boundedText(asset.description, 2000),
      landingPageUrl:
        asset.url ??
        `https://www.dvidshub.net/${kind === 'VIDEO' ? 'video' : 'image'}/${encodeURIComponent(asset.id)}`,
      ...(asset.thumbnail ? { previewUrl: rewriteForOverride(asset.thumbnail, this.config) } : {}),
      renditions,
      durationSeconds: asset.duration ?? null,
      widthPx: largest?.widthPx ?? null,
      heightPx: largest?.heightPx ?? null,
      frameRate: null,
      fileSizeBytes: largest?.fileSizeBytes ?? null,
      rights: dvidsRights(asset, reading),
      retrievedAt,
      notes: reading.isPublicDomain
        ? 'Item-level public domain. Non-endorsement obligation applies and forces human review.'
        : 'REFUSED: not an item-level US Government work.',
    });
  }
}

/** DVIDS material always needs the government public-affairs review. */
export function isDvidsGovernmentPublicAffairs(candidate: MediaCandidate): boolean {
  return candidate.provider === 'DVIDS';
}

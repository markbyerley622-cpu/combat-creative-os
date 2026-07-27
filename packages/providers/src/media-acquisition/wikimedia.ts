import { z } from 'zod';

import {
  type LicenceFamily,
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
 * Wikimedia Commons, through the MediaWiki API.
 *
 * The best-documented rights position of the five: every file carries
 * `extmetadata` stating its licence short name, licence URL, author and — most
 * usefully — `Restrictions`, a machine-readable field naming personality
 * rights, trademark and other non-copyright constraints that a licence alone
 * does not clear.
 *
 * No API key. Commons asks instead for a descriptive User-Agent that identifies
 * the client and offers a contact, which `DEFAULT_MEDIA_USER_AGENT` supplies;
 * an anonymous or spoofed agent is a violation of their policy and this adapter
 * does not send one.
 *
 * `CC BY-SA` is parsed, recorded and passed on as `REVIEW_REQUIRED` rather than
 * refused. Share-alike is an obligation on the *finished advertisement*, and
 * how this repository's output is licensed is a decision for a person.
 */

export const WIKIMEDIA_DESCRIPTOR: MediaAdapterDescriptor = {
  provider: 'WIKIMEDIA_COMMONS',
  supportedKinds: ['VIDEO', 'IMAGE'],
  requiresApiKey: false,
  apiKeyEnvVar: null,
  apiHosts: ['commons.wikimedia.org'],
  downloadHosts: ['upload.wikimedia.org'],
  responseContractStatus: 'DOCUMENTED_NOT_EXECUTED',
  licenceTermsUrl: 'https://commons.wikimedia.org/wiki/Commons:Licensing',
};

const WIKIMEDIA_ORIGIN = 'https://commons.wikimedia.org';

const ExtMetadataValueSchema = z
  .object({ value: z.union([z.string(), z.number()]).optional(), source: z.string().optional() })
  .passthrough();

const ImageInfoSchema = z
  .object({
    url: z.string().optional(),
    descriptionurl: z.string().optional(),
    thumburl: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    size: z.number().optional(),
    duration: z.number().optional(),
    mime: z.string().optional(),
    mediatype: z.string().optional(),
    extmetadata: z.record(ExtMetadataValueSchema).optional(),
  })
  .passthrough();

const CommonsPageSchema = z
  .object({
    pageid: z.number().optional(),
    title: z.string(),
    imageinfo: z.array(ImageInfoSchema).optional(),
  })
  .passthrough();

const CommonsQueryResponseSchema = z
  .object({
    batchcomplete: z.union([z.boolean(), z.string()]).optional(),
    continue: z.record(z.unknown()).optional(),
    query: z
      .object({ pages: z.array(CommonsPageSchema).default([]) })
      .passthrough()
      .optional(),
    error: z
      .object({ code: z.string().optional(), info: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

function meta(
  extmetadata: Record<string, z.infer<typeof ExtMetadataValueSchema>> | undefined,
  key: string,
): string {
  const raw = extmetadata?.[key]?.value;
  if (raw === undefined) return '';
  // Commons returns small HTML fragments in several of these fields (an author
  // is often an anchor). Tags are stripped rather than rendered: nothing in
  // this pipeline displays markup, and a credit line carrying an `<a href>`
  // would put a URL somewhere provenance does not expect one.
  return String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Maps a Commons licence short name onto a normalized family.
 *
 * Ordered most-restrictive-first: `CC BY-NC-SA` contains `CC BY`, so a naive
 * check in the other order would classify a NonCommercial file as plain
 * attribution and let it through. That single ordering bug is the whole reason
 * this is a table walked in order rather than a chain of `includes`.
 */
export function classifyCommonsLicence(shortName: string): LicenceFamily {
  const value = shortName.toLowerCase().replace(/[\s_]+/g, '-');
  const table: readonly { readonly needle: string; readonly family: LicenceFamily }[] = [
    { needle: 'cc-by-nc-nd', family: 'CC_BY_NC_ND' },
    { needle: 'cc-by-nc-sa', family: 'CC_BY_NC_SA' },
    { needle: 'cc-by-nc', family: 'CC_BY_NC' },
    { needle: 'cc-by-nd', family: 'CC_BY_ND' },
    { needle: 'cc-by-sa', family: 'CC_BY_SA' },
    { needle: 'cc0', family: 'CC0' },
    { needle: 'cc-zero', family: 'CC0' },
    { needle: 'public-domain-mark', family: 'PUBLIC_DOMAIN_MARK' },
    { needle: 'pdm', family: 'PUBLIC_DOMAIN_MARK' },
    { needle: 'pd-usgov', family: 'US_GOVERNMENT_PUBLIC_DOMAIN' },
    { needle: 'pd-us', family: 'PUBLIC_DOMAIN' },
    { needle: 'public-domain', family: 'PUBLIC_DOMAIN' },
    { needle: 'cc-by', family: 'CC_BY' },
    { needle: 'fair-use', family: 'ALL_RIGHTS_RESERVED' },
    { needle: 'non-free', family: 'ALL_RIGHTS_RESERVED' },
  ];
  for (const entry of table) {
    if (value.includes(entry.needle)) return entry.family;
  }
  return 'UNKNOWN';
}

function commonsRights(
  info: z.infer<typeof ImageInfoSchema>,
  landingPageUrl: string,
): MediaRightsFacts {
  const extmetadata = info.extmetadata;
  const shortName = meta(extmetadata, 'LicenseShortName') || meta(extmetadata, 'License');
  // Commons publishes two licence names per file: a human short name
  // ("Public domain") and the template id ("pd-usgov-military"). The template
  // is the more specific of the two, and the difference matters — "public
  // domain" and "US Government work" carry different obligations. So the
  // template's reading wins whenever it establishes one, and the short name is
  // the fallback rather than the primary.
  const templateFamily = classifyCommonsLicence(meta(extmetadata, 'License'));
  const family = templateFamily === 'UNKNOWN' ? classifyCommonsLicence(shortName) : templateFamily;
  const artist = meta(extmetadata, 'Artist');
  const credit = meta(extmetadata, 'Credit');
  const licenceUrl = meta(extmetadata, 'LicenseUrl');
  const usageTerms = meta(extmetadata, 'UsageTerms');
  const restrictionsField = meta(extmetadata, 'Restrictions');
  const attributionRequired = meta(extmetadata, 'AttributionRequired').toLowerCase() === 'true';

  const restrictions: string[] = [
    'Wikimedia Commons hosts files under many different licences; the licence recorded on this item is the only one that applies to it.',
  ];
  if (restrictionsField) {
    // Commons spells these as `trademarked|personality`, and each one is a
    // non-copyright restriction that a licence cannot clear.
    restrictions.push(`Commons records these non-copyright restrictions: ${restrictionsField}`);
  }
  if (usageTerms) restrictions.push(`Usage terms: ${usageTerms}`);
  if (attributionRequired) restrictions.push('Attribution required by the licence.');

  const lowered = restrictionsField.toLowerCase();
  return {
    declaredLicence: boundedText(shortName, 200, 'NOT_STATED'),
    licenceFamily: family,
    ...(licenceUrl ? { licenceUrl: boundedText(licenceUrl, 2000) } : {}),
    creator: boundedText(artist || credit, 300, 'NOT_STATED'),
    creatorUrl: landingPageUrl,
    attributionText: boundedText(
      `${artist || credit || 'Unknown author'} — ${shortName || 'licence not stated'} — via Wikimedia Commons (${landingPageUrl})`,
      600,
    ),
    commercialUse: commercialUseFor(family),
    derivativeUse: derivativeUseFor(family),
    paidAdvertisingUse: commercialUseFor(family) === 'PERMITTED' ? 'UNKNOWN' : 'PROHIBITED',
    // Commons states personality and trademark restrictions explicitly when it
    // knows of them. Absence is not evidence of absence, so the honest reading
    // of "no Restrictions field" is UNKNOWN rather than NONE_APPARENT.
    recognizablePersonRisk: lowered.includes('personality') ? 'PRESENT' : 'UNKNOWN',
    trademarkOrLogoRisk: lowered.includes('trademark') ? 'PRESENT' : 'UNKNOWN',
    endorsementRisk: 'MEDIUM',
    modelReleaseStatus: 'NOT_PROVIDED',
    propertyReleaseStatus: 'NOT_PROVIDED',
    sourceRestrictions: restrictions,
  };
}

function commercialUseFor(family: LicenceFamily): MediaRightsFacts['commercialUse'] {
  switch (family) {
    case 'CC0':
    case 'PUBLIC_DOMAIN':
    case 'PUBLIC_DOMAIN_MARK':
    case 'US_GOVERNMENT_PUBLIC_DOMAIN':
    case 'CC_BY':
    case 'CC_BY_SA':
      return 'PERMITTED';
    case 'CC_BY_NC':
    case 'CC_BY_NC_SA':
    case 'CC_BY_NC_ND':
    case 'ALL_RIGHTS_RESERVED':
      return 'PROHIBITED';
    default:
      return 'UNKNOWN';
  }
}

function derivativeUseFor(family: LicenceFamily): MediaRightsFacts['derivativeUse'] {
  switch (family) {
    case 'CC_BY_ND':
    case 'CC_BY_NC_ND':
    case 'ALL_RIGHTS_RESERVED':
      return 'PROHIBITED';
    case 'CC0':
    case 'PUBLIC_DOMAIN':
    case 'PUBLIC_DOMAIN_MARK':
    case 'US_GOVERNMENT_PUBLIC_DOMAIN':
    case 'CC_BY':
    case 'CC_BY_SA':
      return 'PERMITTED';
    default:
      return 'UNKNOWN';
  }
}

export class WikimediaMediaProvider implements MediaAcquisitionProvider {
  readonly id = 'WIKIMEDIA_COMMONS' as const;

  constructor(private readonly config: MediaAdapterConfig = {}) {}

  async healthcheck(options: MediaProviderCallOptions = {}): Promise<MediaProviderHealth> {
    try {
      await fetchProviderJson(
        this.url({ action: 'query', meta: 'siteinfo', format: 'json', formatversion: '2' }),
        urlPolicyFor(WIKIMEDIA_DESCRIPTOR, this.config, 'API'),
        resolveHttpOptions(this.config, options.signal),
      );
      return {
        provider: this.id,
        state: 'READY',
        detail: 'the MediaWiki API answered (no API key is required)',
        supportedKinds: WIKIMEDIA_DESCRIPTOR.supportedKinds,
        credentialConfigured: true,
      };
    } catch (error) {
      return healthFromError(this.id, WIKIMEDIA_DESCRIPTOR.supportedKinds, true, error);
    }
  }

  async search(
    request: MediaSearchRequest,
    options: MediaProviderCallOptions = {},
  ): Promise<MediaSearchPage> {
    if (request.kind === 'AUDIO') {
      throw new MediaHttpError(
        'REJECTED',
        'this adapter claims Commons images and video only; audio would need its own mediatype handling and is not claimed',
      );
    }
    const filetype = request.kind === 'VIDEO' ? 'video' : 'bitmap';
    const limit = Math.min(request.perPage, 50);
    const body = await fetchProviderJson(
      this.url({
        action: 'query',
        format: 'json',
        formatversion: '2',
        generator: 'search',
        // Namespace 6 is File:. `filetype:` narrows to the media class.
        gsrsearch: `${request.query} filetype:${filetype}`,
        gsrnamespace: '6',
        gsrlimit: String(limit),
        gsroffset: String((request.page - 1) * limit),
        prop: 'imageinfo',
        iiprop: 'url|size|mime|mediatype|extmetadata',
        iiurlwidth: '480',
      }),
      urlPolicyFor(WIKIMEDIA_DESCRIPTOR, this.config, 'API'),
      resolveHttpOptions(this.config, options.signal),
    );
    const parsed = parseProviderResponse(CommonsQueryResponseSchema, body, this.id, 'action=query');
    if (parsed.error) {
      throw new MediaHttpError(
        'REJECTED',
        `Commons rejected the query: ${parsed.error.info ?? parsed.error.code ?? 'unknown'}`,
      );
    }

    const retrievedAt = new Date();
    const candidates = (parsed.query?.pages ?? [])
      .map((page) => this.toCandidate(page, request.kind, retrievedAt))
      .filter((candidate): candidate is MediaCandidate => candidate !== null);

    return {
      provider: this.id,
      candidates: applyRequestFilters(candidates, request),
      page: request.page,
      perPage: limit,
      // MediaWiki's generator=search reports no usable total for this shape.
      totalResults: null,
      hasNextPage: parsed.continue !== undefined,
    };
  }

  async getCandidateDetails(
    providerAssetId: string,
    kind: MediaKind,
    options: MediaProviderCallOptions = {},
  ): Promise<MediaCandidate> {
    const body = await fetchProviderJson(
      this.url({
        action: 'query',
        format: 'json',
        formatversion: '2',
        titles: providerAssetId,
        prop: 'imageinfo',
        iiprop: 'url|size|mime|mediatype|extmetadata',
        iiurlwidth: '480',
      }),
      urlPolicyFor(WIKIMEDIA_DESCRIPTOR, this.config, 'API'),
      resolveHttpOptions(this.config, options.signal),
    );
    const parsed = parseProviderResponse(CommonsQueryResponseSchema, body, this.id, 'action=query');
    const page = parsed.query?.pages?.[0];
    const candidate = page ? this.toCandidate(page, kind, new Date()) : null;
    if (!candidate) {
      throw new MediaHttpError(
        'REJECTED',
        `Commons has no usable file record for "${providerAssetId}"`,
      );
    }
    return candidate;
  }

  resolvePreview(candidate: MediaCandidate): ResolvedMediaUrl | null {
    if (!candidate.previewUrl) return null;
    return {
      url: candidate.previewUrl,
      host: hostOf(candidate.previewUrl),
      renditionLabel: 'thumb',
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
      // Commons publishes per-file licensing metadata, which is the strongest
      // evidence basis available among these five.
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
      urlPolicyFor(WIKIMEDIA_DESCRIPTOR, this.config, 'DOWNLOAD'),
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

  private url(params: Record<string, string>): string {
    const origin = originFor(WIKIMEDIA_DESCRIPTOR, this.config, WIKIMEDIA_ORIGIN);
    return `${origin}/w/api.php?${new URLSearchParams(params).toString()}`;
  }

  private toCandidate(
    page: z.infer<typeof CommonsPageSchema>,
    kind: MediaKind,
    retrievedAt: Date,
  ): MediaCandidate | null {
    const info = page.imageinfo?.[0];
    // A page with no imageinfo is a redirect or a deleted file. Skipped rather
    // than represented as a candidate with no file behind it.
    if (!info?.url) return null;

    const landingPageUrl =
      info.descriptionurl ?? `${WIKIMEDIA_ORIGIN}/wiki/${encodeURIComponent(page.title)}`;
    const renditions: MediaRendition[] = [
      {
        label: 'original',
        url: rewriteForOverride(info.url, this.config),
        ...(info.width ? { widthPx: info.width } : {}),
        ...(info.height ? { heightPx: info.height } : {}),
        ...(info.size ? { fileSizeBytes: info.size } : {}),
        ...(info.mime ? { fileType: boundedText(info.mime.split('/').pop(), 40) } : {}),
      },
    ];

    return buildCandidate({
      provider: this.id,
      candidateId: candidateIdFor('WC', page.title.replace(/^File:/i, '')),
      providerAssetId: page.title,
      mediaKind: kind,
      title: boundedText(page.title.replace(/^File:/i, '').replace(/_/g, ' '), 300, page.title),
      landingPageUrl,
      ...(info.thumburl ? { previewUrl: rewriteForOverride(info.thumburl, this.config) } : {}),
      renditions,
      durationSeconds: info.duration ?? null,
      widthPx: info.width ?? null,
      heightPx: info.height ?? null,
      frameRate: null,
      fileSizeBytes: info.size ?? null,
      rights: commonsRights(info, landingPageUrl),
      retrievedAt,
    });
  }
}

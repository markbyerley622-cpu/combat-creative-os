import {
  assertLifecycleTransition,
  type ApprovedUsage,
  type MediaAcquisitionProviderId,
  type MediaAcquisitionSelection,
  type MediaCandidate,
  type MediaKind,
  type MediaSearchPage,
  type MediaSearchRequest,
} from './contracts';
import { approvalCoversUsage } from './rights-policy';
import { MediaHttpError } from './http';

/**
 * The provider seam for acquiring licensed source media.
 *
 * Seven methods, and the split between them is the safety property. Searching,
 * describing and previewing are free operations over public metadata.
 * *Downloading* is not: it is the step that puts third-party bytes on our disk
 * with the intention of publishing them, so it is the only step that takes an
 * approval, and the only one that can refuse for a rights reason.
 *
 * An adapter here is thin by design. It translates one provider's response
 * shape into the normalized contracts and nothing else — it makes no rights
 * decision, computes no quality score and never writes a file. Those live above
 * it, once, so five providers cannot drift into five policies.
 */

export const MEDIA_PROVIDER_HEALTH_STATES = ['READY', 'NOT_CONFIGURED', 'UNREACHABLE'] as const;
export type MediaProviderHealthState = (typeof MEDIA_PROVIDER_HEALTH_STATES)[number];

export interface MediaProviderHealth {
  readonly provider: MediaAcquisitionProviderId;
  readonly state: MediaProviderHealthState;
  /** What is wrong, in words an operator can act on. */
  readonly detail: string;
  /** Which media kinds this provider serves. Never widened by an adapter's optimism. */
  readonly supportedKinds: readonly MediaKind[];
  /** True when an API key is required and present. */
  readonly credentialConfigured: boolean;
}

/**
 * A URL the caller may use, plus where it came from.
 *
 * Never persisted into a shared artefact: provider download URLs are routinely
 * signed or short-lived, which makes them credentials. `downloadHost` is what
 * provenance keeps.
 */
export interface ResolvedMediaUrl {
  readonly url: string;
  readonly host: string;
  readonly renditionLabel: string;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly fileSizeBytes: number | null;
}

/**
 * The licence position as the provider states it, captured for the record.
 *
 * Text and links only. No screenshot, no page dump, no bytes — the same rule
 * the UI-capture milestone settled on, for the same reason: an artefact that
 * can hold arbitrary page content will eventually hold something that should
 * never have been persisted.
 */
export interface MediaRightsEvidence {
  readonly candidateId: string;
  readonly provider: MediaAcquisitionProviderId;
  /** The provider's own licence name, verbatim. */
  readonly declaredLicence: string;
  readonly licenceUrl: string | null;
  readonly landingPageUrl: string;
  readonly creator: string;
  readonly creatorUrl: string | null;
  /** Verbatim restriction text the provider publishes for this item. */
  readonly restrictions: readonly string[];
  /** Where this evidence came from: an API field, or the provider's published terms. */
  readonly evidenceBasis: 'PROVIDER_API_FIELD' | 'PROVIDER_PUBLISHED_TERMS' | 'OPERATOR_SUPPLIED';
  readonly capturedAt: string;
}

export interface DownloadedMediaBytes {
  readonly bytes: Uint8Array;
  readonly downloadHost: string;
  readonly renditionLabel: string;
  readonly contentType: string | null;
  readonly signature: string;
}

export interface DownloadApprovedAssetInput {
  readonly candidate: MediaCandidate;
  readonly selection: MediaAcquisitionSelection;
  /** The usage the download is being made for. Checked against the approval. */
  readonly usage: ApprovedUsage;
  /** Supplied by the caller; nothing in this package reads a clock. */
  readonly now: Date;
}

export interface MediaProviderCallOptions {
  readonly signal?: AbortSignal;
}

export interface MediaAcquisitionProvider {
  readonly id: MediaAcquisitionProviderId;

  /** Is this provider usable right now, and if not, exactly why. Never throws. */
  healthcheck(options?: MediaProviderCallOptions): Promise<MediaProviderHealth>;

  search(request: MediaSearchRequest, options?: MediaProviderCallOptions): Promise<MediaSearchPage>;

  /** The full record for one item, including fields search responses omit. */
  getCandidateDetails(
    providerAssetId: string,
    kind: MediaKind,
    options?: MediaProviderCallOptions,
  ): Promise<MediaCandidate>;

  /** A low-resolution preview URL for the gallery. Never the deliverable file. */
  resolvePreview(candidate: MediaCandidate): ResolvedMediaUrl | null;

  /**
   * The URL for the approved rendition — and the refusal point.
   *
   * Implementations call `assertDownloadPermitted` first. There is no argument
   * that skips it and no flag that disables it.
   */
  resolveApprovedDownload(input: DownloadApprovedAssetInput): ResolvedMediaUrl;

  captureRightsEvidence(candidate: MediaCandidate, capturedAt: Date): MediaRightsEvidence;

  downloadApprovedAsset(
    input: DownloadApprovedAssetInput,
    options?: MediaProviderCallOptions,
  ): Promise<DownloadedMediaBytes>;
}

export class MediaApprovalRequiredError extends Error {
  constructor(
    public readonly candidateId: string,
    public readonly reasons: readonly string[],
  ) {
    super(
      `"${candidateId}" may not be downloaded for output:\n  - ${reasons.join('\n  - ')}\n` +
        'Acquisition never fabricates an approval. Record one with `aamp:media approve` after a person has read the licence.',
    );
    this.name = 'MediaApprovalRequiredError';
  }
}

/**
 * The single gate every download passes through.
 *
 * It checks four independent things, and all four have to hold:
 *
 * 1. The rights policy did not reject the item.
 * 2. A real approval exists, for this candidate, covering this usage, in date.
 * 3. The lifecycle actually reached `APPROVED_FOR_DOWNLOAD` — a candidate that
 *    was never rights-reviewed cannot have been approved, whatever an approval
 *    file claims.
 * 4. The selection names the candidate being downloaded.
 *
 * Point 3 is what makes "no state may be skipped" enforceable rather than
 * documented: an operator who hand-writes an approval for a `DISCOVERED`
 * candidate gets a refusal naming the stations that never happened.
 */
export function assertDownloadPermitted(input: DownloadApprovedAssetInput): void {
  const { candidate, selection, usage, now } = input;
  const reasons: string[] = [];

  if (selection.candidateId !== candidate.candidateId) {
    reasons.push(
      `the selection is for "${selection.candidateId}" but the candidate is "${candidate.candidateId}"`,
    );
  }
  if (selection.approval.candidateId !== candidate.candidateId) {
    reasons.push(
      `the approval is for "${selection.approval.candidateId}" but the candidate is "${candidate.candidateId}"`,
    );
  }
  if (selection.rightsDecision.outcome === 'REJECTED') {
    reasons.push(
      `the rights policy rejected it: ${selection.rightsDecision.reasons.join('; ')}. A rejection is terminal and no approval overrides it.`,
    );
  }

  const coverage = approvalCoversUsage(selection.approval, usage, now);
  if (!coverage.covered) reasons.push(coverage.reason);

  if (candidate.state !== 'APPROVED_FOR_DOWNLOAD') {
    reasons.push(
      `it is ${candidate.state}, not APPROVED_FOR_DOWNLOAD. Every lifecycle station is mandatory; a candidate cannot be approved for a review that never happened.`,
    );
  }

  if (reasons.length > 0) throw new MediaApprovalRequiredError(candidate.candidateId, reasons);
}

/**
 * Advances a candidate one station, refusing a skip.
 *
 * Thin wrapper over `assertLifecycleTransition` so adapters and the CLI share
 * one implementation of the rule rather than each spelling it out.
 */
export function advanceCandidate(
  candidate: MediaCandidate,
  to: MediaCandidate['state'],
): MediaCandidate {
  assertLifecycleTransition(candidate.state, to);
  return { ...candidate, state: to };
}

/**
 * A rendition chosen for download.
 *
 * Prefers the largest rendition that is still within the ceiling, because
 * source resolution is the one quality property that cannot be recovered later
 * — an upscale never restores detail, which is why the quality profile refuses
 * to count one. Ties break on the label so selection is deterministic.
 */
export function selectBestRendition(
  candidate: MediaCandidate,
  maxBytes: number,
): MediaCandidate['renditions'][number] | null {
  const eligible = candidate.renditions.filter(
    (rendition) => (rendition.fileSizeBytes ?? 0) <= maxBytes,
  );
  if (eligible.length === 0) return null;
  const sorted = [...eligible].sort((a, b) => {
    const areaA = (a.widthPx ?? 0) * (a.heightPx ?? 0);
    const areaB = (b.widthPx ?? 0) * (b.heightPx ?? 0);
    if (areaA !== areaB) return areaB - areaA;
    return a.label.localeCompare(b.label);
  });
  return sorted[0] ?? null;
}

/** Maps a transport failure to the health state an operator should see. */
export function healthFromError(
  provider: MediaAcquisitionProviderId,
  supportedKinds: readonly MediaKind[],
  credentialConfigured: boolean,
  error: unknown,
): MediaProviderHealth {
  if (error instanceof MediaHttpError) {
    return {
      provider,
      state: error.kind === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'UNREACHABLE',
      detail: error.message,
      supportedKinds,
      credentialConfigured,
    };
  }
  return {
    provider,
    state: 'UNREACHABLE',
    detail: error instanceof Error ? error.message : String(error),
    supportedKinds,
    credentialConfigured,
  };
}

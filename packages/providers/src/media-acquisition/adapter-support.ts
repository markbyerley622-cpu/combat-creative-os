import { z } from 'zod';

import {
  orientationOf,
  type MediaAcquisitionProviderId,
  type MediaCandidate,
  type MediaKind,
  type MediaRightsFacts,
} from './contracts';
import { MediaHttpError, type MediaHttpOptions, type UrlPolicy } from './http';

/**
 * Shared plumbing for the five official adapters.
 *
 * The point of a shared file here is not brevity — it is that the five
 * adapters must be *identical* in the ways that matter. One place decides how a
 * missing API key is reported, how a response that does not match its schema
 * fails, how a candidate id is formed, and where the test seam is. Five
 * separate implementations of those would eventually be five different
 * behaviours, and the one that drifted would be the one that mattered.
 */

export const DEFAULT_MEDIA_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/**
 * Providers ask for a descriptive agent that identifies the client and offers a
 * way to make contact. Wikimedia's User-Agent policy makes it a condition of
 * access; the others treat it as good manners. Either way an anonymous or
 * spoofed agent is not something this system does.
 */
export const DEFAULT_MEDIA_USER_AGENT =
  'CombatCreativeOS-MediaAcquisition/1.0 (+https://github.com/combat-creative-os; official APIs only)';

export interface MediaAdapterConfig {
  /** Read only from `packages/config`'s validated schema by the caller. */
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly userAgent?: string;
  readonly maxDownloadBytes?: number;
  /**
   * Test seam: an origin to use instead of the real one.
   *
   * Reachable only by a code import — no environment variable selects it, and
   * `createMediaAcquisitionProviders` never sets it. That is what keeps the
   * fake-server tests from being a way to redirect a production process.
   */
  readonly baseUrlOverride?: string;
}

/**
 * How far the response contract for an adapter has actually been verified.
 *
 * Borrowed wholesale from the ComfyUI profiles' `templateStatus`, for the same
 * reason: a schema written from a provider's published documentation and a
 * schema proven against that provider's live server are two different claims,
 * and collapsing them is how "we integrated with X" comes to mean nothing.
 * Only a passing opt-in live test may raise a value here.
 */
export const RESPONSE_CONTRACT_STATUSES = [
  'DOCUMENTED_NOT_EXECUTED',
  'EXECUTED_AGAINST_LIVE_API',
] as const;
export type ResponseContractStatus = (typeof RESPONSE_CONTRACT_STATUSES)[number];

export interface MediaAdapterDescriptor {
  readonly provider: MediaAcquisitionProviderId;
  readonly supportedKinds: readonly MediaKind[];
  readonly requiresApiKey: boolean;
  readonly apiKeyEnvVar: string | null;
  readonly apiHosts: readonly string[];
  readonly downloadHosts: readonly string[];
  readonly responseContractStatus: ResponseContractStatus;
  /** The provider's own licence page, for the credits file. */
  readonly licenceTermsUrl: string;
}

export function resolveHttpOptions(
  config: MediaAdapterConfig,
  signal?: AbortSignal,
): MediaHttpOptions {
  return {
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_MEDIA_REQUEST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
    userAgent: config.userAgent ?? DEFAULT_MEDIA_USER_AGENT,
  };
}

/**
 * The URL policy for one adapter, widened only when a test points it at a local
 * fixture server.
 *
 * The widening is explicit and total: an overridden origin allows exactly that
 * origin's host, plus loopback and plain http. It never *adds* to the real
 * allowlist, so a fixture-driven test cannot accidentally prove something about
 * the production host set.
 */
export function urlPolicyFor(
  descriptor: MediaAdapterDescriptor,
  config: MediaAdapterConfig,
  purpose: 'API' | 'DOWNLOAD',
): UrlPolicy {
  if (config.baseUrlOverride) {
    const host = new URL(config.baseUrlOverride).hostname;
    return { allowedHosts: [host], allowLoopback: true, allowInsecure: true };
  }
  return {
    allowedHosts: purpose === 'API' ? descriptor.apiHosts : descriptor.downloadHosts,
  };
}

export function originFor(
  _descriptor: MediaAdapterDescriptor,
  config: MediaAdapterConfig,
  realOrigin: string,
): string {
  if (!config.baseUrlOverride) return realOrigin.replace(/\/$/, '');
  return config.baseUrlOverride.replace(/\/$/, '');
}

/**
 * Rewrites a provider-supplied absolute URL onto the fixture origin.
 *
 * Only ever applied when an override is configured. Without it the URL is
 * returned untouched and faces the real allowlist — a fixture must not be able
 * to teach the adapter to accept a host it otherwise would not.
 */
export function rewriteForOverride(url: string, config: MediaAdapterConfig): string {
  if (!config.baseUrlOverride) return url;
  try {
    const parsed = new URL(url);
    const target = new URL(config.baseUrlOverride);
    parsed.protocol = target.protocol;
    parsed.host = target.host;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function requireApiKey(
  descriptor: MediaAdapterDescriptor,
  config: MediaAdapterConfig,
): string {
  const key = config.apiKey?.trim();
  if (!key) {
    throw new MediaHttpError(
      'NOT_CONFIGURED',
      `${descriptor.provider} needs ${descriptor.apiKeyEnvVar ?? 'an API key'}. ` +
        'It is not set, so no search was attempted. Nothing here falls back to scraping a web page.',
    );
  }
  return key;
}

/**
 * Parses a provider response through its schema, failing at the boundary.
 *
 * The alternative — reading fields off an `any` — moves the failure three call
 * frames downstream into something that looks like a logic bug. A provider that
 * changed its shape should say so here, by name.
 */
export function parseProviderResponse<T>(
  // `Input` is pinned to `unknown` rather than left to default to `T`: these
  // schemas carry `.default()` and `.passthrough()`, so their input and output
  // types differ, and a `ZodType<T>` parameter would make inference pick the
  // input side and hand every caller a half-optional shape.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  provider: MediaAcquisitionProviderId,
  route: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new MediaHttpError(
    'MALFORMED_RESPONSE',
    `${provider} ${route} returned a shape this client does not recognise`,
    result.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
  );
}

export function candidateIdFor(prefix: string, providerAssetId: string): string {
  // Kept filesystem- and URL-safe: candidate ids become filenames and gallery
  // anchors, and a provider id with a slash in it would silently create a
  // directory.
  const safe = providerAssetId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 90);
  return `${prefix}-${safe}`;
}

/** Trims and bounds provider prose so an oversized field cannot fail the schema downstream. */
export function boundedText(value: string | null | undefined, max: number, fallback = ''): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return (text.length > 0 ? text : fallback).slice(0, max);
}

export interface BuildCandidateInput {
  readonly provider: MediaAcquisitionProviderId;
  readonly candidateId: string;
  readonly providerAssetId: string;
  readonly mediaKind: MediaKind;
  readonly title: string;
  readonly description?: string;
  readonly landingPageUrl: string;
  readonly previewUrl?: string;
  readonly renditions: MediaCandidate['renditions'];
  readonly durationSeconds: number | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly frameRate: number | null;
  readonly fileSizeBytes: number | null;
  readonly rights: MediaRightsFacts;
  readonly retrievedAt: Date;
  readonly suggestedRole?: string;
  readonly notes?: string;
}

/**
 * Assembles a normalized candidate.
 *
 * Always `DISCOVERED`. An adapter never advances the lifecycle: what a provider
 * returned is the first station and nothing more, however complete its metadata
 * happened to be.
 */
export function buildCandidate(input: BuildCandidateInput): MediaCandidate {
  return {
    candidateId: input.candidateId,
    provider: input.provider,
    providerAssetId: input.providerAssetId,
    mediaKind: input.mediaKind,
    title: boundedText(input.title, 300, 'Untitled'),
    description: boundedText(input.description, 2000),
    landingPageUrl: input.landingPageUrl,
    ...(input.previewUrl ? { previewUrl: input.previewUrl } : {}),
    renditions: input.renditions,
    durationSeconds: input.durationSeconds,
    widthPx: input.widthPx,
    heightPx: input.heightPx,
    frameRate: input.frameRate,
    orientation: orientationOf(input.widthPx ?? undefined, input.heightPx ?? undefined),
    fileSizeBytes: input.fileSizeBytes,
    rights: input.rights,
    retrievedAt: input.retrievedAt.toISOString(),
    state: 'DISCOVERED',
    ...(input.suggestedRole ? { suggestedRole: input.suggestedRole } : {}),
    notes: boundedText(input.notes, 2000),
  };
}

/**
 * Applies the caller's declared filters to whatever a provider returned.
 *
 * Providers vary in which filters they support server-side, and several accept
 * a parameter and then ignore it. Re-applying every filter locally means a
 * search request means the same thing across all five, and a provider that
 * quietly widened a filter cannot leak an undersized clip into a run.
 */
export function applyRequestFilters(
  candidates: readonly MediaCandidate[],
  request: {
    readonly orientation?: MediaCandidate['orientation'];
    readonly minWidthPx?: number;
    readonly minHeightPx?: number;
    readonly minDurationSeconds?: number;
    readonly maxDurationSeconds?: number;
  },
): readonly MediaCandidate[] {
  return candidates.filter((candidate) => {
    if (
      request.orientation &&
      request.orientation !== 'UNKNOWN' &&
      candidate.orientation !== request.orientation
    ) {
      return false;
    }
    if (request.minWidthPx !== undefined && (candidate.widthPx ?? 0) < request.minWidthPx) {
      return false;
    }
    if (request.minHeightPx !== undefined && (candidate.heightPx ?? 0) < request.minHeightPx) {
      return false;
    }
    if (
      request.minDurationSeconds !== undefined &&
      candidate.durationSeconds !== null &&
      candidate.durationSeconds < request.minDurationSeconds
    ) {
      return false;
    }
    if (
      request.maxDurationSeconds !== undefined &&
      candidate.durationSeconds !== null &&
      candidate.durationSeconds > request.maxDurationSeconds
    ) {
      return false;
    }
    return true;
  });
}

/**
 * The vertical-orientation filter a provider is asked for, where it has one.
 *
 * Shared because all four searchable providers spell it differently and the
 * mapping is otherwise duplicated four times.
 */
export function orientationParam(
  orientation: MediaCandidate['orientation'] | undefined,
): 'portrait' | 'landscape' | 'square' | null {
  if (!orientation || orientation === 'UNKNOWN') return null;
  return orientation.toLowerCase() as 'portrait' | 'landscape' | 'square';
}

import type { MediaAcquisitionProviderId, MediaKind } from './contracts';
import type { MediaAcquisitionProvider } from './provider';
import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  DEFAULT_MEDIA_REQUEST_TIMEOUT_MS,
  DEFAULT_MEDIA_USER_AGENT,
  type MediaAdapterConfig,
  type MediaAdapterDescriptor,
} from './adapter-support';
import { DvidsMediaProvider, DVIDS_DESCRIPTOR } from './dvids';
import { OpenverseMediaProvider, OPENVERSE_DESCRIPTOR } from './openverse';
import { PexelsMediaProvider, PEXELS_DESCRIPTOR } from './pexels';
import { PixabayMediaProvider, PIXABAY_DESCRIPTOR } from './pixabay';
import { WikimediaMediaProvider, WIKIMEDIA_DESCRIPTOR } from './wikimedia';

/**
 * The one construction site for media-acquisition adapters.
 *
 * It reads credentials from a validated env shape supplied by the caller —
 * never `process.env` — and it **never** sets `baseUrlOverride`. That omission
 * is the point: the fixture-server seam exists for tests and is reachable only
 * by a code import, so no environment variable can point a real process at an
 * attacker-controlled origin. The same rule the identity fakes follow.
 *
 * There is no mock provider here and no fallback. A provider without its key is
 * reported `NOT_CONFIGURED` by its own healthcheck and contributes nothing to a
 * run; it never quietly becomes a synthetic result. A fabricated catalogue
 * entry would be worse than an empty search, because a search that returns
 * nothing is obviously a search that returned nothing.
 */

export interface MediaAcquisitionEnv {
  readonly PEXELS_API_KEY?: string | undefined;
  readonly PIXABAY_API_KEY?: string | undefined;
  readonly DVIDS_API_KEY?: string | undefined;
  readonly MEDIA_ACQUISITION_TIMEOUT_MS?: number | undefined;
  readonly MEDIA_ACQUISITION_MAX_DOWNLOAD_BYTES?: number | undefined;
  readonly MEDIA_ACQUISITION_USER_AGENT?: string | undefined;
}

export const MEDIA_ADAPTER_DESCRIPTORS: readonly MediaAdapterDescriptor[] = [
  PEXELS_DESCRIPTOR,
  PIXABAY_DESCRIPTOR,
  DVIDS_DESCRIPTOR,
  WIKIMEDIA_DESCRIPTOR,
  OPENVERSE_DESCRIPTOR,
];

export function descriptorFor(provider: MediaAcquisitionProviderId): MediaAdapterDescriptor | null {
  return MEDIA_ADAPTER_DESCRIPTORS.find((entry) => entry.provider === provider) ?? null;
}

/** Which providers can serve a given media kind. Used to explain an empty run. */
export function providersForKind(kind: MediaKind): readonly MediaAcquisitionProviderId[] {
  return MEDIA_ADAPTER_DESCRIPTORS.filter((entry) => entry.supportedKinds.includes(kind)).map(
    (entry) => entry.provider,
  );
}

function baseConfig(env: MediaAcquisitionEnv): MediaAdapterConfig {
  return {
    requestTimeoutMs: env.MEDIA_ACQUISITION_TIMEOUT_MS ?? DEFAULT_MEDIA_REQUEST_TIMEOUT_MS,
    maxDownloadBytes: env.MEDIA_ACQUISITION_MAX_DOWNLOAD_BYTES ?? DEFAULT_MAX_DOWNLOAD_BYTES,
    userAgent: env.MEDIA_ACQUISITION_USER_AGENT ?? DEFAULT_MEDIA_USER_AGENT,
  };
}

export function createMediaAcquisitionProvider(
  provider: MediaAcquisitionProviderId,
  env: MediaAcquisitionEnv,
): MediaAcquisitionProvider {
  const base = baseConfig(env);
  switch (provider) {
    case 'PEXELS':
      return new PexelsMediaProvider({
        ...base,
        ...(env.PEXELS_API_KEY ? { apiKey: env.PEXELS_API_KEY } : {}),
      });
    case 'PIXABAY':
      return new PixabayMediaProvider({
        ...base,
        ...(env.PIXABAY_API_KEY ? { apiKey: env.PIXABAY_API_KEY } : {}),
      });
    case 'DVIDS':
      return new DvidsMediaProvider({
        ...base,
        ...(env.DVIDS_API_KEY ? { apiKey: env.DVIDS_API_KEY } : {}),
      });
    case 'WIKIMEDIA_COMMONS':
      return new WikimediaMediaProvider(base);
    case 'OPENVERSE':
      return new OpenverseMediaProvider(base);
    case 'EXTERNAL_PILOT_PACK':
      throw new Error(
        'EXTERNAL_PILOT_PACK is not a network provider — it is an operator folder imported read-only by `aamp:media import-pack`, and it has no adapter by design.',
      );
    default: {
      const exhaustive: never = provider;
      throw new Error(`unknown media acquisition provider: ${String(exhaustive)}`);
    }
  }
}

export function createMediaAcquisitionProviders(
  providers: readonly MediaAcquisitionProviderId[],
  env: MediaAcquisitionEnv,
): ReadonlyMap<MediaAcquisitionProviderId, MediaAcquisitionProvider> {
  const map = new Map<MediaAcquisitionProviderId, MediaAcquisitionProvider>();
  for (const provider of providers) {
    if (provider === 'EXTERNAL_PILOT_PACK') continue;
    map.set(provider, createMediaAcquisitionProvider(provider, env));
  }
  return map;
}

/**
 * Sources this system refuses to integrate with, and why.
 *
 * Present as data rather than as an absence so the refusal is legible: an
 * operator who asks for `--providers youtube` gets the reason, and a future
 * contributor who wonders why there is no adapter finds the answer next to the
 * ones there are. None of these publishes an API that grants reuse rights for
 * third-party advertising, and reaching them would mean a scraper — which is
 * both a terms violation and a rights fiction.
 */
export const REFUSED_SOURCES: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: 'youtube',
    why: 'the standard YouTube licence grants rights to YouTube, not to third parties, and downloading is a terms violation',
  },
  {
    name: 'tiktok',
    why: 'no reuse licence is granted to third parties and no official download API exists',
  },
  { name: 'instagram', why: 'no reuse licence is granted to third parties' },
  { name: 'facebook', why: 'no reuse licence is granted to third parties' },
  {
    name: 'ufc',
    why: 'broadcast footage is fully copyrighted and licensed per use by the promotion',
  },
  {
    name: 'one championship',
    why: 'broadcast footage is fully copyrighted and licensed per use by the promotion',
  },
  { name: 'dazn', why: 'broadcast footage is fully copyrighted and licensed per use' },
  {
    name: 'internet archive',
    why: 'items carry heterogeneous and frequently unverified rights; an archive host is not a licence',
  },
  {
    name: 'social media mirror',
    why: 'a re-upload carries none of the original rights and obscures the actual rights holder',
  },
];

export function refusedSourceReason(name: string): string | null {
  const lowered = name.trim().toLowerCase();
  return REFUSED_SOURCES.find((entry) => entry.name === lowered)?.why ?? null;
}

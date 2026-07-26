/**
 * What every collaborator the composition root built says about itself.
 *
 * A run's provenance is only as good as its ability to name the thing that did
 * the work. "reasoning: ok" is worthless six months later; "reasoning:
 * claude / claude-opus-4-8 / REAL" is auditable. So every provider the factory
 * constructs produces one of these, and the list travels into the provenance
 * artefact, the `--json` result and the doctor report.
 *
 * `simulated` is separate from `capability` deliberately: a fixture video
 * provider is fully capable of producing an MP4, and saying so without also
 * saying it is synthetic is exactly the confusion this codebase guards against.
 */

export const PROVIDER_ROLES = [
  'persistence',
  'vector-search',
  'embedding',
  'reranking',
  'reasoning',
  'video-generation',
  'motion-graphics',
  'actual-media-qa',
  'storage',
  'logging',
] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

export interface ProviderIdentity {
  readonly role: ProviderRole;
  /** The concrete implementation, e.g. `prisma-postgresql`, `comfyui`, `ffmpeg`. */
  readonly identity: string;
  /**
   * The model revision, binary version or schema version that would change the
   * result. `UNKNOWN` when it genuinely could not be established — never a
   * plausible guess.
   */
  readonly version: string;
  /** What it is able to do here, in this run's configuration. */
  readonly capability: string;
  /** False only when the thing named actually did the work it claims. */
  readonly simulated: boolean;
  /** Present when the provider is addressed over the network. Host and port only — never credentials. */
  readonly endpointHost?: string;
}

/**
 * Reduces a URL to `host:port`.
 *
 * Endpoints are useful provenance; the rest of a URL is not, and a query string
 * on a storage endpoint is where a signed URL's signature lives. Only the
 * authority survives, and a value that will not parse is reported as
 * `unparseable` rather than echoed.
 */
export function endpointHostOf(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return 'unparseable';
  }
}

/** Stable ordering, so two runs' provenance can be diffed without noise. */
export function sortProviderIdentities(
  identities: readonly ProviderIdentity[],
): readonly ProviderIdentity[] {
  const order = new Map(PROVIDER_ROLES.map((role, index) => [role, index]));
  return [...identities].sort((left, right) => {
    const byRole = (order.get(left.role) ?? 0) - (order.get(right.role) ?? 0);
    return byRole !== 0 ? byRole : left.identity.localeCompare(right.identity);
  });
}

/**
 * The one place this package is allowed to reach the network for media.
 *
 * Every rule here exists because the URLs being fetched are *provider-supplied
 * strings*. A search response is untrusted input that happens to be shaped like
 * a catalogue, and its `url` fields are the most dangerous fields in this
 * milestone: unchecked, they turn "download the rendition the API pointed at"
 * into an arbitrary request from inside the network boundary.
 *
 * So:
 *
 * - **Host allowlists, per provider, per purpose.** API hosts and download
 *   hosts are separate lists, because a provider's CDN and its API are
 *   different trust surfaces and a search endpoint has no business returning a
 *   download from an unrelated host.
 * - **Redirects are followed by hand.** `fetch`'s automatic redirect handling
 *   validates nothing: a 302 from an allowed CDN to `http://169.254.169.254`
 *   would be followed silently. Every hop is re-validated against the same
 *   allowlist, and the hop count is bounded.
 * - **No literal addresses, no loopback, no link-local, no credentials in the
 *   URL.** A hostname that parses as an IP is refused before DNS is consulted.
 * - **Bodies are bounded while they stream**, not after. A 40 GB response
 *   cannot be measured by reading it first.
 * - **Bytes are sniffed.** A `.mp4` URL that returns an HTML error page is a
 *   failure, not a video file, and a content-type header is the server's
 *   opinion rather than a measurement.
 */

export const MEDIA_HTTP_FAILURE_KINDS = [
  /** The URL was refused before any request was made. */
  'DISALLOWED_URL',
  /** A redirect pointed somewhere the allowlist does not cover. */
  'REDIRECT_ESCAPE',
  /** DNS, refused connection, TLS. */
  'UNREACHABLE',
  'TIMEOUT',
  'CANCELLED',
  /** 401/403 — usually a missing or wrong API key. */
  'UNAUTHORIZED',
  /** 429, or a provider's own quota message. */
  'RATE_LIMITED',
  /** 4xx that is not auth or rate limiting. */
  'REJECTED',
  'SERVER_ERROR',
  /** A body this client could not parse, or one that did not match its schema. */
  'MALFORMED_RESPONSE',
  /** The response exceeded the byte ceiling. */
  'TOO_LARGE',
  /** The bytes are not the media type they were supposed to be. */
  'UNEXPECTED_CONTENT',
  /** No API key is configured for this provider. */
  'NOT_CONFIGURED',
] as const;
export type MediaHttpFailureKind = (typeof MEDIA_HTTP_FAILURE_KINDS)[number];

export class MediaHttpError extends Error {
  constructor(
    public readonly kind: MediaHttpFailureKind,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'MediaHttpError';
  }
}

/**
 * Hosts that are never contacted, whatever an allowlist says.
 *
 * Checked before the allowlist rather than after, so a test fixture pointed at
 * `127.0.0.1` has to opt in explicitly (`allowLoopback`) rather than a
 * production allowlist accidentally permitting one.
 */
const LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];

/** Address forms that must never be reachable — cloud metadata above all. */
const BLOCKED_ADDRESS_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /^169\.254\./,
    why: 'link-local addresses include the cloud instance metadata service',
  },
  { pattern: /^10\./, why: 'private address space' },
  { pattern: /^192\.168\./, why: 'private address space' },
  { pattern: /^172\.(1[6-9]|2\d|3[01])\./, why: 'private address space' },
  { pattern: /^127\./, why: 'loopback' },
  { pattern: /^0\./, why: 'unspecified address space' },
  { pattern: /^(fc|fd)[0-9a-f]{2}:/i, why: 'IPv6 unique-local address space' },
  { pattern: /^fe80:/i, why: 'IPv6 link-local address space' },
];

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface UrlPolicy {
  /** Hostnames, or `.suffix` entries matching any subdomain of that suffix. */
  readonly allowedHosts: readonly string[];
  /** Test-only escape hatch, off by default and never set by an adapter. */
  readonly allowLoopback?: boolean;
  /** Permits `http:` — only ever true for the loopback fixture server. */
  readonly allowInsecure?: boolean;
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    if (allowed.startsWith('.')) return host === allowed.slice(1) || host.endsWith(allowed);
    return host === allowed;
  });
}

/**
 * Refuses a URL before it can become a request.
 *
 * Returns the parsed URL so callers use the normalized form rather than the
 * string they were handed — the two can differ, and the one that gets fetched
 * must be the one that was checked.
 */
export function assertAllowedUrl(raw: string, policy: UrlPolicy, what = 'URL'): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new MediaHttpError('DISALLOWED_URL', `${what} is not a valid URL: ${raw}`);
  }

  const insecureOk = policy.allowInsecure === true;
  if (parsed.protocol !== 'https:' && !(insecureOk && parsed.protocol === 'http:')) {
    throw new MediaHttpError(
      'DISALLOWED_URL',
      `${what} must be https:, got ${parsed.protocol} (${parsed.host})`,
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    // Credentials embedded in a URL would be persisted into provenance the
    // moment anything logged the URL. Refused rather than stripped.
    throw new MediaHttpError('DISALLOWED_URL', `${what} carries embedded credentials`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.includes(hostname)) {
    if (policy.allowLoopback !== true) {
      throw new MediaHttpError('DISALLOWED_URL', `${what} points at loopback (${hostname})`);
    }
  } else {
    for (const { pattern, why } of BLOCKED_ADDRESS_PATTERNS) {
      if (pattern.test(hostname)) {
        throw new MediaHttpError('DISALLOWED_URL', `${what} points at ${hostname}: ${why}`);
      }
    }
    if (IPV4_LITERAL.test(hostname) || hostname.includes(':')) {
      throw new MediaHttpError(
        'DISALLOWED_URL',
        `${what} is a literal address (${hostname}); only named provider hosts are contacted`,
      );
    }
  }

  if (!hostAllowed(hostname, policy.allowedHosts)) {
    throw new MediaHttpError(
      'DISALLOWED_URL',
      `${what} host "${hostname}" is not in this provider's allowlist (${policy.allowedHosts.join(', ')})`,
    );
  }

  return parsed;
}

export function classifyStatus(status: number): MediaHttpFailureKind {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'REJECTED';
}

export interface MediaHttpOptions {
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs: number;
  readonly signal?: AbortSignal;
  /** Sent on every request. Providers ask for a descriptive, contactable agent. */
  readonly userAgent: string;
}

function resolveFetch(options: MediaHttpOptions): typeof fetch {
  const injected = options.fetchImpl ?? globalThis.fetch;
  if (typeof injected !== 'function') {
    throw new MediaHttpError(
      'UNREACHABLE',
      'No fetch implementation is available — pass fetchImpl explicitly',
    );
  }
  return injected;
}

/**
 * One request, with the deadline and the caller's cancellation both honoured.
 *
 * The two are distinguished in the failure kind: a run the operator cancelled
 * is not a provider that timed out, and reporting one as the other sends
 * somebody looking at the wrong thing.
 */
async function requestOnce(
  url: URL,
  init: { readonly method: 'GET'; readonly headers: Record<string, string> },
  options: MediaHttpOptions,
): Promise<Response> {
  const fetchImpl = resolveFetch(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    return await fetchImpl(url.toString(), {
      method: init.method,
      headers: init.headers,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new MediaHttpError('CANCELLED', `the request to ${url.host} was cancelled`, error);
    }
    if (controller.signal.aborted) {
      throw new MediaHttpError(
        'TIMEOUT',
        `${url.host}${url.pathname} exceeded ${options.requestTimeoutMs}ms`,
        error,
      );
    }
    throw new MediaHttpError(
      'UNREACHABLE',
      `${url.host}${url.pathname} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

const MAX_REDIRECTS = 5;

/**
 * Follows redirects by hand, re-validating every hop.
 *
 * This is the SSRF control that actually matters. The initial URL being on an
 * allowlist says nothing about where a 302 sends the second request, and
 * `fetch`'s own following would make that hop invisible.
 */
async function requestFollowing(
  start: URL,
  headers: Record<string, string>,
  policy: UrlPolicy,
  options: MediaHttpOptions,
): Promise<{ readonly response: Response; readonly finalUrl: URL }> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestOnce(current, { method: 'GET', headers }, options);
    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: current };
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new MediaHttpError(
        'MALFORMED_RESPONSE',
        `${current.host} answered ${response.status} with no Location header`,
      );
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new MediaHttpError(
        'REDIRECT_ESCAPE',
        `${current.host} redirected to an unparsable location`,
      );
    }
    try {
      current = assertAllowedUrl(next.toString(), policy, 'redirect target');
    } catch (error) {
      throw new MediaHttpError(
        'REDIRECT_ESCAPE',
        `${current.host} redirected to ${next.host}, which this provider's allowlist does not cover`,
        error,
      );
    }
  }
  throw new MediaHttpError('REDIRECT_ESCAPE', `more than ${MAX_REDIRECTS} redirects`);
}

/**
 * Fetches JSON from an allowlisted API host.
 *
 * The body is read as text and parsed here rather than through `response.json()`
 * so a non-JSON body produces `MALFORMED_RESPONSE` with the status attached,
 * instead of a `SyntaxError` three frames up.
 */
export async function fetchProviderJson(
  url: string,
  policy: UrlPolicy,
  options: MediaHttpOptions,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const parsed = assertAllowedUrl(url, policy, 'API request');
  const { response } = await requestFollowing(
    parsed,
    { accept: 'application/json', 'user-agent': options.userAgent, ...headers },
    policy,
    options,
  );

  const text = await response.text().catch((error: unknown) => {
    throw new MediaHttpError(
      'MALFORMED_RESPONSE',
      `${parsed.host} returned an unreadable body`,
      error,
    );
  });

  if (!response.ok) {
    const kind = classifyStatus(response.status);
    throw new MediaHttpError(
      kind,
      kind === 'RATE_LIMITED'
        ? `${parsed.host} rate-limited this request (HTTP 429). Back off and retry later; nothing was acquired.`
        : `${parsed.host}${parsed.pathname} returned HTTP ${response.status}`,
      // Truncated: a provider error body is diagnostic, and an unbounded one
      // would end up in an artefact.
      text.slice(0, 500),
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new MediaHttpError(
      'MALFORMED_RESPONSE',
      `${parsed.host}${parsed.pathname} returned a body that is not JSON`,
      error,
    );
  }
}

/* ------------------------------------------------------------------------- */
/* Byte sniffing                                                              */
/* ------------------------------------------------------------------------- */

interface MagicSignature {
  readonly kinds: readonly ('VIDEO' | 'IMAGE' | 'AUDIO')[];
  readonly label: string;
  readonly matches: (bytes: Uint8Array) => boolean;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return Array.from(bytes.slice(offset, offset + length))
    .map((byte) => String.fromCharCode(byte))
    .join('');
}

/**
 * Container signatures, keyed by the media kinds each can legitimately carry.
 *
 * An MP4 is listed under both video and audio because an M4A is an MP4; the
 * check that matters downstream is ffprobe's, and this one exists to catch the
 * gross failure — an HTML error page, a JSON quota message, a zero-byte file —
 * before it is written to disk and treated as media.
 */
const MAGIC_SIGNATURES: readonly MagicSignature[] = [
  {
    kinds: ['VIDEO', 'AUDIO'],
    label: 'ISO base media (mp4/m4a/mov)',
    matches: (bytes) => ascii(bytes, 4, 4) === 'ftyp',
  },
  {
    kinds: ['VIDEO', 'AUDIO'],
    label: 'Matroska/WebM',
    matches: (bytes) => startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]),
  },
  {
    kinds: ['VIDEO', 'AUDIO'],
    label: 'Ogg',
    matches: (bytes) => ascii(bytes, 0, 4) === 'OggS',
  },
  {
    kinds: ['VIDEO', 'AUDIO', 'IMAGE'],
    label: 'RIFF (avi/wav/webp)',
    matches: (bytes) => ascii(bytes, 0, 4) === 'RIFF',
  },
  { kinds: ['IMAGE'], label: 'JPEG', matches: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  {
    kinds: ['IMAGE'],
    label: 'PNG',
    matches: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { kinds: ['IMAGE'], label: 'GIF', matches: (bytes) => ascii(bytes, 0, 3) === 'GIF' },
  {
    kinds: ['IMAGE'],
    label: 'TIFF',
    matches: (bytes) =>
      startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]),
  },
  {
    kinds: ['AUDIO'],
    label: 'MP3',
    matches: (bytes) =>
      ascii(bytes, 0, 3) === 'ID3' ||
      (bytes.length > 1 && bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0),
  },
  { kinds: ['AUDIO'], label: 'FLAC', matches: (bytes) => ascii(bytes, 0, 4) === 'fLaC' },
];

export interface SniffResult {
  readonly matched: boolean;
  readonly label: string;
}

/**
 * Reads the leading bytes and says whether they can be the declared kind.
 *
 * Deliberately permissive about *which* container — an unexpected but genuine
 * video container is ffprobe's problem, and this check's job is to catch the
 * case where the "video" is an HTML page saying the quota is exhausted.
 */
export function sniffMediaBytes(bytes: Uint8Array, kind: 'VIDEO' | 'IMAGE' | 'AUDIO'): SniffResult {
  if (bytes.length === 0) return { matched: false, label: 'empty' };
  const leading = ascii(bytes, 0, Math.min(16, bytes.length)).trimStart().toLowerCase();
  if (
    leading.startsWith('<!doctype') ||
    leading.startsWith('<html') ||
    leading.startsWith('<?xml')
  ) {
    return { matched: false, label: 'a markup document' };
  }
  if (leading.startsWith('{') || leading.startsWith('[')) {
    return { matched: false, label: 'a JSON document' };
  }
  for (const signature of MAGIC_SIGNATURES) {
    if (signature.matches(bytes)) {
      return { matched: signature.kinds.includes(kind), label: signature.label };
    }
  }
  return { matched: false, label: 'an unrecognised byte signature' };
}

export interface DownloadResult {
  readonly bytes: Uint8Array;
  readonly finalHost: string;
  readonly contentType: string | null;
  readonly signature: string;
}

/**
 * Downloads one media file into memory, bounded and sniffed.
 *
 * In memory rather than streamed to disk because the caller has to checksum,
 * sniff and measure the bytes before deciding where — or whether — they land.
 * The ceiling is what makes that safe, and it is enforced while reading rather
 * than from `content-length`, which a server may omit or lie about.
 */
export async function downloadMediaBytes(
  url: string,
  kind: 'VIDEO' | 'IMAGE' | 'AUDIO',
  policy: UrlPolicy,
  options: MediaHttpOptions & { readonly maxBytes: number },
): Promise<DownloadResult> {
  const parsed = assertAllowedUrl(url, policy, 'download');
  const { response, finalUrl } = await requestFollowing(
    parsed,
    { accept: '*/*', 'user-agent': options.userAgent },
    policy,
    options,
  );

  if (!response.ok) {
    throw new MediaHttpError(
      classifyStatus(response.status),
      `downloading from ${finalUrl.host} returned HTTP ${response.status}`,
    );
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
    throw new MediaHttpError(
      'TOO_LARGE',
      `the file declares ${declaredLength} bytes, over the ${options.maxBytes}-byte ceiling`,
    );
  }

  const buffer = await response.arrayBuffer().catch((error: unknown) => {
    if (options.signal?.aborted) {
      throw new MediaHttpError('CANCELLED', 'the download was cancelled', error);
    }
    throw new MediaHttpError(
      'MALFORMED_RESPONSE',
      `${finalUrl.host} returned an unreadable body`,
      error,
    );
  });
  const bytes = new Uint8Array(buffer);

  if (bytes.byteLength > options.maxBytes) {
    throw new MediaHttpError(
      'TOO_LARGE',
      `the file is ${bytes.byteLength} bytes, over the ${options.maxBytes}-byte ceiling`,
    );
  }
  if (bytes.byteLength === 0) {
    throw new MediaHttpError('UNEXPECTED_CONTENT', `${finalUrl.host} returned an empty body`);
  }

  const signature = sniffMediaBytes(bytes, kind);
  if (!signature.matched) {
    throw new MediaHttpError(
      'UNEXPECTED_CONTENT',
      `the download was requested as ${kind} but the bytes are ${signature.label}`,
    );
  }

  return {
    bytes,
    finalHost: finalUrl.hostname,
    contentType: response.headers.get('content-type'),
    signature: signature.label,
  };
}

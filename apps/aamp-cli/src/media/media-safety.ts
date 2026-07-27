/**
 * The last check before a media-acquisition artefact is written.
 *
 * It mirrors `assertCaptureArtefactSafe`'s shape deliberately — same fail-closed
 * behaviour, same "report every violation, not the first" rule — but carries
 * its own lists, because the things an acquisition pipeline leaks are not the
 * things a browser leaks.
 *
 * What it exists to stop, specifically:
 *
 * - **API keys.** Pixabay and DVIDS take their key as a *query parameter*.
 *   Every request URL this system builds therefore contains a live credential,
 *   and the natural thing to record in provenance is "the URL we fetched".
 *   That would commit a working key to a file an operator would then attach to
 *   an email. The rule is that no artefact holds a URL with a query string at
 *   all — a host and a pathname is what provenance keeps.
 * - **Signed download URLs.** A provider's direct file URL is frequently
 *   time-limited and signed, which makes it a credential with an expiry rather
 *   than a link. Recording one would also let anybody replay a download we paid
 *   an approval for.
 * - **Local absolute paths.** The external pilot pack lives on somebody's
 *   Desktop. `C:\Users\<name>\Desktop\…` names a person and a machine, means
 *   nothing to anyone else, and belongs only in the run's private provenance —
 *   which is exactly why that one file is checked with `allowLocalPaths`.
 */

export class UnsafeMediaArtefactError extends Error {
  constructor(
    public readonly violations: readonly string[],
    where: string,
  ) {
    super(
      `${where} carries material that must never be persisted:\n  - ${violations.join('\n  - ')}`,
    );
    this.name = 'UnsafeMediaArtefactError';
  }
}

/**
 * Keys a media artefact must never contain, at any depth.
 *
 * `apiKey` and its spellings are obvious. `directDownloadUrl`, `downloadUrl`
 * and `signedUrl` are here because they are the fields somebody adds while
 * debugging a failed acquisition and then forgets to remove.
 */
export const MEDIA_FORBIDDEN_KEYS: readonly string[] = [
  'apiKey',
  'api_key',
  'apikey',
  'key',
  'secret',
  'secretKey',
  'password',
  'passphrase',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'authorisation',
  'bearer',
  'credentials',
  'cookie',
  'cookies',
  'setCookie',
  'headers',
  'requestHeaders',
  'responseHeaders',
  'directDownloadUrl',
  'direct_download_url',
  'downloadUrl',
  'download_url',
  'signedUrl',
  'presignedUrl',
  'renditionUrl',
];

const FORBIDDEN_VALUE_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern:
      /[?&](?:key|api_key|apikey|token|access_token|signature|sig|expires|policy)=[^&\s]{4,}/i,
    why: 'a credential in a query string',
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i, why: 'a bearer token' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, why: 'a JSON web token' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/, why: 'a secret API key' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'a private key' },
  { pattern: /postgres(?:ql)?:\/\//i, why: 'a PostgreSQL connection string' },
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, why: 'an email address' },
];

const LOCAL_PATH_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^[A-Za-z]:[\\/]/, why: 'a Windows absolute path' },
  { pattern: /^\/(?:home|Users|root|var|etc)\//, why: 'a POSIX absolute path' },
];

export interface MediaArtefactSafetyOptions {
  /**
   * Permits local absolute paths. True only for the run's private provenance
   * file, which exists precisely to hold them and is never shared.
   */
  readonly allowLocalPaths?: boolean;
}

/**
 * Walks the artefact and refuses anything that must not be persisted.
 *
 * Fails closed and reports every violation. A field added later cannot quietly
 * start carrying a key, because the check is over the serialised shape rather
 * than over a list of fields somebody remembered to review.
 */
export function assertMediaArtefactSafe(
  value: unknown,
  where = 'media artefact',
  options: MediaArtefactSafetyOptions = {},
): void {
  const violations: string[] = [];

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      for (const { pattern, why } of FORBIDDEN_VALUE_PATTERNS) {
        if (pattern.test(node)) violations.push(`${path || '<root>'} looks like ${why}`);
      }
      if (!options.allowLocalPaths) {
        for (const { pattern, why } of LOCAL_PATH_PATTERNS) {
          if (pattern.test(node)) {
            violations.push(
              `${path || '<root>'} is ${why}; local paths belong only in the run's private provenance`,
            );
          }
        }
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, member] of Object.entries(node as Record<string, unknown>)) {
      if (MEDIA_FORBIDDEN_KEYS.some((forbidden) => forbidden.toLowerCase() === key.toLowerCase())) {
        violations.push(`${path ? `${path}.` : ''}${key} is a forbidden field`);
        continue;
      }
      walk(member, path ? `${path}.${key}` : key);
    }
  };

  walk(value, '');
  if (violations.length > 0) throw new UnsafeMediaArtefactError(violations, where);
}

/**
 * A URL reduced to what an artefact may keep.
 *
 * The query is dropped rather than filtered, for the reason the capture
 * milestone settled on: a filter needs a list of the parameter names that carry
 * secrets, and that list is always one deployment behind. Here it would also be
 * wrong on day one — `key` is Pixabay's *entire* authentication.
 */
export function safeSourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '<unparsable>';
  }
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '<unparsable>';
  }
}

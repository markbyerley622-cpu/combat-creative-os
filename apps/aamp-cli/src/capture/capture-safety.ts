/**
 * The last check before a capture artefact is written.
 *
 * Everything this module rejects is something a screenshot pipeline can
 * plausibly pick up by accident: an email address read out of a profile chip,
 * a bearer token that arrived in a redirect URL, a `Set-Cookie` header copied
 * into a debug field, a session id in a query string. None of it is needed to
 * describe a capture, so none of it may survive one.
 *
 * The walker mirrors `assertRunProvenanceSafe`'s shape deliberately — same
 * fail-closed behaviour, same "report every violation, not the first" rule —
 * but carries its own lists, because the things a browser leaks are not the
 * things a render leaks.
 */

export class UnsafeCaptureArtefactError extends Error {
  constructor(
    public readonly violations: readonly string[],
    where: string,
  ) {
    super(
      `${where} carries material that must never be persisted:\n  - ${violations.join('\n  - ')}`,
    );
    this.name = 'UnsafeCaptureArtefactError';
  }
}

/**
 * Keys a capture artefact must never contain, at any depth.
 *
 * `html`, `outerHTML` and `textContent` are here for the same reason the
 * credential entries are: a raw DOM dump is the one artefact this milestone
 * refuses to produce, and the cheapest way for one to appear is a debugging
 * field that nobody removed.
 */
export const CAPTURE_FORBIDDEN_KEYS: readonly string[] = [
  'cookie',
  'cookies',
  'setCookie',
  'set-cookie',
  'authorization',
  'authorisation',
  'bearer',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionId',
  'sessionToken',
  'apiKey',
  'api_key',
  'password',
  'passphrase',
  'secret',
  'secretKey',
  'credentials',
  'localStorage',
  'sessionStorage',
  'requestHeaders',
  'responseHeaders',
  'headers',
  'html',
  'outerHTML',
  'innerHTML',
  'textContent',
  'domSnapshot',
  'pageText',
  'commentText',
  'userName',
  'userEmail',
  'accountName',
  'emailAddress',
];

/**
 * Value shapes that betray a leak regardless of the key they sit under.
 *
 * The email pattern is deliberately broad and the token patterns deliberately
 * length-bounded: a false positive costs one renamed field, and a false
 * negative costs a published advertisement containing somebody's address.
 */
const FORBIDDEN_VALUE_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, why: 'an email address' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i, why: 'a bearer token' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, why: 'a JSON web token' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/, why: 'a secret API key' },
  {
    pattern: /[?&](?:token|access_token|session|sessionid|sid|auth|key|signature|sig)=[^&\s]{8,}/i,
    why: 'a credential in a query string',
  },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'a private key' },
  {
    pattern: /\b(?:JSESSIONID|PHPSESSID|connect\.sid|__Secure-|__Host-)/,
    why: 'a session cookie name',
  },
  { pattern: /postgres(?:ql)?:\/\//i, why: 'a PostgreSQL connection string' },
];

/**
 * Walks the artefact and refuses anything that must not be persisted.
 *
 * Fails closed. A field added later cannot quietly start carrying a token,
 * because the check is over the serialised shape rather than over a list of
 * fields somebody remembered to review.
 */
export function assertCaptureArtefactSafe(value: unknown, where = 'capture artefact'): void {
  const violations: string[] = [];

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      for (const { pattern, why } of FORBIDDEN_VALUE_PATTERNS) {
        if (pattern.test(node)) violations.push(`${path || '<root>'} looks like ${why}`);
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, member] of Object.entries(node as Record<string, unknown>)) {
      if (
        CAPTURE_FORBIDDEN_KEYS.some((forbidden) => forbidden.toLowerCase() === key.toLowerCase())
      ) {
        violations.push(`${path ? `${path}.` : ''}${key} is a forbidden field`);
        continue;
      }
      walk(member, path ? `${path}.${key}` : key);
    }
  };

  walk(value, '');
  if (violations.length > 0) throw new UnsafeCaptureArtefactError(violations, where);
}

/**
 * A URL reduced to what a report may keep.
 *
 * The query is dropped rather than filtered. A filter needs a list of the
 * parameter names that carry secrets, and that list is always one deployment
 * behind whatever a site actually does; `queryPresent` records that there was
 * one without recording what it said.
 */
export function safeUrlParts(url: string): {
  readonly host: string;
  readonly path: string;
  readonly queryPresent: boolean;
} {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname.toLowerCase(),
      path: parsed.pathname,
      queryPresent: parsed.search.length > 0,
    };
  } catch {
    return { host: '<unparsable>', path: '<unparsable>', queryPresent: false };
  }
}

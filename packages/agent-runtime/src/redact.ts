/**
 * Strips secrets and sensitive provider data from anything about to be
 * logged or persisted (requirement 15). Applied to model requests/responses,
 * env-derived config, and error `details` payloads before they ever reach a
 * logger — see `execute-agent.ts`.
 */
// `token(?!s)` deliberately excludes plural/compound telemetry fields like
// `tokensIn`/`tokensOut`/`maxOutputTokens`, which are legitimate, non-secret
// usage counters this system logs on every agent run.
const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|secret|password|authorization|bearer|credential|cookie|token(?!s))/i;

const REDACTED = '[REDACTED]';

export function redact<T>(value: T, maxDepth = 8): T {
  return redactInner(value, maxDepth) as T;
}

function redactInner(value: unknown, depth: number): unknown {
  if (depth <= 0) return '[REDACTED_MAX_DEPTH]';
  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, depth - 1));
  }
  if (value instanceof Date || value === null || typeof value !== 'object') {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof val === 'string' && looksLikeSecretValue(val)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactInner(val, depth - 1);
  }
  return out;
}

/** Catches obvious API-key-shaped strings even when the field name is innocuous. */
function looksLikeSecretValue(value: string): boolean {
  return /^sk-ant-[a-z0-9-]+$/i.test(value) || /^sk-[A-Za-z0-9]{16,}$/.test(value);
}

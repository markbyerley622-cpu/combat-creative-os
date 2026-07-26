/**
 * A deterministic JSON serialisation, for hashing.
 *
 * Object keys are emitted in sorted order and `undefined` members are dropped,
 * so two structurally-equal values always produce the same string regardless of
 * how they were built. That is what makes a query hash, a context hash and a
 * benchmark-profile checksum comparable across runs and across processes.
 *
 * `@combat/agent-runtime` has its own `stableStringify` for the same reason.
 * This one is not a re-export of it: `packages/domain` may not depend on
 * `agent-runtime` (the dependency runs the other way), and a shared helper
 * package for eleven lines would cost more than it saves. The two are kept
 * behaviourally identical by `canonical-json.test.ts`, which pins the exact
 * output shape.
 *
 * The hashing itself deliberately lives elsewhere: `packages/domain` has no
 * Node dependency, and `node:crypto` in here would give it one.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
    .join(',')}}`;
}

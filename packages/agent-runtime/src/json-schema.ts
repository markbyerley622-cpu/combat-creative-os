import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';

/**
 * Converts a Zod schema into a JSON Schema that satisfies Claude's strict
 * tool-use constraints (requirement 3 — "Use Claude Structured Outputs or
 * strict tool schemas"): every object gets `additionalProperties: false`,
 * and constraint keywords Claude's strict mode doesn't support
 * (`minLength`/`maxLength`/`minimum`/`maximum`/`multipleOf`/exclusive
 * variants) are stripped — Zod still enforces them client-side once the
 * harness parses the response, so nothing is lost, only the parts the model
 * itself can't be made to guarantee.
 */
// Cast to a plain, non-generic function type before calling: `zodToJsonSchema`
// is generic over the exact schema type it's given, and some of this
// package's callers pass a `ZodObject` built from a generic `TResult`
// (see execute-agent.ts's envelope schema) — inferring through that at the
// real (generic) call signature blows TS's instantiation-depth limit
// (TS2589) even though the runtime behavior is unaffected either way.
const zodToJsonSchemaUntyped = zodToJsonSchema as (schema: unknown, options?: unknown) => unknown;

export function toStrictJsonSchema(schema: ZodType, title: string): Record<string, unknown> {
  // Deliberately not passing `name` to zodToJsonSchema: doing so wraps the
  // output as `{ $ref, definitions: { [name]: ... } }` instead of inlining
  // the schema at the top level, which every caller here expects.
  const converted = zodToJsonSchemaUntyped(schema, { $refStrategy: 'none', target: 'jsonSchema7' });
  const sanitized = sanitize(converted) as Record<string, unknown>;
  return { ...sanitized, title };
}

const UNSUPPORTED_KEYWORDS = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitize);
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const input = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key] = sanitize(value);
  }
  if (out['type'] === 'object' && !('additionalProperties' in out)) {
    out['additionalProperties'] = false;
  }
  return out;
}

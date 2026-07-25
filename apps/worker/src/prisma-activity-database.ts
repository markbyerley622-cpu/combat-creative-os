import type { PrismaClient } from '@combat/database';
import type { WorkerActivityDatabase } from '@combat/workflows';

/**
 * Adapts a real `PrismaClient` to the narrow `*DataSource` interfaces
 * `packages/database`'s repository layer is written against.
 *
 * The gap is entirely null-vs-undefined: Prisma's generated types return
 * `null` for a nullable column, while the repository record types declare
 * those fields optional (`comments?: string`, i.e. `string | undefined`), and
 * `null` is not structurally assignable to `undefined`. `apps/api` bridges the
 * same gap with one hand-written adapter per model (see
 * `apps/api/src/approval-database.ts`). The Worker touches nearly every model
 * in the schema, so hand-writing ~25 more adapters would add a large surface
 * that drifts silently from the schema and cannot be exercised without a live
 * Postgres. This does the same conversion structurally instead.
 *
 * Deliberately **shallow**: only a returned row's own top-level properties are
 * converted. That is exactly where Prisma's nullable scalar columns live, and
 * no repository in this codebase issues a Prisma `include:` (verified by
 * grep — every `*DataSource` uses flat model delegates), so there are no
 * nested relation rows to reach. Staying shallow also means a JSON column's
 * *contents* are never rewritten: a stored `{"seed": null}` keeps its `null`,
 * which a recursive conversion would silently corrupt.
 *
 * The single cast at the end is the boundary this file exists to own. The
 * proxy answers any model/method a `*DataSource` asks for by delegating to
 * Prisma, so its runtime shape is Prisma's own — but a Proxy cannot carry
 * Prisma's generated per-model types through, so the intersection type is
 * asserted here once rather than being re-asserted at ~25 call sites.
 */
type DelegateMethod = (args?: unknown) => Promise<unknown>;
type Delegate = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  // Dates, Decimals and Buffers are values, not rows — never rewrite them.
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** Replaces a row's top-level `null` property values with `undefined`. Non-row results pass through untouched. */
export function nullsToUndefined(result: unknown): unknown {
  if (Array.isArray(result)) return result.map(nullsToUndefined);
  if (!isPlainObject(result)) return result;

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    normalized[key] = value === null ? undefined : value;
  }
  return normalized;
}

function wrapDelegate(delegate: Delegate): Delegate {
  const cache = new Map<string, unknown>();
  return new Proxy(delegate, {
    get(target, property): unknown {
      if (typeof property !== 'string') {
        return Reflect.get(target, property) as unknown;
      }
      if (cache.has(property)) return cache.get(property);

      const member = Reflect.get(target, property) as unknown;
      if (typeof member !== 'function') return member;

      const method = member.bind(target) as DelegateMethod;
      const wrapped = async (args?: unknown): Promise<unknown> =>
        nullsToUndefined(await method(args));
      cache.set(property, wrapped);
      return wrapped;
    },
  });
}

export function createPrismaActivityDatabase(prisma: PrismaClient): WorkerActivityDatabase {
  const cache = new Map<string, unknown>();
  const proxy = new Proxy(prisma as unknown as Delegate, {
    get(target, property): unknown {
      if (typeof property !== 'string') {
        return Reflect.get(target, property) as unknown;
      }
      if (cache.has(property)) return cache.get(property);

      const member = Reflect.get(target, property) as unknown;
      // `$transaction`, `$connect`, symbols and anything else non-model is
      // passed straight through; only model delegates carry rows.
      if (!isPlainObject(member) && typeof member !== 'object') return member;
      if (member === null || property.startsWith('$')) return member;

      const wrapped = wrapDelegate(member as Delegate);
      cache.set(property, wrapped);
      return wrapped;
    },
  });

  return proxy as unknown as WorkerActivityDatabase;
}

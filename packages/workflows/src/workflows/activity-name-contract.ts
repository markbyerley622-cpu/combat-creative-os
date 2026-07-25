/**
 * The compile-time bridge that lets a runtime list of Activity names be
 * *derived from* — rather than merely parallel to — an Activity contract
 * interface.
 *
 * Post-M14 audit finding C-1. Every executable workflow declares the
 * Activities it proxies as a type-only interface, which is erased at runtime,
 * so nothing could enumerate "what must the Worker register" without a second,
 * hand-maintained list free to drift. Each contract file now exports a
 * `readonly [...]` of its own member names, constrained two ways: `satisfies
 * readonly (keyof Contract)[]` rejects a name the interface does not declare,
 * and `AssertNamesCoverContract` below rejects an interface member the tuple
 * omits. Adding a member to a contract without adding its name is therefore a
 * type error in the contract file itself, before any test runs.
 *
 * Types only, no runtime code: importing this from a workflow contract cannot
 * pull anything into the Temporal workflow sandbox.
 */

/** `true` only when `A` and `B` are the same type — the invariance trick, not mutual assignability (which a subset could satisfy). */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Fails to compile unless `T` is exactly `true` — the constraint *is* the
 * assertion. Applied at each concrete contract (never behind another generic
 * alias, where `Equal` would stay unresolved as `boolean` and the check would
 * silently pass).
 */
export type Expect<T extends true> = T;

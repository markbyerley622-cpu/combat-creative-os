export * as activities from './activities';
export * as workflows from './workflows';
// The Worker-side composition root: the real registration object apps/worker
// passes to `Worker.create({ activities })`, plus the canonical list of names
// it must cover. Deliberately a named export rather than part of the
// `activities` namespace — that namespace holds `create*Activity(deps)`
// factories, and conflating the two is exactly what audit finding C-1 caught.
export * from './worker';

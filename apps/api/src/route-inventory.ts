/**
 * Derives the set of mutating routes Fastify actually registered, by parsing
 * its own router dump.
 *
 * Post-M14 audit finding C-3. The M14 conformance check asserted only that
 * each audited path's *last URL segment* appeared somewhere in the router
 * dump, plus a hardcoded `expect(paths.length).toBe(18)`. That is satisfied by
 * a route registered at the wrong path, under the wrong method, or on a
 * different resource entirely — and says nothing at all about the direction
 * that matters most: a real mutating endpoint that was never added to
 * `MUTATING_ROUTES` and therefore ships unaudited. The router is the authority
 * here, so this reads the router.
 *
 * `printRoutes` emits a radix tree whose node labels concatenate, along the
 * path from the root, into the full registered URL:
 *
 *     └── /workspaces/:workspaceId/campaigns (POST, GET, HEAD)
 *         ├── /:campaignId/approvals/concept (POST)
 *         │   └── /state (GET, HEAD)
 *
 * so `/workspaces/:workspaceId/campaigns` + `/:campaignId/approvals/concept`
 * is one registered route and `… /state` is another. Prefix compression may
 * split a label anywhere, which is why this concatenates rather than trying to
 * interpret any single label as a path.
 */

/** Reading a route is never a mutation; `OPTIONS` is the CORS plugin's wildcard preflight, not an endpoint. */
const NON_MUTATING_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Each `printRoutes` indentation level is exactly four columns wide (`│   `, `    `, `├── `, `└── `). */
const INDENT_WIDTH = 4;

/** Fastify's placeholder label for a radix root that carries no path characters of its own. */
const EMPTY_ROOT_LABEL = '(empty root node)';

export interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
}

/** Stable `METHOD path`, for set comparison and readable failure output. */
export function routeKey(route: RegisteredRoute): string {
  return `${route.method} ${route.path}`;
}

interface ParsedNode {
  readonly depth: number;
  readonly label: string;
  readonly methods: readonly string[];
}

function parseNode(line: string): ParsedNode | null {
  const markerIndex = Math.min(
    ...['├── ', '└── '].map((marker) => {
      const index = line.indexOf(marker);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    }),
  );
  if (!Number.isFinite(markerIndex)) return null;

  const body = line.slice(markerIndex + INDENT_WIDTH).trimEnd();
  const depth = markerIndex / INDENT_WIDTH;
  if (body === EMPTY_ROOT_LABEL) {
    return { depth, label: '', methods: [] };
  }

  const methodsMatch = /^(.*) \(([^()]*)\)$/.exec(body);
  if (!methodsMatch) {
    // A structural node with no handlers of its own — contributes its label to
    // its children's paths but is not itself a route.
    return { depth, label: body, methods: [] };
  }
  return {
    depth,
    label: methodsMatch[1]!,
    methods: methodsMatch[2]!.split(',').map((method) => method.trim()),
  };
}

/** Every `(method, path)` pair in a `printRoutes` dump, with full paths reassembled. */
export function parseRouteTree(tree: string): RegisteredRoute[] {
  const prefixByDepth: string[] = [];
  const routes: RegisteredRoute[] = [];

  for (const line of tree.split('\n')) {
    const node = parseNode(line);
    if (!node) continue;

    const parentPrefix = node.depth === 0 ? '' : (prefixByDepth[node.depth - 1] ?? '');
    const path = `${parentPrefix}${node.label}`;
    prefixByDepth[node.depth] = path;
    prefixByDepth.length = node.depth + 1;

    for (const method of node.methods) {
      routes.push({ method, path });
    }
  }

  return routes;
}

/** The mutating subset of what Fastify registered. `app` must already be `await app.ready()`. */
export function listRegisteredMutatingRoutes(app: {
  printRoutes(options: { includeHooks: boolean }): string;
}): RegisteredRoute[] {
  return parseRouteTree(app.printRoutes({ includeHooks: false })).filter(
    (route) => !NON_MUTATING_METHODS.has(route.method) && route.path !== '*',
  );
}

export interface RouteSetDiff {
  /** Registered and mutating, but absent from the audit registry — an endpoint shipping unaudited. */
  readonly unaudited: string[];
  /** In the audit registry, but not registered under that exact method and path — a stale or mistyped entry. */
  readonly unregistered: string[];
}

/** Exact set comparison in both directions, keyed on `METHOD path` so a wrong method is as visible as a wrong path. */
export function diffRouteSets(
  registered: readonly RegisteredRoute[],
  audited: readonly RegisteredRoute[],
): RouteSetDiff {
  const registeredKeys = new Set(registered.map(routeKey));
  const auditedKeys = new Set(audited.map(routeKey));

  return {
    unaudited: [...registeredKeys].filter((key) => !auditedKeys.has(key)).sort(),
    unregistered: [...auditedKeys].filter((key) => !registeredKeys.has(key)).sort(),
  };
}

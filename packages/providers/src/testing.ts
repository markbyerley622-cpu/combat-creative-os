/**
 * Test-only entry point, reachable at `@combat/providers/testing`.
 *
 * The same rule `@combat/auth/testing` follows, for the same reason: a fake is
 * reachable only by a deliberate code import, and never through the package's
 * main entry point where a production build could pick it up. No environment
 * variable selects anything here, and nothing exported from `index.ts` reaches
 * it.
 *
 * The ComfyUI fake server is deliberately absent — it is imported by path from
 * that module's own protocol tests and has no consumer outside this package.
 * The media-acquisition fake is here because `aamp-cli`'s acceptance suite has
 * to drive the real adapters against it across a package boundary.
 */
export * from './media-acquisition/testing/fake-media-api';

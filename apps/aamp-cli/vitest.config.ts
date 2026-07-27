import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * Well above vitest's 5 s default.
     *
     * The acceptance suites that drive real FFmpeg carry their own explicit,
     * much longer timeouts. The offline ones — the controlled benchmark above
     * all — inherited the default, and the default is not a statement about
     * how long they take: the whole benchmark acceptance file runs in about
     * 2.4 s in isolation.
     *
     * It is a statement about how long they are *allowed to wait*. `pnpm test`
     * runs every package concurrently, and `@combat/media` and this package
     * spawn real encodes and actual-media QA probes throughout, so an offline
     * test that needs 150 ms of its own CPU has been measured taking over five
     * seconds of wall clock waiting for a core. That is the mechanism behind
     * the intermittent aamp-cli failure this milestone finally reproduced.
     *
     * A scheduling allowance with a measured cause — not a retry, not a
     * weakened assertion, and not a mask over a slow test. A genuine hang
     * still fails, thirty seconds later.
     */
    testTimeout: 30_000,
  },
});

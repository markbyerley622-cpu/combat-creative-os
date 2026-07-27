import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * Well above vitest's 5 s default, and deliberately so.
     *
     * These tests are not slow: the whole motion-graphics file runs in ~640 ms
     * in isolation. But `pnpm test` runs every package concurrently, and the
     * `@combat/media` and `aamp-cli` suites spawn real FFmpeg encodes and
     * actual-media QA probes throughout. On a saturated machine an individual
     * fake-toolchain render here has been measured taking 7 s of wall clock
     * while using almost none of its own CPU — it is waiting for a core.
     *
     * The 5 s default was calibrated against a lighter QA pass, before the
     * preview milestone added a frame walk, a safe-area crop and an audio
     * decode to every render. Raising it is a scheduling allowance with a
     * measured cause, not a mask over a slow or flaky test: a genuine hang
     * still fails, thirty seconds later.
     */
    testTimeout: 30_000,
  },
});

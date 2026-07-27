import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * Well above vitest's 5 s default, for the fake-toolchain render tests.
     *
     * The live FFmpeg tests carry their own explicit, much longer timeouts.
     * The offline ones inherited the default, which was calibrated against a
     * lighter actual-media QA pass — before this milestone added a nine-sample
     * black/freeze walk, a safe-area crop, a CTA-hold sample and an audio
     * decode to every render. Each is a subprocess round-trip through the
     * fake plus a real file write and read.
     *
     * In isolation the whole renderer file still runs in about five seconds.
     * Under `pnpm test`, every package's suite runs concurrently and the live
     * encodes elsewhere in this package saturate the machine, so an individual
     * offline render has been measured taking several seconds of wall clock
     * while using almost none of its own CPU.
     *
     * This is a scheduling allowance with a measured cause, not a mask over a
     * slow or flaky test: a genuine hang still fails, thirty seconds later.
     */
    testTimeout: 30_000,
  },
});

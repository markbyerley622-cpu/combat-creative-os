#!/usr/bin/env node
import { runBenchmarkCli } from './benchmark-cli';

/**
 * Process entry point for `pnpm aamp:benchmark`.
 *
 * Separate from `benchmark-cli.ts` for the same reason the doctor's is: this is
 * the only file through which a real PrismaClient and a real reasoning provider
 * can reach the benchmark, and no test imports it.
 */
if (require.main === module) {
  runBenchmarkCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    operator: process.env.USERNAME ?? process.env.USER ?? 'unknown-operator',
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}

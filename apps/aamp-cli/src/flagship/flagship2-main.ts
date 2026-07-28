#!/usr/bin/env node
import { runFlagship2Cli } from './flagship2-cli';

/**
 * `pnpm aamp:flagship2` entry point.
 *
 * Thin on purpose: the whole command is a function taking its environment as
 * arguments, so tests execute the real entry point rather than a rehearsal of
 * it — the same shape `flagship-main.ts` uses.
 */
if (require.main === module) {
  runFlagship2Cli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}

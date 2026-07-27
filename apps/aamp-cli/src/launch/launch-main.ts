#!/usr/bin/env node
import { runLaunchCli } from './launch-cli';

/**
 * `pnpm aamp:launch` entry point.
 *
 * Thin on purpose: the whole command is a function taking its environment as
 * arguments, so tests execute the real entry point rather than a rehearsal of
 * it — the same shape `doctor-main.ts` and `benchmark-main.ts` use.
 */
if (require.main === module) {
  runLaunchCli(process.argv.slice(2), {
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

#!/usr/bin/env node
import { runProductMotionCli } from './product-motion-cli';

/**
 * The entry point, and nothing else.
 *
 * `runProductMotionCli` takes its environment as arguments so a test can drive
 * the real code path rather than a re-implementation of it; only this block
 * touches process globals.
 */
runProductMotionCli(process.argv.slice(2), {
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
    process.exitCode = 1;
  });

#!/usr/bin/env node
import { runCaptureCli } from './capture-cli';

/**
 * Process entry point for `pnpm aamp:capture-app`.
 *
 * Kept separate from `capture-cli.ts` for the same reason `doctor-main.ts` is
 * kept separate from `doctor-cli.ts`: this is the only file that lets a real
 * Chromium be launched, and no test imports it. The command's own logic stays
 * testable against an injected launcher.
 */
if (require.main === module) {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);

  runCaptureCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    signal: controller.signal,
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}

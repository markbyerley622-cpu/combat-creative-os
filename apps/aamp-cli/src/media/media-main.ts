#!/usr/bin/env node
import { runMediaCli } from './media-cli';

/**
 * Process entry point for `pnpm aamp:media`.
 *
 * Kept separate from `media-cli.ts` for the reason `capture-main.ts` and
 * `doctor-main.ts` are: this is the only file that lets real provider adapters
 * be constructed against real hosts, and no test imports it. The commands' own
 * logic stays testable against injected adapters pointed at a fixture server.
 */
if (require.main === module) {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);

  runMediaCli(process.argv.slice(2), {
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

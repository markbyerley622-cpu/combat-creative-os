#!/usr/bin/env node
import { FFMPEG_PATH_ENV_VAR, FFPROBE_PATH_ENV_VAR } from '@combat/media';

import { runMotionReviewCli } from './motion-review-cli';

/**
 * `pnpm aamp:motion-review` entry point.
 *
 * Thin on purpose: the whole command is a function taking its environment as
 * arguments, so tests execute the real entry point rather than a rehearsal of
 * it — the same shape every other command in this repository uses.
 *
 * The environment it hands in is **two variables**, both of them executable
 * locations. The whole process environment is not passed through, so a
 * credential this command must never read is not merely unread: it is not in
 * the object the command can see. The `aamp:motion-review` script also omits
 * `--env-file`, so `.env` is never loaded into the process to begin with.
 */
const reviewEnvironment: Record<string, string | undefined> = {
  [FFMPEG_PATH_ENV_VAR]: process.env[FFMPEG_PATH_ENV_VAR],
  [FFPROBE_PATH_ENV_VAR]: process.env[FFPROBE_PATH_ENV_VAR],
};

if (require.main === module) {
  runMotionReviewCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: reviewEnvironment,
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

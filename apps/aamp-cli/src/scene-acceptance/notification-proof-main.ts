#!/usr/bin/env node
import { FFMPEG_PATH_ENV_VAR, FFPROBE_PATH_ENV_VAR } from '@combat/media';

import { runNotificationProofCli } from './notification-proof-cli';

/**
 * `pnpm aamp:notification-proof` entry point.
 *
 * The environment handed in is exactly two variables: the FFmpeg locations.
 * There is no credential here, not because this command promises not to use one
 * but because it has none to use — the object it can see does not contain the
 * LTX key, and nothing on this path constructs a provider that could want it.
 */
const commandEnvironment: NodeJS.ProcessEnv = {
  [FFMPEG_PATH_ENV_VAR]: process.env[FFMPEG_PATH_ENV_VAR],
  [FFPROBE_PATH_ENV_VAR]: process.env[FFPROBE_PATH_ENV_VAR],
};

if (require.main === module) {
  runNotificationProofCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: commandEnvironment,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}

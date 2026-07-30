#!/usr/bin/env node
import { FFMPEG_PATH_ENV_VAR, FFPROBE_PATH_ENV_VAR } from '@combat/media';

import { runSceneAcceptanceCli } from './scene-acceptance-cli';

/**
 * `pnpm aamp:ltx-scene-01` entry point.
 *
 * The environment handed in is exactly four variables: the two FFmpeg
 * locations, the LTX credential and an optional base URL. The whole process
 * environment is not passed through, so every other secret this command must
 * never read is not merely unread — it is absent from the object the command
 * can see.
 *
 * The credential is read here and travels no further than the provider that
 * needs it. It is never written to an artefact, never logged, never returned
 * and never printed; `assertStoryboardVideoArtefactSafe` walks every artefact
 * before it reaches disk and fails closed on credential-shaped values.
 */
const commandEnvironment: NodeJS.ProcessEnv = {
  [FFMPEG_PATH_ENV_VAR]: process.env[FFMPEG_PATH_ENV_VAR],
  [FFPROBE_PATH_ENV_VAR]: process.env[FFPROBE_PATH_ENV_VAR],
  LTXV_API_KEY: process.env.LTXV_API_KEY,
  LTX_BASE_URL: process.env.LTX_BASE_URL,
};

if (require.main === module) {
  runSceneAcceptanceCli({
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

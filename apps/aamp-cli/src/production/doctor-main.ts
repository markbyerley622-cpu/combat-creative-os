#!/usr/bin/env node
import { runDoctorCli } from './doctor-cli';

/**
 * Process entry point for `pnpm aamp:doctor`.
 *
 * Kept separate from `doctor-cli.ts` for the same reason `reference-cli-main.ts`
 * is kept separate: this is the only file that lets the doctor open a real
 * PrismaClient (it does so through `runDoctor`'s default opener), and no test
 * imports it. The command's own logic stays testable against injected
 * collaborators.
 */
if (require.main === module) {
  runDoctorCli(process.argv.slice(2), {
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

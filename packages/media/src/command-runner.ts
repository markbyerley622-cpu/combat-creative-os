import { execFile } from 'node:child_process';

/**
 * The only place this package shells out. `run` takes the command and its
 * arguments as a separate array (never a single interpolated string) and
 * uses `execFile` (never `exec`) — `execFile` invokes the binary directly
 * without a shell, so there is no shell-metacharacter/injection surface to
 * escape in the first place, satisfying CLAUDE.md's "no unescaped string
 * concatenation" rule structurally rather than by convention.
 */
export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export class NodeCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args as string[],
        { maxBuffer: MAX_OUTPUT_BYTES },
        (error, stdout, stderr) => {
          if (error) {
            // A numeric `code` means the process ran and exited non-zero —
            // that's a normal CommandResult, not a runner-level failure
            // (e.g. ffprobe legitimately exits 1 on unreadable input).
            // Anything else (no code, or a string code like ENOENT) means
            // the binary itself could not be spawned at all.
            if (typeof error.code === 'number') {
              resolve({ stdout, stderr, exitCode: error.code });
              return;
            }
            reject(error);
            return;
          }
          resolve({ stdout, stderr, exitCode: 0 });
        },
      );
    });
  }
}

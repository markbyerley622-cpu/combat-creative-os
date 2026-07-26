import { spawn } from 'node:child_process';

/**
 * The only place this package shells out. `run` takes the command and its
 * arguments as a separate array (never a single interpolated string) and
 * uses `spawn` without a shell, so there is no shell-metacharacter/injection
 * surface to escape in the first place, satisfying CLAUDE.md's "no unescaped
 * string concatenation" rule structurally rather than by convention.
 *
 * `spawn` (rather than `execFile`) is what makes the three properties a real
 * render needs available: an FFmpeg run can be given a hard timeout, can be
 * cancelled from an `AbortSignal` mid-encode, and has its stderr bounded to a
 * diagnostic tail instead of buffering an unbounded progress log.
 */
export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /**
   * True when stderr exceeded `maxStderrBytes` and only the trailing bytes
   * were kept. Optional so a test fake can supply a two-line canned result
   * without restating it; `NodeCommandRunner` always sets it.
   */
  readonly stderrTruncated?: boolean;
}

export interface CommandOptions {
  /** Hard wall-clock limit. The child is killed and `CommandTimeoutError` is thrown. */
  readonly timeoutMs?: number;
  /** Aborting kills the child and throws `CommandCancelledError`. */
  readonly signal?: AbortSignal;
  /**
   * Working directory for the child. Render invocations set this to the job's
   * temporary directory so filter-graph file references (ASS caption files,
   * fonts) can be bare filenames — FFmpeg's filter syntax treats `:` as an
   * option separator, which makes a Windows `C:\...` path in a filter
   * argument an escaping problem with no portable answer.
   */
  readonly cwd?: string;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
/** FFmpeg writes a per-frame progress log to stderr; only the tail carries the error. */
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;

export class CommandTimeoutError extends Error {
  constructor(
    public readonly command: string,
    public readonly timeoutMs: number,
    public readonly stderrTail: string,
  ) {
    super(`"${command}" exceeded its ${timeoutMs}ms timeout and was terminated`);
    this.name = 'CommandTimeoutError';
  }
}

export class CommandCancelledError extends Error {
  constructor(
    public readonly command: string,
    public readonly stderrTail: string,
  ) {
    super(`"${command}" was cancelled`);
    this.name = 'CommandCancelledError';
  }
}

export class CommandOutputTooLargeError extends Error {
  constructor(
    public readonly command: string,
    public readonly maxBytes: number,
  ) {
    super(`"${command}" produced more than ${maxBytes} bytes on stdout`);
    this.name = 'CommandOutputTooLargeError';
  }
}

/**
 * Keeps the last `maxBytes` of a stream. The tail rather than the head
 * because a failing FFmpeg run's diagnosis is always its final lines.
 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private total = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (!first) break;
      const overflow = this.total - this.maxBytes;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.total -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.total -= overflow;
      }
      this.truncated = true;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export class NodeCommandRunner implements CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

    return new Promise<CommandResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new CommandCancelledError(command, ''));
        return;
      }

      const child = spawn(command, args as string[], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
      });

      const stderrTail = new TailBuffer(maxStderrBytes);
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill();
        reject(error);
      };

      function onAbort(): void {
        fail(new CommandCancelledError(command, stderrTail.toString()));
      }

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          fail(
            new CommandTimeoutError(command, options.timeoutMs as number, stderrTail.toString()),
          );
        }, options.timeoutMs);
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          fail(new CommandOutputTooLargeError(command, maxStdoutBytes));
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr?.on('data', (chunk: Buffer) => stderrTail.push(chunk));

      // Spawn failure (ENOENT for a missing binary, EACCES for a
      // non-executable one) is a runner-level failure, distinct from a
      // process that ran and exited non-zero — ffprobe legitimately exits 1
      // on unreadable input, and that is a normal CommandResult.
      child.on('error', (error) => fail(error));

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: stderrTail.toString(),
          stderrTruncated: stderrTail.truncated,
          // A process killed by a signal reports `code === null`; surface it
          // as a non-zero exit so callers never read it as success.
          exitCode: code ?? (signal ? 1 : 0),
        });
      });
    });
  }
}

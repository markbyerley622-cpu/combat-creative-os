import type { CommandOptions, CommandResult, CommandRunner } from '../command-runner';

export interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: CommandOptions | undefined;
}

type Responder = (call: RecordedCall) => CommandResult | Promise<CommandResult>;

/**
 * Deterministic fake keyed by command name — one canned `CommandResult` per
 * command (`ffprobe`/`ffmpeg`), reused across every call to that command in
 * a test unless overridden. Records every call's exact args array (and the
 * options it was given) so tests can assert on it directly: this is what the
 * "argument safety" tests check — that file paths and flags are passed as
 * distinct array elements, never concatenated into one interpolated string —
 * and what the render tests use to assert the constructed filter graph
 * without running FFmpeg.
 */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  private readonly results = new Map<string, CommandResult>();
  private readonly responders = new Map<string, Responder>();

  setResult(command: string, result: CommandResult): void {
    this.results.set(command, result);
  }

  /**
   * Per-call control for tests that need a command to answer differently on
   * successive invocations (a render's probe-then-encode-then-probe
   * sequence, or an idempotent-retry test that must prove the second attempt
   * short-circuits).
   */
  setResponder(command: string, responder: Responder): void {
    this.responders.set(command, responder);
  }

  callsTo(command: string): readonly RecordedCall[] {
    return this.calls.filter((call) => call.command === command);
  }

  async run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    const call: RecordedCall = { command, args, options };
    this.calls.push(call);

    const responder = this.responders.get(command);
    if (responder) return responder(call);

    const result = this.results.get(command);
    if (!result) {
      throw new Error(`FakeCommandRunner: no canned result registered for command "${command}"`);
    }
    return result;
  }
}

/** Convenience for the common "this command succeeded with no output" case. */
export function okResult(stdout = ''): CommandResult {
  return { stdout, stderr: '', exitCode: 0, stderrTruncated: false };
}

export function failedResult(stderr: string, exitCode = 1): CommandResult {
  return { stdout: '', stderr, exitCode, stderrTruncated: false };
}

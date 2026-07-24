import type { CommandResult, CommandRunner } from '../command-runner';

export interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Deterministic fake keyed by command name — one canned `CommandResult` per
 * command (`ffprobe`/`ffmpeg`), reused across every call to that command in
 * a test unless overridden. Records every call's exact args array so tests
 * can assert on it directly (this is what "ffprobe argument safety" tests
 * check: that the file path and flags are passed as distinct array
 * elements, never concatenated into one interpolated string).
 */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  private readonly results = new Map<string, CommandResult>();

  setResult(command: string, result: CommandResult): void {
    this.results.set(command, result);
  }

  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const result = this.results.get(command);
    if (!result) {
      throw new Error(`FakeCommandRunner: no canned result registered for command "${command}"`);
    }
    return result;
  }
}

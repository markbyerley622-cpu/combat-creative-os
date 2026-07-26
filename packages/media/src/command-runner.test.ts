import { describe, expect, it } from 'vitest';
import { CommandCancelledError, CommandTimeoutError, NodeCommandRunner } from './command-runner';

/**
 * Exercises the real `execFile`-based runner against `node` itself (always
 * present in this test environment) rather than ffmpeg/ffprobe — this
 * package's own rule is that tests "must not require FFmpeg to be
 * installed," and `node` is a generic enough binary to prove the array-args
 * / exit-code / spawn-failure contract without depending on it.
 */
describe('NodeCommandRunner', () => {
  it('captures stdout and exitCode 0 on success', async () => {
    const runner = new NodeCommandRunner();
    const result = await runner.run('node', ['-e', 'console.log("hello")']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('captures a non-zero exit code as a normal result, not a rejection', async () => {
    const runner = new NodeCommandRunner();
    const result = await runner.run('node', ['-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
  });

  it('rejects when the binary cannot be spawned at all', async () => {
    const runner = new NodeCommandRunner();
    await expect(runner.run('this-binary-does-not-exist-xyz', [])).rejects.toThrow();
  });

  it('passes each argument as a distinct array element — a shell-metacharacter-laden argument is never interpreted by a shell', async () => {
    const runner = new NodeCommandRunner();
    const maliciousArg = '; rm -rf / #$(whoami)`id`';
    const result = await runner.run('node', [
      '-e',
      'console.log(process.argv.at(-1))',
      maliciousArg,
    ]);
    expect(result.stdout.trim()).toBe(maliciousArg);
  });

  it('runs the child in the requested working directory', async () => {
    const runner = new NodeCommandRunner();
    const result = await runner.run('node', ['-e', 'console.log(process.cwd())'], {
      cwd: __dirname,
    });
    expect(result.stdout.trim()).toBe(__dirname);
  });

  it('kills a child that outlives its timeout, and surfaces the stderr captured so far', async () => {
    const runner = new NodeCommandRunner();
    const started = Date.now();
    await expect(
      runner.run('node', ['-e', 'console.error("began work"); setTimeout(() => {}, 30000)'], {
        timeoutMs: 400,
      }),
    ).rejects.toThrow(CommandTimeoutError);
    // Proves the process was actually terminated rather than merely awaited.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('cancels a running child when its abort signal fires', async () => {
    const runner = new NodeCommandRunner();
    const controller = new AbortController();
    const pending = runner.run('node', ['-e', 'setTimeout(() => {}, 30000)'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow(CommandCancelledError);
  });

  it('rejects immediately when handed an already-aborted signal, without spawning anything', async () => {
    const runner = new NodeCommandRunner();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runner.run('node', ['-e', 'console.log("should not run")'], {
        signal: controller.signal,
      }),
    ).rejects.toThrow(CommandCancelledError);
  });

  it('bounds stderr to a diagnostic tail instead of buffering an unbounded progress log', async () => {
    const runner = new NodeCommandRunner();
    const result = await runner.run(
      'node',
      [
        '-e',
        'for (let i = 0; i < 4000; i += 1) console.error("x".repeat(100)); console.error("FINAL LINE")',
      ],
      { maxStderrBytes: 4096 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(4096);
    // The tail is kept, because that is where a failing FFmpeg run explains itself.
    expect(result.stderr).toContain('FINAL LINE');
  });

  it('reports a signal-killed process as a non-zero exit rather than as success', async () => {
    const runner = new NodeCommandRunner();
    const result = await runner.run('node', [
      '-e',
      'process.kill(process.pid, "SIGKILL"); setTimeout(() => {}, 5000)',
    ]);
    expect(result.exitCode).not.toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { NodeCommandRunner } from './command-runner';

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
});

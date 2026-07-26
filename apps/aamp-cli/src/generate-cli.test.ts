import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandResult, CommandRunner } from '@combat/media';

import { FixtureVideoGenerationProvider } from './fixture-generation';
import { runGenerateCli } from './generate-cli';

const MANIFEST_PATH = 'apps/aamp-cli/examples/combat-reviews-15s.generation.json';

const BASE_ENV = {
  NODE_ENV: 'development',
  REASONING_PROVIDER: 'mock',
} as const;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  };
}

describe('aamp:generate — execution mode is always declared', () => {
  it('names the mode on stderr before any work begins, and in --plan-only output', async () => {
    const io = capture();
    const code = await runGenerateCli(['--manifest', MANIFEST_PATH, '--plan-only'], {
      cwd: process.cwd(),
      env: { ...BASE_ENV },
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(io.stderrText()).toContain('FIXTURE_REASONING_AND_FIXTURE_GENERATION');
    expect(io.stderrText()).toContain('NOT A REAL ADVERTISEMENT');
    expect(io.stderrText()).toMatch(/ignores this manifest’s campaign prompt/);

    const plan = JSON.parse(io.stdoutText()) as { executionMode: string };
    expect(plan.executionMode).toBe('FIXTURE_REASONING_AND_FIXTURE_GENERATION');
  });

  it('reports REAL_REASONING_AND_FIXTURE_GENERATION when only generation is a fixture', async () => {
    const io = capture();
    // A syntactically valid key is enough: --plan-only stops before any
    // reasoning call, and this asserts mode *labelling*, not model access.
    await runGenerateCli(['--manifest', MANIFEST_PATH, '--plan-only'], {
      cwd: process.cwd(),
      env: { ...BASE_ENV, REASONING_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'sk-ant-test-key' },
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(io.stderrText()).toContain('REAL_REASONING_AND_FIXTURE_GENERATION');
    expect(io.stderrText()).toMatch(/not AI-generated footage/);
  });
});

describe('aamp:generate — real generation never silently degrades', () => {
  it('refuses to continue when a ComfyUI endpoint cannot run the profile', async () => {
    const io = capture();
    const code = await runGenerateCli(['--manifest', MANIFEST_PATH], {
      cwd: process.cwd(),
      env: {
        ...BASE_ENV,
        VIDEO_GENERATION_PROVIDER: 'comfyui',
        // Port 1 refuses immediately, so this is an unreachable endpoint
        // rather than a slow one.
        COMFYUI_BASE_URL: 'http://127.0.0.1:1',
        COMFYUI_OUTPUT_TIMEOUT_MS: '2000',
      },
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(3);
    expect(io.stderrText()).toContain('Real generation was requested');
    expect(io.stderrText()).toContain('will not substitute fixture footage for real generation');
    // Nothing was produced, so nothing can be mistaken for a deliverable.
    expect(io.stdoutText()).toBe('');
  });

  it('refuses at config validation when comfyui is selected with no endpoint', async () => {
    const io = capture();
    const code = await runGenerateCli(['--manifest', MANIFEST_PATH], {
      cwd: process.cwd(),
      env: { ...BASE_ENV, VIDEO_GENERATION_PROVIDER: 'comfyui' },
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(2);
    expect(io.stderrText()).toContain('Configuration is invalid');
  });
});

describe('FixtureVideoGenerationProvider', () => {
  let outputDirectory: string;

  beforeEach(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), 'aamp-fixture-gen-'));
  });

  afterEach(async () => {
    await rm(outputDirectory, { recursive: true, force: true });
  });

  /** Stands in for FFmpeg: writes a small file where the real encoder would. */
  const stubRunner = (): CommandRunner & { invocations: string[][] } => {
    const invocations: string[][] = [];
    return {
      invocations,
      async run(command: string, args: readonly string[]): Promise<CommandResult> {
        invocations.push([command, ...args]);
        const target = args[args.length - 1] as string;
        await writeFile(target, Buffer.from('synthetic placeholder bytes'));
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
  };

  const submitInput = {
    idempotencyKey: 'run-1:GEN:shot-1:1',
    shotId: 'shot-1',
    mode: 'TEXT_TO_VIDEO' as const,
    promptText: 'a fighter shadowboxing',
    candidateCount: 1,
    params: { durationSeconds: 4, aspectRatio: '9:16', resolution: '1080x1920', frameRate: 30 },
  };

  it('produces a real file and reports it with a measured checksum', async () => {
    const runner = stubRunner();
    const provider = new FixtureVideoGenerationProvider({
      runner,
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      outputDirectory,
    });

    const handle = await provider.submit(submitInput);
    expect(await provider.getStatus(handle)).toBe('SUCCEEDED');

    const [candidate] = await provider.fetchResult(handle);
    expect(candidate?.localPath).toBeTruthy();
    const bytes = await readFile(candidate!.localPath!);
    expect(candidate!.sizeBytes).toBe(bytes.byteLength);
    expect(candidate!.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks its own provenance as synthetic so nothing can read it as a model output', async () => {
    const provider = new FixtureVideoGenerationProvider({
      runner: stubRunner(),
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      outputDirectory,
    });

    const handle = await provider.submit(submitInput);
    const [candidate] = await provider.fetchResult(handle);

    expect(candidate!.provenance).toMatchObject({
      providerName: 'fixture-ffmpeg-testpattern',
      modelIdentifier: 'NONE-SYNTHETIC-TEST-PATTERN',
      workflowProfileKey: 'FIXTURE',
    });
  });

  it('charges nothing, because no model ran', async () => {
    const provider = new FixtureVideoGenerationProvider({
      runner: stubRunner(),
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      outputDirectory,
    });
    await provider.submit(submitInput);
    expect(await provider.getUsage()).toMatchObject({ costCents: 0 });
  });

  it('is idempotent: the same key re-encodes nothing', async () => {
    const runner = stubRunner();
    const provider = new FixtureVideoGenerationProvider({
      runner,
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      outputDirectory,
    });

    const first = await provider.submit(submitInput);
    const second = await provider.submit(submitInput);

    expect(second.jobId).toBe(first.jobId);
    expect(runner.invocations).toHaveLength(1);
  });

  it('writes only inside its own output directory', async () => {
    const runner = stubRunner();
    const provider = new FixtureVideoGenerationProvider({
      runner,
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      outputDirectory,
    });

    const handle = await provider.submit(submitInput);
    const [candidate] = await provider.fetchResult(handle);
    expect(dirname(candidate!.localPath!).startsWith(outputDirectory)).toBe(true);
  });
});

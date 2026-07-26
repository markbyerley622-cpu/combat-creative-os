import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runGenerateCli } from './generate-cli';
import { EXIT_CODES } from './run-source-campaign';
import { resolveReasoningPolicy, RealReasoningUnavailableError } from './reasoning-policy';

const REQUEST = 'apps/aamp-cli/examples/combat-reviews-weekend.request.json';

/** FFmpeg is not on PATH in CI; these locations are how this repo pins it. */
const FFMPEG_ENV = {
  ...(process.env.FFMPEG_PATH ? { FFMPEG_PATH: process.env.FFMPEG_PATH } : {}),
  ...(process.env.FFPROBE_PATH ? { FFPROBE_PATH: process.env.FFPROBE_PATH } : {}),
};

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  };
}

describe('reasoning policy', () => {
  it('refuses a real run configured with mock reasoning, and says what to do', () => {
    try {
      resolveReasoningPolicy({
        runMode: 'REAL',
        reasoningProvider: 'mock',
        reasoningModel: 'claude-opus-4-8',
      });
      expect.unreachable('expected the run to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(RealReasoningUnavailableError);
      expect((error as Error).message).toContain('ignores the campaign prompt');
      expect((error as Error).message).toContain('REASONING_PROVIDER=claude');
      expect((error as Error).message).toContain('--fixture-demo');
    }
  });

  it('refuses claude with no API key rather than falling back', () => {
    expect(() =>
      resolveReasoningPolicy({
        runMode: 'REAL',
        reasoningProvider: 'claude',
        reasoningModel: 'claude-opus-4-8',
      }),
    ).toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it('permits fixture reasoning only when demo mode was explicitly requested', () => {
    const policy = resolveReasoningPolicy({
      runMode: 'FIXTURE_DEMO',
      reasoningProvider: 'mock',
      reasoningModel: 'claude-opus-4-8',
    });
    expect(policy.useFixtureReasoning).toBe(true);
    expect(policy.reasoningModel).toBe('NONE-FIXTURE-REPLAY');
    expect(policy.providerName).toBe('fixture-replay');
  });

  it('accepts a properly configured real run', () => {
    const policy = resolveReasoningPolicy({
      runMode: 'REAL',
      reasoningProvider: 'claude',
      reasoningModel: 'claude-opus-4-8',
      anthropicApiKey: 'sk-ant-test',
    });
    expect(policy).toMatchObject({
      runMode: 'REAL',
      useFixtureReasoning: false,
      providerName: 'claude',
      reasoningModel: 'claude-opus-4-8',
    });
  });
});

describe('CLI exit codes', () => {
  it('exits 2 on an unusable campaign request path', async () => {
    const io = capture();
    const code = await runGenerateCli(['--request', 'does/not/exist.json', '--fixture-demo'], {
      cwd: process.cwd(),
      env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
      ...io,
    });
    expect(code).toBe(EXIT_CODES.INVALID_CAMPAIGN_REQUEST);
  });

  it('exits 3 when a real run has no real reasoning provider', async () => {
    const io = capture();
    const code = await runGenerateCli(['--request', REQUEST], {
      cwd: process.cwd(),
      env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
      ...io,
    });
    expect(code).toBe(EXIT_CODES.REAL_REASONING_UNAVAILABLE);
    expect(io.stderrText()).toContain('--fixture-demo');
    // Nothing was produced, so nothing can be mistaken for a campaign result.
    expect(io.stdoutText()).toBe('');
  });

  it('exits 2 with usage when neither --request nor --manifest is given', async () => {
    const io = capture();
    const code = await runGenerateCli([], {
      cwd: process.cwd(),
      env: { NODE_ENV: 'development' },
      ...io,
    });
    expect(code).toBe(2);
    expect(io.stderrText()).toContain('--request');
  });

  it('exits 4 when the asset library declares rights that forbid output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aamp-rights-'));
    try {
      const assets = join(directory, 'assets.json');
      await import('node:fs/promises').then((fs) =>
        fs.writeFile(
          assets,
          JSON.stringify({
            manifestVersion: 1,
            library: 'benchmark library',
            assets: [
              {
                id: 'logo',
                path: './logo.png',
                kind: 'IMAGE',
                role: 'LOGO',
                description: 'logo',
                rights: { classification: 'OWNED', owner: 'CR', permittedOutputUse: true },
              },
              {
                id: 'agency-benchmark',
                path: './benchmark.mp4',
                kind: 'VIDEO',
                role: 'SOURCE_CLIP',
                description: 'award-winning reference advertisement',
                rights: {
                  classification: 'ANALYSIS_ONLY',
                  owner: 'Third party',
                  permittedOutputUse: true,
                },
              },
            ],
          }),
          'utf8',
        ),
      );

      const io = capture();
      const code = await runGenerateCli(
        ['--request', REQUEST, '--assets', assets, '--fixture-demo'],
        { cwd: process.cwd(), env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' }, ...io },
      );

      expect(code).toBe(EXIT_CODES.INVALID_ASSET_RIGHTS);
      expect(io.stderrText()).toContain('must never enter a production asset manifest');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('fixture-demo runs are isolated and labelled', () => {
  let outputDirectory: string;

  beforeEach(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), 'aamp-run-'));
  });

  afterEach(async () => {
    // FFmpeg's job directory can still be held briefly by the exited encoder
    // on Windows. Cleanup is housekeeping, not an assertion — a locked
    // temp directory must not fail a passing test.
    await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
  });

  it('announces demo mode and reports it in --plan-only output', async () => {
    const io = capture();
    const code = await runGenerateCli(['--request', REQUEST, '--fixture-demo', '--plan-only'], {
      cwd: process.cwd(),
      env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock', ...FFMPEG_ENV },
      ...io,
    });

    expect(code).toBe(EXIT_CODES.SUCCESS);
    expect(io.stderrText()).toContain('FIXTURE_DEMO');
    expect(io.stderrText()).toContain('ignores this campaign prompt');

    const plan = JSON.parse(io.stdoutText()) as {
      runMode: string;
      promptSha256: string;
      agentVersions: string[];
    };
    expect(plan.runMode).toBe('FIXTURE_DEMO');
    expect(plan.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    // Provenance records which prompt version of each agent actually ran.
    expect(plan.agentVersions[0]).toMatch(/^campaign-strategist@v\d+$/);
  });

  // A full render, so the artefacts inspected here are the real ones.
  it('never copies a secret into any run artefact', { timeout: 180_000 }, async () => {
    const io = capture();
    const code = await runGenerateCli(
      ['--request', REQUEST, '--fixture-demo', '--output-dir', outputDirectory],
      {
        cwd: process.cwd(),
        env: {
          NODE_ENV: 'development',
          REASONING_PROVIDER: 'mock',
          ANTHROPIC_API_KEY: 'sk-ant-super-secret-value',
          COMFYUI_API_KEY: 'comfy-secret-value',
          ...FFMPEG_ENV,
        },
        ...io,
      },
    );

    // Deliberately tolerant of the environment: where FFmpeg is unavailable the
    // run stops earlier, but it has already written the artefacts this test
    // inspects. What is asserted is that *whatever* was written contains no
    // secret — which must hold on every path, not only the happy one.
    expect(code).not.toBe(EXIT_CODES.REAL_REASONING_UNAVAILABLE);

    const runDirectories = await readdir(outputDirectory);
    expect(runDirectories.length).toBeGreaterThan(0);
    const runDirectory = join(outputDirectory, runDirectories[0]!);

    for (const file of await readdir(runDirectory)) {
      if (!file.endsWith('.json')) continue;
      const contents = await readFile(join(runDirectory, file), 'utf8');
      expect(contents, `${file} leaked a secret`).not.toContain('sk-ant-super-secret-value');
      expect(contents, `${file} leaked a secret`).not.toContain('comfy-secret-value');
    }
  });
});

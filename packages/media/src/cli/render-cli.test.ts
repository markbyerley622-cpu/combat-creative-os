import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findRepositoryRoot, parseCliArguments, runRenderCli } from './render-cli';

/**
 * Windows releases a child process's file handles asynchronously, so a
 * directory removal issued immediately after the last FFmpeg exits can see
 * `ENOTEMPTY` even though every file was unlinked. Actual-media QA now spawns
 * roughly ten probes per render — a frame walk, the caption and safe-area
 * crops, the CTA hold and the audio decode — which widens that window
 * considerably on a loaded machine. `fs.rm`'s retry options exist for exactly
 * this case; they are the documented API, not a retry hiding a defect.
 */
const CLEANUP = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'combat-cli-'));
});

afterEach(async () => {
  await rm(workRoot, CLEANUP);
});

function capture(): { out: string[]; err: string[] } {
  return { out: [], err: [] };
}

describe('parseCliArguments', () => {
  it('reads the manifest path', () => {
    expect(parseCliArguments(['--manifest', 'a/b.json']).manifestPath).toBe('a/b.json');
  });

  it('reads the optional output root, extra source roots and json flag', () => {
    const options = parseCliArguments([
      '--manifest',
      'a.json',
      '--output-root',
      'out',
      '--allow-source-root',
      'assets',
      '--allow-source-root',
      'brand',
      '--json',
    ]);
    expect(options.outputRoot).toBe('out');
    expect(options.extraSourceRoots).toEqual(['assets', 'brand']);
    expect(options.json).toBe(true);
  });

  it('requires a manifest', () => {
    expect(() => parseCliArguments([])).toThrow(/--manifest/);
  });

  it('rejects an unknown option rather than ignoring it', () => {
    expect(() => parseCliArguments(['--manifest', 'a.json', '--overwrite'])).toThrow(
      /Unknown option --overwrite/,
    );
  });
});

describe('findRepositoryRoot', () => {
  it('walks up to the directory holding pnpm-workspace.yaml', async () => {
    const nested = join(workRoot, 'packages', 'media', 'src');
    await mkdir(nested, { recursive: true });
    await writeFile(join(workRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    expect(await findRepositoryRoot(nested)).toBe(resolve(workRoot));
  });

  it('falls back to the starting directory when there is no workspace above it', async () => {
    expect(await findRepositoryRoot(workRoot)).toBe(resolve(workRoot));
  });
});

describe('runRenderCli — failure reporting', () => {
  it('exits 2 with a usage message when no manifest is given', async () => {
    const io = capture();
    const code = await runRenderCli([], {
      cwd: workRoot,
      env: {},
      stdout: (t) => io.out.push(t),
      stderr: (t) => io.err.push(t),
    });
    expect(code).toBe(2);
    expect(io.err.join('')).toMatch(/--manifest/);
  });

  it('exits 2 when the manifest file cannot be read', async () => {
    const io = capture();
    const code = await runRenderCli(['--manifest', join(workRoot, 'nope.json')], {
      cwd: workRoot,
      env: {},
      stdout: (t) => io.out.push(t),
      stderr: (t) => io.err.push(t),
    });
    expect(code).toBe(2);
    expect(io.err.join('')).toMatch(/Could not read manifest/);
  });

  it('exits 2 and reports every validation issue when the manifest is invalid', async () => {
    const manifestPath = join(workRoot, 'broken.json');
    await writeFile(manifestPath, JSON.stringify({ manifestVersion: 1, name: 'x' }));

    const io = capture();
    const code = await runRenderCli(['--manifest', manifestPath], {
      cwd: workRoot,
      env: {},
      stdout: (t) => io.out.push(t),
      stderr: (t) => io.err.push(t),
    });
    expect(code).toBe(2);
    expect(io.err.join('')).toMatch(/Render manifest is invalid/);
    expect(io.out.join('')).toBe('');
  });

  it('exits 2 when a source cannot be resolved, without printing a success line', async () => {
    const manifestPath = join(workRoot, 'unresolvable.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        manifestVersion: 1,
        name: 'unresolvable',
        campaignId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        campaignPrompt: 'a cut whose source is not on disk',
        output: {
          durationSeconds: 2,
          aspectRatio: '9:16',
          widthPx: 1080,
          heightPx: 1920,
          frameRate: 30,
          container: 'mp4',
          videoCodec: 'h264',
          audioCodec: null,
          pixelFormat: 'yuv420p',
        },
        sources: [
          {
            id: 'still',
            kind: 'IMAGE',
            path: 'missing.png',
            description: 'a still that is not there',
            license: {
              usageClass: 'OWNED',
              rightsHolder: 'Combat Reviews',
              licenseType: 'FULL_RIGHTS',
            },
          },
        ],
        scenes: [{ id: 'only', sourceId: 'still', durationSeconds: 2 }],
      }),
    );

    const io = capture();
    const code = await runRenderCli(['--manifest', manifestPath], {
      cwd: workRoot,
      env: {},
      stdout: (t) => io.out.push(t),
      stderr: (t) => io.err.push(t),
    });
    expect(code).toBe(2);
    expect(io.err.join('')).toMatch(/does not exist/);
    expect(io.out.join('')).toBe('');
  });
});

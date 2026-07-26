import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  assertReadableNonEmptyFile,
  assertWritableOutputPath,
  isContainedWithin,
  OutputAlreadyExistsError,
  PathNotContainedError,
  resolveContainedPath,
  SourceFileError,
  UnsafePathError,
} from './paths';

let root: string;
let allowedRoot: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'combat-paths-'));
  allowedRoot = join(root, 'allowed');
  await mkdir(allowedRoot, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveContainedPath — unsafe path rejection', () => {
  const cases: readonly [string, string][] = [
    ['an empty path', '   '],
    ['a NUL byte', `clip${String.fromCharCode(0)}.mp4`],
    ['an http URL, which FFmpeg would fetch over the network', 'http://example.com/clip.mp4'],
    ['an https URL', 'https://example.com/clip.mp4'],
    ['a leading dash, which FFmpeg reads as an option', '-loop'],
    ['the concat protocol', 'concat:a.mp4|b.mp4'],
    ['the pipe protocol', 'pipe:0'],
  ];

  it.each(cases)('rejects %s', (_label, rawPath) => {
    expect(() =>
      resolveContainedPath({ rawPath, baseDir: allowedRoot, allowedRoots: [allowedRoot] }),
    ).toThrow(UnsafePathError);
  });

  it('rejects a traversal that escapes every allowed root', () => {
    expect(() =>
      resolveContainedPath({
        rawPath: '../../../../etc/passwd',
        baseDir: allowedRoot,
        allowedRoots: [allowedRoot],
      }),
    ).toThrow(PathNotContainedError);
  });

  it('rejects an absolute path outside every allowed root', () => {
    expect(() =>
      resolveContainedPath({
        rawPath: resolve(root, 'elsewhere', 'secret.mp4'),
        baseDir: allowedRoot,
        allowedRoots: [allowedRoot],
      }),
    ).toThrow(PathNotContainedError);
  });

  it('accepts a relative path resolved inside an allowed root', () => {
    const resolved = resolveContainedPath({
      rawPath: 'generated/clip.mp4',
      baseDir: allowedRoot,
      allowedRoots: [allowedRoot],
    });
    expect(resolved).toBe(join(allowedRoot, 'generated', 'clip.mp4'));
  });

  it('accepts a traversal that stays inside a wider allowed root', () => {
    const nested = join(allowedRoot, 'a', 'b');
    const resolved = resolveContainedPath({
      rawPath: '../../clip.mp4',
      baseDir: nested,
      allowedRoots: [allowedRoot],
    });
    expect(resolved).toBe(join(allowedRoot, 'clip.mp4'));
  });
});

describe('isContainedWithin', () => {
  it('treats a root as containing itself, but never treats a sibling prefix as containment', () => {
    expect(isContainedWithin(allowedRoot, allowedRoot)).toBe(true);
    expect(isContainedWithin(join(allowedRoot, 'x'), allowedRoot)).toBe(true);
    // `allowed-other` shares a string prefix with `allowed` but is a different directory.
    expect(isContainedWithin(`${allowedRoot}-other`, allowedRoot)).toBe(false);
  });
});

describe('assertReadableNonEmptyFile', () => {
  it('rejects a file that does not exist', async () => {
    await expect(assertReadableNonEmptyFile(join(allowedRoot, 'absent.mp4'))).rejects.toThrow(
      SourceFileError,
    );
  });

  it('rejects a directory', async () => {
    await expect(assertReadableNonEmptyFile(allowedRoot)).rejects.toThrow(/is a directory/);
  });

  it('rejects a zero-byte file before FFmpeg is ever invoked', async () => {
    const empty = join(allowedRoot, 'empty.mp4');
    await writeFile(empty, '');
    await expect(assertReadableNonEmptyFile(empty)).rejects.toThrow(/zero bytes/);
  });

  it('returns the size of a readable, non-empty file', async () => {
    const file = join(allowedRoot, 'ok.bin');
    await writeFile(file, 'combat');
    await expect(assertReadableNonEmptyFile(file)).resolves.toEqual({
      absolutePath: file,
      sizeBytes: 6,
    });
  });
});

describe('assertWritableOutputPath', () => {
  it('refuses a target outside the output root', async () => {
    await expect(
      assertWritableOutputPath({
        outputPath: join(root, 'outside.mp4'),
        outputRoot: allowedRoot,
      }),
    ).rejects.toThrow(PathNotContainedError);
  });

  it('refuses to overwrite an existing file unless replacement is explicit', async () => {
    const existing = join(allowedRoot, 'already-there.mp4');
    await writeFile(existing, 'do not clobber me');

    await expect(
      assertWritableOutputPath({ outputPath: existing, outputRoot: allowedRoot }),
    ).rejects.toThrow(OutputAlreadyExistsError);

    await expect(
      assertWritableOutputPath({
        outputPath: existing,
        outputRoot: allowedRoot,
        allowReplace: true,
      }),
    ).resolves.toBe(existing);
  });

  it('accepts a fresh target inside the output root', async () => {
    const target = join(allowedRoot, 'fresh.mp4');
    await expect(
      assertWritableOutputPath({ outputPath: target, outputRoot: allowedRoot }),
    ).resolves.toBe(target);
  });
});

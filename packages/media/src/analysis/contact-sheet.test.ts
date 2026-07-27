import { describe, expect, it } from 'vitest';

import { ContactSheetError, buildContactSheet, stackLayout } from './contact-sheet';
import { FakeCommandRunner } from '../test-helpers/fake-command-runner';

/**
 * `xstack` has no "columns" option — it takes the position of every input — so
 * the grid is arithmetic, and arithmetic is worth pinning. A layout that is
 * off by one tile produces a sheet that looks plausible and shows the beats in
 * the wrong order.
 */

describe('contact-sheet grid layout', () => {
  it('places the first tile at the origin', () => {
    expect(stackLayout(1, 5)).toBe('0_0');
  });

  it('lays a single row out left to right', () => {
    expect(stackLayout(3, 5)).toBe('0_0|w0_0|w0+w1_0');
  });

  it('wraps onto the next row at the column count', () => {
    // Six tiles, three columns: two rows, the second offset by the first
    // row's height.
    expect(stackLayout(6, 3)).toBe('0_0|w0_0|w0+w1_0|0_h0|w0_h0|w0+w1_h0');
  });

  it('offsets each further row by the heights of the rows above it', () => {
    const layout = stackLayout(9, 3).split('|');
    expect(layout[6]).toBe('0_h0+h3');
    expect(layout).toHaveLength(9);
  });

  it('produces one position per input, always', () => {
    for (const count of [1, 2, 4, 5, 7, 12]) {
      for (const columns of [1, 2, 3, 5]) {
        expect(stackLayout(count, columns).split('|')).toHaveLength(count);
      }
    }
  });
});

describe('contact-sheet construction', () => {
  it('refuses to tile nothing rather than producing an empty sheet', async () => {
    await expect(
      buildContactSheet(new FakeCommandRunner(), [], '/frames', '/sheet.png'),
    ).rejects.toThrow(ContactSheetError);
  });

  it('reports the tiling failure rather than leaving a truncated sheet behind', async () => {
    const runner = new FakeCommandRunner();
    runner.setResponder('ffmpeg', () => ({
      stdout: '',
      stderr: 'Invalid argument',
      exitCode: 1,
      stderrTruncated: false,
    }));
    await expect(
      buildContactSheet(
        runner,
        [{ id: 'a', fileName: '00-a.png', atSeconds: 0 }],
        '/frames',
        '/sheet.png',
        { ffmpegPath: 'ffmpeg' },
      ),
    ).rejects.toThrow(/Invalid argument/);
  });

  it('names every frame as an explicit input, so ordering never depends on a glob', async () => {
    const runner = new FakeCommandRunner();
    runner.setResponder('ffmpeg', () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      stderrTruncated: false,
    }));
    await buildContactSheet(
      runner,
      [
        { id: 'a', fileName: '00-a.png', atSeconds: 0 },
        { id: 'b', fileName: '01-b.png', atSeconds: 4 },
      ],
      '/frames',
      '/sheet.png',
      { ffmpegPath: 'ffmpeg' },
    );

    const call = runner.callsTo('ffmpeg')[0];
    expect(call?.args.filter((arg) => arg === '-i')).toHaveLength(2);
    expect(call?.args.some((arg) => arg.includes('00-a.png'))).toBe(true);
    expect(call?.args.some((arg) => arg.includes('01-b.png'))).toBe(true);
    expect(call?.args.some((arg) => arg.includes('xstack=inputs=2'))).toBe(true);
    // No shell, no glob, no wildcard anywhere in the invocation.
    expect(call?.args.some((arg) => arg.includes('*'))).toBe(false);
  });
});

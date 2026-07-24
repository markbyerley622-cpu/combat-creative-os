import { describe, expect, it } from 'vitest';
import { inspectMedia } from './inspect';
import { MediaTooLargeError, MediaTypeMismatchError, UnsupportedMediaFormatError } from './types';
import { FakeCommandRunner } from './test-helpers/fake-command-runner';

function ffprobeJson(data: unknown): string {
  return JSON.stringify(data);
}

const VALID_VIDEO_STDOUT = ffprobeJson({
  format: { duration: '10' },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1280,
      height: 720,
      avg_frame_rate: '30/1',
      nb_frames: '300',
    },
  ],
});

describe('inspectMedia', () => {
  it('rejects a file over the configured size limit before ever invoking ffprobe', async () => {
    const runner = new FakeCommandRunner();
    // Deliberately no ffprobe result registered — proves it's never called.

    await expect(
      inspectMedia(runner, {
        filePath: '/tmp/huge.mp4',
        declaredMediaType: 'VIDEO',
        actualSizeBytes: 500,
        maxBytes: 100,
      }),
    ).rejects.toThrow(MediaTooLargeError);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects when the detected media type does not match the declared type', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', { exitCode: 0, stderr: '', stdout: VALID_VIDEO_STDOUT });

    await expect(
      inspectMedia(runner, {
        filePath: '/tmp/mislabeled.jpg',
        declaredMediaType: 'IMAGE',
        actualSizeBytes: 100,
        maxBytes: 1000,
      }),
    ).rejects.toThrow(MediaTypeMismatchError);
  });

  it('rejects an unsupported video codec', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', {
      exitCode: 0,
      stderr: '',
      stdout: ffprobeJson({
        format: { duration: '10' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'mpeg2video',
            width: 640,
            height: 480,
            nb_frames: '100',
          },
        ],
      }),
    });

    await expect(
      inspectMedia(runner, {
        filePath: '/tmp/old.mpg',
        declaredMediaType: 'VIDEO',
        actualSizeBytes: 100,
        maxBytes: 1000,
      }),
    ).rejects.toThrow(UnsupportedMediaFormatError);
  });

  it('rejects an unsupported audio codec', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', {
      exitCode: 0,
      stderr: '',
      stdout: ffprobeJson({
        format: { duration: '10' },
        streams: [{ codec_type: 'audio', codec_name: 'wmav2', channels: 2, sample_rate: '44100' }],
      }),
    });

    await expect(
      inspectMedia(runner, {
        filePath: '/tmp/old.wma',
        declaredMediaType: 'AUDIO',
        actualSizeBytes: 100,
        maxBytes: 1000,
      }),
    ).rejects.toThrow(UnsupportedMediaFormatError);
  });

  it('returns the probe result for a valid, correctly-declared, within-limit file', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', { exitCode: 0, stderr: '', stdout: VALID_VIDEO_STDOUT });

    const result = await inspectMedia(runner, {
      filePath: '/tmp/good.mp4',
      declaredMediaType: 'VIDEO',
      actualSizeBytes: 100,
      maxBytes: 1000,
    });

    expect(result.mediaType).toBe('VIDEO');
  });
});

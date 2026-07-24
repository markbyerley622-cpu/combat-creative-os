import { describe, expect, it } from 'vitest';
import { createFfmpegMediaProvider } from './media-provider';
import { CorruptMediaError } from './types';
import { FakeCommandRunner } from './test-helpers/fake-command-runner';

describe('createFfmpegMediaProvider', () => {
  it('generateThumbnail probes its own output and returns detected dimensions', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffmpeg', { exitCode: 0, stdout: '', stderr: '' });
    runner.setResult('ffprobe', {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        format: {},
        streams: [{ codec_type: 'video', width: 640, height: 360, nb_frames: '1' }],
      }),
    });
    const provider = createFfmpegMediaProvider(runner);

    const result = await provider.generateThumbnail({
      sourcePath: '/tmp/src.mp4',
      outputPath: '/tmp/thumb.jpg',
    });

    expect(result).toEqual({ outputPath: '/tmp/thumb.jpg', widthPx: 640, heightPx: 360 });
    const ffmpegCall = runner.calls.find((c) => c.command === 'ffmpeg');
    expect(ffmpegCall?.args).toContain('/tmp/src.mp4');
    expect(ffmpegCall?.args).toContain('/tmp/thumb.jpg');
    expect(ffmpegCall?.args).toContain('-vf');
  });

  it('generateThumbnail throws CorruptMediaError when ffmpeg exits non-zero', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffmpeg', { exitCode: 1, stdout: '', stderr: 'no such filter' });
    const provider = createFfmpegMediaProvider(runner);

    await expect(
      provider.generateThumbnail({ sourcePath: '/tmp/src.mp4', outputPath: '/tmp/thumb.jpg' }),
    ).rejects.toThrow(CorruptMediaError);
  });

  it('generateProxy probes its own output and returns detected dimensions/duration', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffmpeg', { exitCode: 0, stdout: '', stderr: '' });
    runner.setResult('ffprobe', {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        format: { duration: '12.5' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1280,
            height: 720,
            nb_frames: '300',
            avg_frame_rate: '24/1',
          },
        ],
      }),
    });
    const provider = createFfmpegMediaProvider(runner);

    const result = await provider.generateProxy({
      sourcePath: '/tmp/src.mp4',
      outputPath: '/tmp/proxy.mp4',
      profile: 'PREVIEW_720P',
    });

    expect(result).toEqual({
      outputPath: '/tmp/proxy.mp4',
      durationSeconds: 12.5,
      widthPx: 1280,
      heightPx: 720,
    });
    const ffmpegCall = runner.calls.find((c) => c.command === 'ffmpeg');
    expect(ffmpegCall?.args).toContain('scale=1280:-1');
  });

  it('generateProxy throws CorruptMediaError when ffmpeg exits non-zero', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffmpeg', { exitCode: 1, stdout: '', stderr: 'encoder not found' });
    const provider = createFfmpegMediaProvider(runner);

    await expect(
      provider.generateProxy({
        sourcePath: '/tmp/src.mp4',
        outputPath: '/tmp/proxy.mp4',
        profile: 'PREVIEW_480P',
      }),
    ).rejects.toThrow(CorruptMediaError);
  });

  it('passes source/output paths as distinct array elements, never concatenated into one string', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffmpeg', { exitCode: 0, stdout: '', stderr: '' });
    runner.setResult('ffprobe', {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        format: {},
        streams: [{ codec_type: 'video', width: 1, height: 1, nb_frames: '1' }],
      }),
    });
    const provider = createFfmpegMediaProvider(runner);
    const maliciousPath = '/tmp/"; rm -rf / #.mp4';

    await provider.generateThumbnail({ sourcePath: maliciousPath, outputPath: '/tmp/out.jpg' });

    const ffmpegCall = runner.calls.find((c) => c.command === 'ffmpeg');
    expect(ffmpegCall?.args).toContain(maliciousPath);
    expect(ffmpegCall?.args.some((a) => a.includes(';') && a !== maliciousPath)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { probeMedia } from './ffprobe';
import { CorruptMediaError } from './types';
import { FakeCommandRunner } from './test-helpers/fake-command-runner';

function ffprobeJson(data: unknown): string {
  return JSON.stringify(data);
}

describe('probeMedia', () => {
  it('detects a video stream with audio', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', {
      exitCode: 0,
      stderr: '',
      stdout: ffprobeJson({
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '15.033000' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            avg_frame_rate: '30/1',
            nb_frames: '451',
          },
          { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
        ],
      }),
    });

    const result = await probeMedia(runner, '/tmp/video.mp4');

    expect(result).toEqual({
      mediaType: 'VIDEO',
      durationSeconds: 15.033,
      widthPx: 1920,
      heightPx: 1080,
      frameRate: 30,
      videoCodec: 'h264',
      hasAudio: true,
      audioCodec: 'aac',
    });
  });

  it('detects a video stream with no audio', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', {
      exitCode: 0,
      stderr: '',
      stdout: ffprobeJson({
        format: { duration: '5.0' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'vp9',
            width: 640,
            height: 360,
            r_frame_rate: '24/1',
            nb_frames: '120',
          },
        ],
      }),
    });

    const result = await probeMedia(runner, '/tmp/silent.webm');
    expect(result.mediaType).toBe('VIDEO');
    if (result.mediaType === 'VIDEO') {
      expect(result.hasAudio).toBe(false);
      expect(result.audioCodec).toBeUndefined();
    }
  });

  it('detects a single-frame, zero-duration video-coded stream as an image', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', {
      exitCode: 0,
      stderr: '',
      stdout: ffprobeJson({
        format: { format_name: 'png_pipe' },
        streams: [
          { codec_type: 'video', width: 800, height: 600, nb_frames: '1', pix_fmt: 'rgba' },
        ],
      }),
    });

    const result = await probeMedia(runner, '/tmp/logo.png');

    expect(result).toEqual({
      mediaType: 'IMAGE',
      widthPx: 800,
      heightPx: 600,
      format: 'png_pipe',
      colorSpace: 'rgba',
    });
  });

  it('detects an audio-only stream', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', {
      exitCode: 0,
      stderr: '',
      stdout: ffprobeJson({
        format: { duration: '30.5' },
        streams: [{ codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' }],
      }),
    });

    const result = await probeMedia(runner, '/tmp/track.mp3');

    expect(result).toEqual({
      mediaType: 'AUDIO',
      durationSeconds: 30.5,
      codec: 'mp3',
      channels: 2,
      sampleRateHz: 44100,
    });
  });

  it('throws CorruptMediaError on a non-zero ffprobe exit code', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', {
      exitCode: 1,
      stderr: 'Invalid data found when processing input',
      stdout: '',
    });

    await expect(probeMedia(runner, '/tmp/corrupt.mp4')).rejects.toThrow(CorruptMediaError);
  });

  it('throws CorruptMediaError on unparseable ffprobe output', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', { exitCode: 0, stderr: '', stdout: 'not json' });

    await expect(probeMedia(runner, '/tmp/weird.mp4')).rejects.toThrow(CorruptMediaError);
  });

  it('throws CorruptMediaError when no video or audio stream is present', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', {
      exitCode: 0,
      stderr: '',
      stdout: ffprobeJson({ format: {}, streams: [] }),
    });

    await expect(probeMedia(runner, '/tmp/empty.bin')).rejects.toThrow(CorruptMediaError);
  });

  it('passes the file path and flags as distinct array elements (ffprobe argument safety)', async () => {
    const runner = new FakeCommandRunner();
    runner.setResult('ffprobe', {
      exitCode: 0,
      stderr: '',
      stdout: ffprobeJson({
        format: { duration: '1' },
        streams: [{ codec_type: 'audio', codec_name: 'aac', channels: 1, sample_rate: '16000' }],
      }),
    });

    const maliciousPath = '/tmp/"; rm -rf / #.mp4';
    await probeMedia(runner, maliciousPath);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.command).toBe('ffprobe');
    expect(runner.calls[0]!.args.at(-1)).toBe(maliciousPath);
    expect(runner.calls[0]!.args).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      maliciousPath,
    ]);
  });
});

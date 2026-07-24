import { describe, expect, it } from 'vitest';
import { MockMediaProvider } from './media-provider.mock';

describe('MockMediaProvider', () => {
  it('returns a registered probe result', async () => {
    const provider = new MockMediaProvider();
    provider.setProbeResult('/tmp/a.mp4', {
      mediaType: 'VIDEO',
      durationSeconds: 5,
      widthPx: 100,
      heightPx: 100,
      frameRate: 30,
      videoCodec: 'h264',
      hasAudio: false,
    });

    const result = await provider.probe({
      filePath: '/tmp/a.mp4',
      declaredMediaType: 'VIDEO',
      actualSizeBytes: 1,
      maxBytes: 100,
    });
    expect(result.mediaType).toBe('VIDEO');
  });

  it('throws a registered error for a probe result', async () => {
    const provider = new MockMediaProvider();
    provider.setProbeResult('/tmp/corrupt.mp4', new Error('corrupt'));

    await expect(
      provider.probe({
        filePath: '/tmp/corrupt.mp4',
        declaredMediaType: 'VIDEO',
        actualSizeBytes: 1,
        maxBytes: 100,
      }),
    ).rejects.toThrow('corrupt');
  });

  it('throws on an unregistered path rather than silently returning nothing', async () => {
    const provider = new MockMediaProvider();
    await expect(
      provider.probe({
        filePath: '/tmp/unregistered.mp4',
        declaredMediaType: 'VIDEO',
        actualSizeBytes: 1,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/no canned probe result/);
  });

  it('generateThumbnail and generateProxy return registered results', async () => {
    const provider = new MockMediaProvider();
    provider.setThumbnailResult('/tmp/a.mp4', {
      outputPath: '/tmp/thumb.jpg',
      widthPx: 640,
      heightPx: 360,
    });
    provider.setProxyResult('/tmp/a.mp4', {
      outputPath: '/tmp/proxy.mp4',
      durationSeconds: 5,
      widthPx: 1280,
      heightPx: 720,
    });

    const thumb = await provider.generateThumbnail({
      sourcePath: '/tmp/a.mp4',
      outputPath: '/tmp/thumb.jpg',
    });
    expect(thumb.widthPx).toBe(640);

    const proxy = await provider.generateProxy({
      sourcePath: '/tmp/a.mp4',
      outputPath: '/tmp/proxy.mp4',
      profile: 'PREVIEW_720P',
    });
    expect(proxy.durationSeconds).toBe(5);
  });
});

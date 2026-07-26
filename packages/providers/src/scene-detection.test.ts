import { describe, expect, it } from 'vitest';

import type { CommandResult, CommandRunner } from '@combat/media';

import { cutsToScenes, SceneDetectionError, type SceneDetectionProvider } from './scene-detection';
import { FfmpegSceneDetectionProvider, parseFrameTimestamps } from './scene-detection.ffmpeg';
import {
  parseSceneCsvStartSeconds,
  PySceneDetectProvider,
  PYSCENEDETECT_PINNED_VERSION,
} from './scene-detection.pyscenedetect';
import { MockSceneDetectionProvider } from './scene-detection.mock';
import {
  MockTranscriptionProvider,
  UnavailableTranscriptionProvider,
  parseWhisperJson,
} from './transcription';

const BINARIES = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };

function runnerReturning(stdout: string): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(command: string, args: readonly string[]): Promise<CommandResult> {
      calls.push([command, ...args]);
      return { stdout, stderr: '', exitCode: 0 };
    },
  };
}

describe('cut list to scene intervals', () => {
  it('turns N boundaries into N+1 closed scenes', () => {
    const scenes = cutsToScenes([2, 4], 6, 0.25);
    expect(scenes).toHaveLength(3);
    expect(scenes[0]).toMatchObject({ sceneIndex: 0, startSeconds: 0, endSeconds: 2 });
    expect(scenes[2]).toMatchObject({ sceneIndex: 2, startSeconds: 4, endSeconds: 6 });
  });

  it('treats a file with no cuts as a single scene, not zero scenes', () => {
    expect(cutsToScenes([], 5, 0.25)).toEqual([
      { sceneIndex: 0, startSeconds: 0, endSeconds: 5, durationSeconds: 5 },
    ]);
  });

  it('merges fragments shorter than the minimum rather than emitting them', () => {
    const scenes = cutsToScenes([2, 2.05, 4], 6, 0.25);
    expect(scenes.map((scene) => scene.startSeconds)).toEqual([0, 2, 4]);
  });

  it('ignores boundaries outside the media', () => {
    expect(cutsToScenes([-1, 0, 99], 5, 0.25)).toHaveLength(1);
  });

  it('de-duplicates repeated boundaries', () => {
    expect(cutsToScenes([2, 2, 2], 4, 0.25)).toHaveLength(2);
  });
});

describe('ffprobe scene-detection output parsing', () => {
  it('reads pts_time from the JSON frame list', () => {
    expect(
      parseFrameTimestamps('{"frames":[{"pts_time":"2.000000"},{"pts_time":"4.000000"}]}'),
    ).toEqual([2, 4]);
  });

  it('treats an absent frames key as "no cuts", not as a failure', () => {
    expect(parseFrameTimestamps('{}')).toEqual([]);
    expect(parseFrameTimestamps('')).toEqual([]);
  });

  it('rejects non-JSON rather than guessing', () => {
    expect(() => parseFrameTimestamps('frame 1 at 2.0s')).toThrow(SceneDetectionError);
  });

  it('rejects a frames field that is not an array', () => {
    expect(() => parseFrameTimestamps('{"frames":"lots"}')).toThrow(/non-array/);
  });

  it('builds a filter using a bare filename, never a drive-lettered path', async () => {
    const runner = runnerReturning('{"frames":[{"pts_time":"1.5"}]}');
    const provider = new FfmpegSceneDetectionProvider(BINARIES, runner);

    await provider.detectScenes({ filePath: 'C:/refs/ad.mp4', durationSeconds: 3 });

    const detectCall = runner.calls.find((call) => call.includes('lavfi'));
    const filter = detectCall?.find((arg) => arg.startsWith('movie='));
    expect(filter).toBe('movie=ad.mp4,select=gt(scene\\,0.27)');
    // A `C:` inside a filter argument collides with the option separator.
    expect(filter).not.toContain('C:/');
  });

  it('refuses a threshold outside the 0-1 range', async () => {
    const provider = new FfmpegSceneDetectionProvider(BINARIES, runnerReturning('{}'));
    await expect(
      provider.detectScenes({ filePath: 'C:/refs/ad.mp4', durationSeconds: 3, threshold: 5 }),
    ).rejects.toThrow(/between 0 and 1/);
  });

  it('surfaces a missing binary as a typed failure', async () => {
    const provider = new FfmpegSceneDetectionProvider(BINARIES, {
      async run() {
        throw new Error('spawn ffprobe ENOENT');
      },
    });
    await expect(
      provider.detectScenes({ filePath: 'C:/refs/ad.mp4', durationSeconds: 3 }),
    ).rejects.toBeInstanceOf(SceneDetectionError);
  });

  it('reports a cancelled run as CANCELLED', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new FfmpegSceneDetectionProvider(BINARIES, {
      async run() {
        throw new Error('aborted');
      },
    });
    await expect(
      provider.detectScenes({
        filePath: 'C:/refs/ad.mp4',
        durationSeconds: 3,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'CANCELLED' });
  });
});

describe('PySceneDetect adapter', () => {
  it('pins an explicit release', () => {
    expect(PYSCENEDETECT_PINNED_VERSION).toBe('0.6.4');
  });

  it('reads start times by column name, not position', () => {
    const csv = [
      'Timecode List:,00:00:02.000',
      'Scene Number,Start Frame,Start Time (seconds),End Frame',
      '1,0,0.000,60',
      '2,60,2.000,120',
    ].join('\n');
    expect(parseSceneCsvStartSeconds(csv)).toEqual([0, 2]);
  });

  it('rejects CSV with no recognisable start column', () => {
    expect(() => parseSceneCsvStartSeconds('Scene,Frame\n1,0')).toThrow(/Start Time/);
  });

  it('passes the file as a single argv entry, never a shell string', async () => {
    const runner = runnerReturning('Scene Number,Start Time (seconds)\n1,0.000\n2,1.500');
    const provider = new PySceneDetectProvider({ executable: 'scenedetect', runner });

    await provider.detectScenes({ filePath: 'C:/refs/an ad with spaces.mp4', durationSeconds: 3 });

    expect(runner.calls[0]).toContain('C:/refs/an ad with spaces.mp4');
  });

  it('reports an actionable install command when the binary is missing', async () => {
    const provider = new PySceneDetectProvider({
      executable: 'scenedetect',
      runner: {
        async run() {
          throw new Error('spawn scenedetect ENOENT');
        },
      },
    });
    await expect(
      provider.detectScenes({ filePath: 'C:/refs/ad.mp4', durationSeconds: 3 }),
    ).rejects.toThrow(/pip install "scenedetect\[opencv\]==0\.6\.4"/);
  });
});

describe('deterministic fake detector', () => {
  it('returns the same segmentation for the same file every time', async () => {
    const provider: SceneDetectionProvider = new MockSceneDetectionProvider();
    const request = { filePath: 'C:/refs/ad.mp4', durationSeconds: 6 };
    const first = await provider.detectScenes(request);
    const second = await provider.detectScenes(request);
    expect(first.scenes).toEqual(second.scenes);
  });

  it('honours a scripted cut list', async () => {
    const provider = new MockSceneDetectionProvider({ cutsByFile: { 'ad.mp4': [1, 2] } });
    const { scenes } = await provider.detectScenes({
      filePath: 'C:/refs/ad.mp4',
      durationSeconds: 3,
    });
    expect(scenes.map((scene) => scene.startSeconds)).toEqual([0, 1, 2]);
  });
});

describe('transcription never fabricates', () => {
  it('reports unavailable rather than returning an empty transcript', async () => {
    const provider = new UnavailableTranscriptionProvider();
    const result = await provider.transcribe({ filePath: 'C:/refs/ad.mp4' });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain('no transcription provider');
  });

  it('reports unavailable for an unscripted file rather than inventing speech', async () => {
    const provider = new MockTranscriptionProvider({});
    const result = await provider.transcribe({ filePath: 'C:/refs/ad.mp4' });
    expect(result.available).toBe(false);
  });

  it('returns scripted segments when genuinely produced', async () => {
    const provider = new MockTranscriptionProvider({
      'ad.mp4': [{ startSeconds: 0, endSeconds: 1, text: 'Download free' }],
    });
    const result = await provider.transcribe({ filePath: 'C:/refs/ad.mp4' });
    expect(result.available).toBe(true);
    if (result.available) expect(result.segments).toHaveLength(1);
  });

  it('drops malformed whisper segments instead of coercing them', () => {
    const parsed = parseWhisperJson(
      JSON.stringify({
        segments: [
          { start: 0, end: 1, text: 'kept' },
          { start: 1, end: 0.5, text: 'backwards' },
          { start: 2, end: 3, text: '   ' },
          { text: 'no timing' },
        ],
      }),
    );
    expect(parsed).toEqual([{ startSeconds: 0, endSeconds: 1, text: 'kept' }]);
  });
});

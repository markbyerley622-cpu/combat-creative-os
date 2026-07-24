import type { CommandRunner } from './command-runner';
import { probeMedia } from './ffprobe';
import { inspectMedia, type InspectMediaInput } from './inspect';
import { CorruptMediaError, type MediaProbeResult } from './types';

export interface ThumbnailRequest {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly timestampSeconds?: number;
  readonly widthPx?: number;
}

export interface ThumbnailResult {
  readonly outputPath: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

export const PROXY_PROFILES = ['PREVIEW_720P', 'PREVIEW_480P'] as const;
export type ProxyProfile = (typeof PROXY_PROFILES)[number];

const PROXY_PROFILE_WIDTHS: Record<ProxyProfile, number> = {
  PREVIEW_720P: 1280,
  PREVIEW_480P: 854,
};

export interface ProxyRequest {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly profile: ProxyProfile;
}

export interface ProxyResult {
  readonly outputPath: string;
  readonly durationSeconds: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * `FfmpegService` from docs/architecture.md §5 — deterministic, local,
 * content-addressed-by-caller output paths. Not a third-party "provider"
 * (no external account/API key) but shaped the same way as one so
 * activities inject it identically to `StorageProvider`/`ReasoningProvider`.
 */
export interface MediaProvider {
  readonly name: string;
  probe(input: InspectMediaInput): Promise<MediaProbeResult>;
  generateThumbnail(request: ThumbnailRequest): Promise<ThumbnailResult>;
  generateProxy(request: ProxyRequest): Promise<ProxyResult>;
}

export function createFfmpegMediaProvider(runner: CommandRunner): MediaProvider {
  return {
    name: 'ffmpeg',

    probe: (input) => inspectMedia(runner, input),

    async generateThumbnail(request: ThumbnailRequest): Promise<ThumbnailResult> {
      const timestampSeconds = request.timestampSeconds ?? 1;
      const width = request.widthPx ?? 640;
      const result = await runner.run('ffmpeg', [
        '-y',
        '-ss',
        String(timestampSeconds),
        '-i',
        request.sourcePath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${width}:-1`,
        request.outputPath,
      ]);
      if (result.exitCode !== 0) {
        throw new CorruptMediaError(result.stderr.trim() || 'ffmpeg thumbnail generation failed');
      }
      const probe = await probeMedia(runner, request.outputPath);
      if (probe.mediaType !== 'IMAGE') {
        throw new CorruptMediaError('ffmpeg thumbnail output was not a still image');
      }
      return { outputPath: request.outputPath, widthPx: probe.widthPx, heightPx: probe.heightPx };
    },

    async generateProxy(request: ProxyRequest): Promise<ProxyResult> {
      const width = PROXY_PROFILE_WIDTHS[request.profile];
      const result = await runner.run('ffmpeg', [
        '-y',
        '-i',
        request.sourcePath,
        '-vf',
        `scale=${width}:-1`,
        '-c:v',
        'libx264',
        '-crf',
        '23',
        '-c:a',
        'aac',
        request.outputPath,
      ]);
      if (result.exitCode !== 0) {
        throw new CorruptMediaError(result.stderr.trim() || 'ffmpeg proxy generation failed');
      }
      const probe = await probeMedia(runner, request.outputPath);
      if (probe.mediaType !== 'VIDEO') {
        throw new CorruptMediaError('ffmpeg proxy output was not a video');
      }
      return {
        outputPath: request.outputPath,
        durationSeconds: probe.durationSeconds,
        widthPx: probe.widthPx,
        heightPx: probe.heightPx,
      };
    },
  };
}

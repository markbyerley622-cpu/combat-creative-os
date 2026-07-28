import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import { StoryboardVideoError } from './failures';
import { canonicalFrameId, KEYFRAME_COUNT } from './keyframe-library';

/**
 * Clips the operator animated by hand, outside this pipeline.
 *
 * Frames 1 and 7 were animated through LTX Studio interactively and their MP4s
 * sit beside the keyframes. They are real, usable footage and there is no
 * reason to pay to produce them again — but where they came from is a
 * different fact from where a generated clip came from, and the two must never
 * be reported as the same thing.
 *
 * So the provenance is a separate, explicit value: `MANUAL_LTX_STUDIO`. It is
 * written into every artefact that mentions the clip, and nothing in this
 * repository may describe these files as having been produced by the AAMP LTX
 * provider. The distinction matters because the milestone's central claim is
 * about what *this pipeline* can do end to end, and counting a hand-made clip
 * toward that claim would make the claim untrue — the honest position is that
 * these scenes have footage and that the automated path did not produce it.
 *
 * A pre-generated clip is never regenerated. `--regenerate-scene` is the only
 * way to spend money on a scene that already has one.
 */

export const MANUAL_GENERATION_PROVENANCE = 'MANUAL_LTX_STUDIO' as const;
export const PROVIDER_GENERATION_PROVENANCE = 'AAMP_LTX_HOSTED_PROVIDER' as const;

export type GenerationProvenance =
  typeof MANUAL_GENERATION_PROVENANCE | typeof PROVIDER_GENERATION_PROVENANCE;

/** The directory, relative to the keyframes, where manual clips are expected. */
export const DEFAULT_PRE_GENERATED_SUBDIRECTORY = 'generated-clips';

const CLIP_EXTENSIONS: readonly string[] = ['.mp4', '.mov'];

const CLIP_STEM = /^frame-(\d{2})$/i;

export interface PreGeneratedClip {
  readonly sceneNumber: number;
  readonly frameId: string;
  readonly absolutePath: string;
  readonly fileName: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly durationSeconds: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly frameRate: number;
  readonly videoCodec: string;
  readonly hasAudio: boolean;
  /** Always `MANUAL_LTX_STUDIO`. This pipeline did not produce these bytes. */
  readonly provenance: typeof MANUAL_GENERATION_PROVENANCE;
}

export interface PreGeneratedClipLibrary {
  readonly directory: string;
  readonly present: boolean;
  readonly clips: readonly PreGeneratedClip[];
  readonly ignoredFiles: readonly string[];
}

export const EMPTY_PRE_GENERATED_LIBRARY: PreGeneratedClipLibrary = {
  directory: '',
  present: false,
  clips: [],
  ignoredFiles: [],
};

export interface ResolvePreGeneratedClipsOptions {
  readonly directory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  /** Refuse a clip that cannot cover this many seconds for its scene. */
  readonly requiredSecondsByScene: ReadonlyMap<number, number>;
}

/**
 * Reads the directory and validates every clip it recognises.
 *
 * An absent directory is not an error: a run with no manual clips is the
 * normal case, and the generative path covers it. What *is* an error is a
 * clip that exists and cannot be used — a truncated download, a still saved
 * with an `.mp4` extension, or a clip too short for the scene it claims. Those
 * are refused by name rather than skipped, because a silently skipped clip
 * would be re-generated at cost while the operator believed it had been
 * reused.
 */
export async function resolvePreGeneratedClips(
  options: ResolvePreGeneratedClipsOptions,
): Promise<PreGeneratedClipLibrary> {
  const directory = resolve(options.directory);

  const directoryStats = await stat(directory).catch(() => null);
  if (!directoryStats?.isDirectory()) {
    return { ...EMPTY_PRE_GENERATED_LIBRARY, directory };
  }

  const entries = await readdir(directory);
  const bySceneNumber = new Map<number, string[]>();
  const ignoredFiles: string[] = [];

  for (const entry of [...entries].sort()) {
    const extension = extname(entry).toLowerCase();
    const stem = entry.slice(0, entry.length - extension.length);
    const match = CLIP_STEM.exec(stem);
    if (!match || !CLIP_EXTENSIONS.includes(extension)) {
      ignoredFiles.push(entry);
      continue;
    }
    const sceneNumber = Number(match[1]);
    if (!Number.isInteger(sceneNumber) || sceneNumber < 1 || sceneNumber > KEYFRAME_COUNT) {
      ignoredFiles.push(entry);
      continue;
    }
    bySceneNumber.set(sceneNumber, [...(bySceneNumber.get(sceneNumber) ?? []), entry]);
  }

  const problems: string[] = [];
  const clips: PreGeneratedClip[] = [];

  for (const sceneNumber of [...bySceneNumber.keys()].sort((a, b) => a - b)) {
    const matches = bySceneNumber.get(sceneNumber) as string[];
    if (matches.length > 1) {
      problems.push(
        `${canonicalFrameId(sceneNumber)} is ambiguous: ${matches.join(', ')} all match. Leave exactly one.`,
      );
      continue;
    }
    const fileName = matches[0] as string;
    const absolutePath = join(directory, fileName);
    let measured;
    try {
      // eslint-disable-next-line no-await-in-loop -- ordered so the problem list is stable
      measured = await measureClip(absolutePath, options);
    } catch (error) {
      problems.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const required = options.requiredSecondsByScene.get(sceneNumber);
    if (required !== undefined && measured.durationSeconds + 1e-6 < required) {
      problems.push(
        `${fileName} runs ${measured.durationSeconds.toFixed(2)}s, short of the ${required.toFixed(2)}s scene ${sceneNumber} needs once transition handles are reserved. A short clip is never stretched to fit.`,
      );
      continue;
    }

    clips.push({
      sceneNumber,
      frameId: canonicalFrameId(sceneNumber),
      absolutePath,
      fileName,
      ...measured,
      provenance: MANUAL_GENERATION_PROVENANCE,
    });
  }

  if (problems.length > 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `pre-generated clips in ${directory} could not be used:\n${problems
        .map((problem) => `  - ${problem}`)
        .join(
          '\n',
        )}\n\nRefused rather than skipped: a skipped clip would be regenerated at cost while you believed it had been reused.`,
    );
  }

  return { directory, present: true, clips, ignoredFiles };
}

async function measureClip(
  absolutePath: string,
  options: ResolvePreGeneratedClipsOptions,
): Promise<{
  checksumSha256: string;
  sizeBytes: number;
  durationSeconds: number;
  widthPx: number;
  heightPx: number;
  frameRate: number;
  videoCodec: string;
  hasAudio: boolean;
}> {
  const stats = await stat(absolutePath).catch(() => null);
  if (!stats?.isFile() || stats.size === 0) {
    throw new Error('is not a readable, non-empty file');
  }

  const bytes = await readFile(absolutePath);
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');

  const probe = await options.runner.run(
    options.binaries.ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration',
      '-of',
      'json',
      absolutePath,
    ],
    { timeoutMs: 60_000 },
  );
  if (probe.exitCode !== 0) {
    throw new Error(`could not be probed: ${probe.stderr.trim().slice(-200)}`);
  }

  const parsed = JSON.parse(probe.stdout) as {
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
    }[];
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (!video?.width || !video.height) {
    throw new Error('has no readable video stream — a file that exists is not a clip');
  }
  const durationSeconds = Number(parsed.format?.duration ?? 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('reports no duration, so it is a still or a broken container, not footage');
  }

  return {
    checksumSha256,
    sizeBytes: bytes.byteLength,
    durationSeconds: Number(durationSeconds.toFixed(6)),
    widthPx: video.width,
    heightPx: video.height,
    frameRate: parseFrameRate(video.avg_frame_rate),
    videoCodec: video.codec_name ?? 'unknown',
    hasAudio: (parsed.streams ?? []).some((stream) => stream.codec_type === 'audio'),
  };
}

function parseFrameRate(raw: string | undefined): number {
  if (!raw) return 0;
  const [numerator, denominator] = raw.split('/').map(Number);
  if (!numerator || !denominator) return 0;
  return Number((numerator / denominator).toFixed(3));
}

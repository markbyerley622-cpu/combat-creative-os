import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';
import { z } from 'zod';

import { StoryboardVideoError } from './failures';

/**
 * The external footage acquisition pack, read strictly.
 *
 * The pack holds four very different kinds of file, and confusing any two of
 * them would put unusable or unlicensed material into a finished
 * advertisement:
 *
 * - `approved-free-originals/` — verified, full-resolution, rights-cleared
 *   originals. **The only render sources in the pack.**
 * - `candidates/free-previews/` — provider preview renditions. Low bitrate,
 *   often watermarked, and *not acquired*: no original was downloaded and no
 *   rights position was established for the file on disk.
 * - `candidates/contact-sheets/` — six-frame JPEG strips for human review.
 * - `metadata/`, `reports/`, `shortlists/` — descriptions of all of the above.
 *
 * **Previews and contact sheets are refused by location, before any
 * declaration is consulted**, which is the same structural rule
 * `asset-root-preflight` applies to `references/`. A preview that a report
 * described as approved would otherwise be one edited row away from shipping,
 * and the row is the thing being checked.
 *
 * The pack is read-only, always. Nothing here writes, renames, moves or
 * deletes inside it, every path is resolved *and* re-checked for containment,
 * and every checksum is recalculated rather than read.
 */

/** Directories whose contents may never be a render source, whatever a report says. */
export const REFUSED_BY_LOCATION: readonly string[] = [
  'candidates',
  'work',
  'shortlists',
  'generation-briefs',
  'brief',
];

/** The only directory an original may come from. */
export const APPROVED_ORIGINALS_DIRECTORY = 'approved-free-originals';
export const ACQUISITION_EVIDENCE_DIRECTORY = 'acquisition-evidence';

const VIDEO_EXTENSIONS: readonly string[] = ['.mp4', '.mov', '.m4v', '.webm'];

/**
 * The machine-readable half of the pack.
 *
 * The ingestion map is Markdown for a person to read; the evidence JSON is
 * what a program is entitled to trust. Parsing the Markdown table would make
 * the pipeline depend on a document's formatting, and a reformatted heading
 * would silently drop an asset.
 */
const AcquisitionEvidenceSchema = z
  .object({
    asset_id: z.string().min(1),
    role: z.string().min(1),
    provider: z.string().min(1),
    source_page: z.string().min(1),
    creator: z.string().min(1),
    licence: z.string().min(1),
    local_path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    size_bytes: z.number().int().positive(),
    authorised_download_url_persisted: z.literal(false),
    visual_review_score: z.number().optional(),
    watermark_present: z.boolean().optional(),
    technical: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        frame_rate: z.number().positive(),
        video_codec: z.string().min(1),
        audio_codec: z.string().optional(),
        duration_s: z.number().positive(),
        pix_fmt: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface AcquiredOriginal {
  readonly assetId: string;
  /** The pack's own role vocabulary, e.g. `BOXING_ACTION`. */
  readonly role: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  /** Recalculated from the bytes, never read from the evidence file. */
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  /** Measured with ffprobe. The evidence file's numbers are a declaration. */
  readonly measured: {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly durationSeconds: number;
    readonly frameRate: number;
    readonly videoCodec: string;
    readonly hasAudio: boolean;
  };
  /** What the evidence file declared, kept beside the measurement so a disagreement is visible. */
  readonly declared: {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly durationSeconds: number;
  };
  readonly discrepancies: readonly string[];
  readonly provider: string;
  readonly creator: string;
  readonly licence: string;
  readonly sourcePage: string;
  readonly visualReviewScore: number | null;
  readonly watermarkPresent: boolean | null;
}

export interface FootagePack {
  readonly packRoot: string;
  readonly originals: readonly AcquiredOriginal[];
  /** Files found under a refused directory, counted so the report can say so. */
  readonly refusedByLocationCount: number;
  /** Roles the pack reserved but never filled, from the map's own brief placeholders. */
  readonly unfilledRoles: readonly string[];
  readonly ingestionMapPresent: boolean;
}

function containedIn(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation);
}

export interface ReadFootagePackOptions {
  readonly packRoot: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
}

/**
 * Reads the pack and returns only what may legally be rendered.
 *
 * An absent pack is a recorded finding rather than an error — a run that has
 * no acquired footage still has the LTX path and the deterministic path, and
 * refusing to start would be a guard on the wrong thing.
 */
export async function readFootagePack(options: ReadFootagePackOptions): Promise<FootagePack> {
  const packRoot = resolve(options.packRoot);
  const stats = await stat(packRoot).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new StoryboardVideoError(
      'NO_USABLE_SOURCE',
      `the footage pack ${packRoot} is not a readable directory`,
    );
  }

  const refusedByLocationCount = await countRefusedByLocation(packRoot);
  const evidenceByPath = await readEvidence(packRoot);

  const originalsDirectory = join(packRoot, APPROVED_ORIGINALS_DIRECTORY);
  let entries: string[] = [];
  try {
    entries = await readdir(originalsDirectory);
  } catch {
    entries = [];
  }

  const originals: AcquiredOriginal[] = [];
  for (const entry of [...entries].sort()) {
    const absolutePath = join(originalsDirectory, entry);
    if (!containedIn(packRoot, absolutePath)) continue;
    const extension = entry.slice(entry.lastIndexOf('.')).toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(extension)) continue;

    const evidence = evidenceByPath.get(normalisePath(absolutePath));
    if (!evidence) {
      // An original with no evidence file has no established rights position.
      // Skipped rather than thrown: the pack is the operator's, and a stray
      // file in it is not a reason to refuse the whole run.
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- deterministic order
    const bytes = await readFile(absolutePath);
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    if (checksumSha256 !== evidence.sha256.toLowerCase()) {
      throw new StoryboardVideoError(
        'NO_USABLE_SOURCE',
        `${evidence.asset_id} hashes to ${checksumSha256.slice(0, 16)}… but its acquisition evidence declares ${evidence.sha256.slice(0, 16).toLowerCase()}…. The file on disk is not the file that was cleared.`,
      );
    }

    // eslint-disable-next-line no-await-in-loop -- deterministic order
    const measured = await probeVideo(absolutePath, options);
    const discrepancies: string[] = [];
    if (measured.widthPx !== evidence.technical.width) {
      discrepancies.push(
        `declared width ${evidence.technical.width}px, measured ${measured.widthPx}px`,
      );
    }
    if (measured.heightPx !== evidence.technical.height) {
      discrepancies.push(
        `declared height ${evidence.technical.height}px, measured ${measured.heightPx}px`,
      );
    }
    if (Math.abs(measured.durationSeconds - evidence.technical.duration_s) > 0.05) {
      discrepancies.push(
        `declared duration ${evidence.technical.duration_s}s, measured ${measured.durationSeconds.toFixed(2)}s`,
      );
    }

    originals.push({
      assetId: evidence.asset_id,
      role: evidence.role,
      absolutePath,
      relativePath: relative(packRoot, absolutePath).split(sep).join('/'),
      checksumSha256,
      sizeBytes: bytes.byteLength,
      measured,
      declared: {
        widthPx: evidence.technical.width,
        heightPx: evidence.technical.height,
        durationSeconds: evidence.technical.duration_s,
      },
      discrepancies,
      provider: evidence.provider,
      creator: evidence.creator,
      licence: evidence.licence,
      sourcePage: evidence.source_page,
      visualReviewScore: evidence.visual_review_score ?? null,
      watermarkPresent: evidence.watermark_present ?? null,
    });
  }

  const ingestionMapPresent = await stat(join(packRoot, 'reports', 'aamp-ingestion-map.md'))
    .then(() => true)
    .catch(() => false);

  return {
    packRoot,
    originals,
    refusedByLocationCount,
    unfilledRoles: await readUnfilledRoles(packRoot),
    ingestionMapPresent,
  };
}

/**
 * Counts every media file sitting under a refused directory.
 *
 * Counted rather than merely skipped, because "we did not use any previews" is
 * a claim, and a number a reader can compare against the pack's own contents
 * is evidence.
 */
async function countRefusedByLocation(packRoot: string): Promise<number> {
  let count = 0;
  for (const directory of REFUSED_BY_LOCATION) {
    // eslint-disable-next-line no-await-in-loop -- deterministic order
    count += await countMediaRecursive(join(packRoot, directory));
  }
  return count;
}

async function countMediaRecursive(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop -- depth-first, deterministic
      count += await countMediaRecursive(child);
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
    if (VIDEO_EXTENSIONS.includes(extension) || ['.jpg', '.jpeg', '.png'].includes(extension)) {
      count += 1;
    }
  }
  return count;
}

async function readEvidence(
  packRoot: string,
): Promise<Map<string, z.infer<typeof AcquisitionEvidenceSchema>>> {
  const directory = join(packRoot, ACQUISITION_EVIDENCE_DIRECTORY);
  const byPath = new Map<string, z.infer<typeof AcquisitionEvidenceSchema>>();
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return byPath;
  }
  for (const entry of [...entries].sort()) {
    if (!entry.toLowerCase().endsWith('.json')) continue;
    // eslint-disable-next-line no-await-in-loop -- deterministic order
    const text = await readFile(join(directory, entry), 'utf8');
    let parsed;
    try {
      parsed = AcquisitionEvidenceSchema.safeParse(JSON.parse(text));
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    // The evidence file's own `local_path` is where it claims the bytes are.
    // It is only ever used as a key — the file this run actually reads is the
    // one it found by walking `approved-free-originals/`.
    byPath.set(normalisePath(resolve(parsed.data.local_path)), parsed.data);
  }
  return byPath;
}

/**
 * The roles the pack reserved and never filled, taken from the ingestion map's
 * own `CRF02-<ROLE>-BRIEF` placeholders.
 *
 * Read with a narrow regular expression over the whole document rather than by
 * parsing its table structure: the placeholder id is a stable, machine-shaped
 * token, and a reformatted table should not change what this returns.
 */
async function readUnfilledRoles(packRoot: string): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(join(packRoot, 'reports', 'aamp-ingestion-map.md'), 'utf8');
  } catch {
    return [];
  }
  const roles = new Set<string>();
  for (const match of text.matchAll(/CRF02-([A-Z0-9_]+)-BRIEF/g)) {
    if (match[1]) roles.add(match[1]);
  }
  return [...roles].sort();
}

function normalisePath(value: string): string {
  return value.split(sep).join('/').toLowerCase();
}

async function probeVideo(
  absolutePath: string,
  options: ReadFootagePackOptions,
): Promise<AcquiredOriginal['measured']> {
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
    throw new StoryboardVideoError(
      'NO_USABLE_SOURCE',
      `${absolutePath} could not be probed: ${probe.stderr.trim().slice(-300)}`,
    );
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
    throw new StoryboardVideoError(
      'NO_USABLE_SOURCE',
      `${absolutePath} has no readable video stream — it is not a usable render source`,
    );
  }
  return {
    widthPx: video.width,
    heightPx: video.height,
    durationSeconds: Number(parsed.format?.duration ?? 0),
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

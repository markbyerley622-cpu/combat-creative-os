import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import {
  DEFAULT_FFMPEG_BINARIES,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_RENDER_TIMEOUT_MS,
  type FfmpegBinaries,
} from '../binaries';
import type { CommandRunner } from '../command-runner';
import {
  failedChecks,
  runActualMediaQa,
  type ActualMediaQaReport,
  type StoryboardExpectation,
} from '../qa/actual-media-qa';
import { buildRenderPlan, type RenderPlan } from './filter-graph';
import type { RenderManifest } from './manifest';
import { assertReadableNonEmptyFile, assertWritableOutputPath } from './paths';
import { resolveManifestSources, sha256File, type ResolvedSource } from './source-resolution';

/**
 * The render invocation: resolve sources under the licensing gate, build the
 * FFmpeg plan, execute it inside a job-scoped temporary directory, measure
 * the produced file, and place it according to what the measurements say.
 *
 * A render that fails a binding QA check never lands in the deliverable
 * directory — it goes to `rejected/` with its report, and its asset record
 * carries `FAILED`. That is the mechanism behind "a failed QA never becomes
 * READY": the deliverable path is only reachable through a passing report.
 */

export const RENDER_ACTIVITY_NAME = 'ffmpeg-composition-render';

export class RenderFailedError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly stderrTail: string,
  ) {
    super(`FFmpeg render failed with exit code ${exitCode}:\n${stderrTail}`);
    this.name = 'RenderFailedError';
  }
}

export interface RenderedSourceProvenance {
  readonly sourceId: string;
  readonly description: string;
  readonly absolutePath: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly usageClass: string;
  readonly rightsHolder: string;
  readonly licenseType: string;
  readonly expiresAt?: string;
  readonly attribution?: string;
  readonly restrictions: readonly string[];
}

/**
 * Mirrors `@combat/domain`'s `Asset` + `AssetProvenance` shape without
 * importing it — the same structural-compatibility arrangement
 * `MediaMetadataSchema` already uses in the other direction. A repository
 * write is a persistence concern for whichever composition root owns a live
 * database; this package produces the record, not the row.
 */
export interface RenderedAssetRecord {
  readonly assetId: string;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly kind: 'FINAL_MASTER';
  readonly storageKey: string;
  readonly checksum: string;
  readonly mimeType: string;
  readonly originalFilename: string;
  readonly sizeBytes: number;
  readonly ingestionStatus: 'READY' | 'FAILED';
  readonly mediaMetadata: {
    readonly mediaType: 'VIDEO';
    readonly durationSeconds: number;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly frameRate: number;
    readonly videoCodec: string;
    readonly hasAudio: boolean;
    readonly audioCodec?: string;
  } | null;
  readonly generatedByActivity: string;
  readonly provenance: {
    readonly renderKey: string;
    readonly idempotencyKey: string;
    readonly manifestChecksum: string;
    readonly manifestVersion: number;
    readonly deliveryProfileKey: string;
    readonly deliveryProfileVersion: number;
    readonly derivedFromSources: readonly RenderedSourceProvenance[];
    readonly qaReportPath: string;
    readonly renderedAt: string;
  };
}

export interface RenderResult {
  readonly status: 'READY' | 'QA_FAILED';
  readonly outputPath: string;
  readonly qaReportPath: string;
  readonly qaReport: ActualMediaQaReport;
  readonly asset: RenderedAssetRecord;
  readonly renderKey: string;
  readonly idempotencyKey: string;
  /** True when an identical previous render was found and re-used rather than re-encoded. */
  readonly reused: boolean;
  readonly plan: RenderPlan;
}

export interface RenderRequest {
  readonly manifest: RenderManifest;
  /** Relative source paths resolve against this — normally the manifest file's directory. */
  readonly manifestDir: string;
  readonly allowedSourceRoots: readonly string[];
  /** Every artefact this render produces lives under here and nowhere else. */
  readonly outputRoot: string;
  readonly binaries?: FfmpegBinaries;
  readonly renderTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Supplied by the caller so the render stays a pure function of its inputs. */
  readonly now: Date;
  /** Overrides the derived key; a caller with its own idempotency scheme (an Activity) supplies it. */
  readonly idempotencyKey?: string;
  /** Default true: an identical completed render short-circuits instead of re-encoding. */
  readonly reuseExisting?: boolean;
  /**
   * Extra binding checks the caller can hold this render to.
   *
   * A storyboard and a set of resolved source checksums are things only the
   * composition root knows — this package has no idea what a run promised
   * before it called in. Passing them through rather than having QA go looking
   * keeps QA a function of the file plus what it was told, and keeps
   * `@combat/media` free of any opinion about where a run keeps its artefacts.
   */
  readonly qa?: {
    readonly storyboard?: StoryboardExpectation;
    readonly expectedSourceChecksums?: readonly string[];
  };
}

const REJECTED_SUBDIRECTORY = 'rejected';
const JOBS_SUBDIRECTORY = '.jobs';

export async function renderAdvertisement(
  runner: CommandRunner,
  request: RenderRequest,
): Promise<RenderResult> {
  const { manifest } = request;
  const binaries = request.binaries ?? DEFAULT_FFMPEG_BINARIES;

  const sources = await resolveManifestSources(runner, manifest, {
    baseDir: request.manifestDir,
    allowedRoots: request.allowedSourceRoots,
    ffprobePath: binaries.ffprobe,
    probeTimeoutMs: request.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    signal: request.signal,
    asOf: request.now,
  });

  const plan = buildRenderPlan({ manifest, sources });
  const manifestChecksum = hashManifest(manifest);
  const renderKey = computeRenderKey(sources, plan, manifestChecksum);
  const idempotencyKey = request.idempotencyKey ?? renderKey;

  const outputFilename = `${manifest.name}-${renderKey.slice(0, 16)}.mp4`;
  const readyPath = join(request.outputRoot, outputFilename);
  const rejectedPath = join(request.outputRoot, REJECTED_SUBDIRECTORY, outputFilename);

  if (request.reuseExisting !== false) {
    const existing = await tryReuse(readyPath, renderKey, idempotencyKey, plan);
    if (existing) return existing;
  }

  await mkdir(request.outputRoot, { recursive: true });
  const jobDir = join(request.outputRoot, JOBS_SUBDIRECTORY, idempotencyKey.slice(0, 32));
  // A fresh job directory every attempt: a retry must never inherit a
  // half-written frame dump or a stale caption file from the attempt before.
  await rm(jobDir, { recursive: true, force: true });
  await mkdir(jobDir, { recursive: true });

  try {
    for (const file of plan.jobFiles) {
      await writeFile(join(jobDir, file.name), file.contents, 'utf8');
    }

    const result = await runner.run(binaries.ffmpeg, plan.args, {
      cwd: jobDir,
      timeoutMs: request.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
      signal: request.signal,
    });
    if (result.exitCode !== 0) {
      throw new RenderFailedError(result.exitCode, result.stderr.trim());
    }

    const renderedPath = join(jobDir, plan.outputFileName);
    await assertReadableNonEmptyFile(renderedPath);

    const qaReport = await runActualMediaQa(runner, {
      outputPath: renderedPath,
      manifest,
      workDir: jobDir,
      ffmpegPath: binaries.ffmpeg,
      ffprobePath: binaries.ffprobe,
      timeoutMs: request.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      signal: request.signal,
      measuredAt: request.now,
      ...(request.qa?.storyboard ? { storyboard: request.qa.storyboard } : {}),
      ...(request.qa?.expectedSourceChecksums
        ? { expectedSourceChecksums: request.qa.expectedSourceChecksums }
        : {}),
    });

    const passed = qaReport.verdict === 'PASS';
    const destination = passed ? readyPath : rejectedPath;
    await mkdir(dirname(destination), { recursive: true });
    await assertWritableOutputPath({
      outputPath: destination,
      outputRoot: request.outputRoot,
      // A re-render of the same content is allowed to replace its own
      // previous artefact; `renderKey` is in the filename, so this can only
      // ever replace a byte-equivalent render, never an unrelated file.
      allowReplace: true,
    });
    await rename(renderedPath, destination);

    const finalReport: ActualMediaQaReport = { ...qaReport, outputPath: destination };
    const qaReportPath = `${destination}.qa.json`;
    await writeFile(qaReportPath, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');

    const asset = await buildAssetRecord({
      manifest,
      sources,
      report: finalReport,
      destination,
      outputRoot: request.outputRoot,
      renderKey,
      idempotencyKey,
      manifestChecksum,
      qaReportPath,
      renderedAt: request.now,
      passed,
    });

    await writeFile(`${destination}.asset.json`, `${JSON.stringify(asset, null, 2)}\n`, 'utf8');

    return {
      status: passed ? 'READY' : 'QA_FAILED',
      outputPath: destination,
      qaReportPath,
      qaReport: finalReport,
      asset,
      renderKey,
      idempotencyKey,
      reused: false,
      plan,
    };
  } finally {
    // Temporary files never outlive the invocation, on either path. The
    // produced MP4 has already been moved out by this point on success; on
    // failure the diagnosis is in the thrown error's stderr tail, not in a
    // directory left behind to accumulate.
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    // And the shared parent goes too once the last concurrent job has left,
    // so a completed render leaves no trace in the output root but its
    // deliverables. `rmdir` fails harmlessly while another job holds it.
    await rmdir(join(request.outputRoot, JOBS_SUBDIRECTORY)).catch(() => undefined);
  }
}

/**
 * An identical manifest over identical source bytes produces an identical
 * `renderKey`, so a completed render can be recognised and returned without
 * re-encoding. This is what makes a retried Activity attempt cheap rather
 * than duplicative.
 */
async function tryReuse(
  readyPath: string,
  renderKey: string,
  idempotencyKey: string,
  plan: RenderPlan,
): Promise<RenderResult | null> {
  const qaReportPath = `${readyPath}.qa.json`;
  const assetPath = `${readyPath}.asset.json`;
  try {
    await assertReadableNonEmptyFile(readyPath);
    const [reportRaw, assetRaw] = await Promise.all([
      readJson<ActualMediaQaReport>(qaReportPath),
      readJson<RenderedAssetRecord>(assetPath),
    ]);
    if (!reportRaw || !assetRaw || reportRaw.verdict !== 'PASS') return null;
    return {
      status: 'READY',
      outputPath: readyPath,
      qaReportPath,
      qaReport: reportRaw,
      asset: assetRaw,
      renderKey,
      idempotencyKey,
      reused: true,
      plan,
    };
  } catch {
    return null;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface BuildAssetRecordInput {
  readonly manifest: RenderManifest;
  readonly sources: ReadonlyMap<string, ResolvedSource>;
  readonly report: ActualMediaQaReport;
  readonly destination: string;
  readonly outputRoot: string;
  readonly renderKey: string;
  readonly idempotencyKey: string;
  readonly manifestChecksum: string;
  readonly qaReportPath: string;
  readonly renderedAt: Date;
  readonly passed: boolean;
}

async function buildAssetRecord(input: BuildAssetRecordInput): Promise<RenderedAssetRecord> {
  const { manifest, report } = input;
  const checksum = report.summary.checksumSha256 || (await sha256File(input.destination));

  const derivedFromSources: RenderedSourceProvenance[] = [...input.sources.values()].map(
    (source) => ({
      sourceId: source.id,
      description: source.description,
      absolutePath: source.absolutePath,
      checksumSha256: source.checksumSha256,
      sizeBytes: source.sizeBytes,
      usageClass: source.license.usageClass,
      rightsHolder: source.license.rightsHolder,
      licenseType: source.license.licenseType,
      ...(source.license.expiresAt ? { expiresAt: source.license.expiresAt } : {}),
      ...(source.license.attribution ? { attribution: source.license.attribution } : {}),
      restrictions: source.license.restrictions,
    }),
  );

  const storageKey = relative(input.outputRoot, input.destination).split(sep).join('/');

  return {
    assetId: deterministicUuid(`asset:${input.renderKey}`),
    workspaceId: manifest.workspaceId,
    campaignId: manifest.campaignId,
    kind: 'FINAL_MASTER',
    storageKey,
    checksum,
    mimeType: 'video/mp4',
    originalFilename: basename(input.destination),
    sizeBytes: report.summary.sizeBytes,
    ingestionStatus: input.passed ? 'READY' : 'FAILED',
    mediaMetadata:
      report.summary.widthPx && report.summary.heightPx && report.summary.videoCodec
        ? {
            mediaType: 'VIDEO',
            durationSeconds: report.summary.durationSeconds ?? 0,
            widthPx: report.summary.widthPx,
            heightPx: report.summary.heightPx,
            frameRate: report.summary.frameRate ?? 0,
            videoCodec: report.summary.videoCodec,
            hasAudio: report.summary.audioCodec !== null,
            ...(report.summary.audioCodec ? { audioCodec: report.summary.audioCodec } : {}),
          }
        : null,
    generatedByActivity: RENDER_ACTIVITY_NAME,
    provenance: {
      renderKey: input.renderKey,
      idempotencyKey: input.idempotencyKey,
      manifestChecksum: input.manifestChecksum,
      manifestVersion: manifest.manifestVersion,
      deliveryProfileKey: manifest.output.deliveryProfileKey,
      deliveryProfileVersion: manifest.output.deliveryProfileVersion,
      derivedFromSources,
      qaReportPath: input.qaReportPath,
      renderedAt: input.renderedAt.toISOString(),
    },
  };
}

export function hashManifest(manifest: RenderManifest): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

/**
 * Content address for one render: the manifest, the exact bytes of every
 * source, and the FFmpeg argv actually built. A change to any of the three
 * is a different render; a change to none is the same one.
 */
export function computeRenderKey(
  sources: ReadonlyMap<string, ResolvedSource>,
  plan: RenderPlan,
  manifestChecksum: string,
): string {
  const sourceDigest = [...sources.values()]
    .map((source) => `${source.id}:${source.checksumSha256}`)
    .sort()
    .join('|');
  return createHash('sha256')
    .update(
      canonicalJson({
        manifestChecksum,
        sourceDigest,
        // The paths differ per machine; the graph does not.
        filterComplex: plan.filterComplex,
        encoderArgs: plan.args.filter((arg) => !arg.includes(sep)),
      }),
    )
    .digest('hex');
}

/** Key-sorted JSON, so an equivalent object always hashes the same. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

/** A UUID-shaped, stable identifier derived from a content key — no clock, no randomness. */
export function deterministicUuid(seed: string): string {
  const hash = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  const seventh = bytes[6] ?? 0;
  const ninth = bytes[8] ?? 0;
  bytes[6] = (seventh & 0x0f) | 0x40;
  bytes[8] = (ninth & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export { failedChecks };

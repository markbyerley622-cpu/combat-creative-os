import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import {
  NodeCommandRunner,
  buildContactSheet,
  extractStoryboardFrames,
  probeMedia,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';

import {
  AppCaptureSessionSchema,
  CapturedAppAssetSchema,
  viewportFor,
  type AppCaptureSession,
  type AppCaptureSpecification,
  type CaptureFailure,
  type CaptureRedactionReport,
  type CapturedAppAsset,
} from './capture-contracts';
import { assertCaptureArtefactSafe } from './capture-safety';
import type { CaptureRunResult } from './playwright-capture';
import type { RightsDecision } from './rights-declaration';

/**
 * Turning bytes from a browser into assets the existing pipeline will accept.
 *
 * The properties that matter here are the ones a screenshot pipeline gets
 * wrong quietly. A PNG that is really an error page is 4 KB of valid PNG. A
 * second capture of a page that failed to load is byte-identical to the first,
 * and a manifest listing the same bytes under two ids defeats the selector's
 * spread across the library without anything looking broken. Both are refused
 * here, by measurement, before anything downstream sees them.
 *
 * Filenames are content-addressed — `<assetId>-<first 16 of sha256>.png` — so
 * a re-capture that produced identical bytes lands on the same path and a
 * re-capture that produced different bytes lands on a new one. Nothing is ever
 * silently overwritten with different content.
 */

/** Directory inside the capture output root that holds the images. */
export const CAPTURE_IMAGE_DIRECTORY = 'app-ui';

export const CAPTURE_SESSION_FILENAME = 'capture-session.json';
export const CAPTURE_REPORT_FILENAME = 'capture-report.json';
export const REDACTION_REPORT_FILENAME = 'redaction-report.json';
export const CAPTURED_ASSETS_FILENAME = 'captured-assets.json';
export const CAPTURE_CONTACT_SHEET_FILENAME = 'capture-contact-sheet.png';
const CAPTURE_FRAME_DIRECTORY = '.capture-frames';

/**
 * The delivery is 1080 wide, and the renderer's minimum-width floor for a
 * full-frame role is 640. A screenshot below that is a thumbnail or an error
 * page, not a screen.
 */
export const MINIMUM_CAPTURE_WIDTH_PX = 640;
export const MINIMUM_CAPTURE_BYTES = 2_048;

export class CaptureIngestionError extends Error {
  constructor(public readonly problems: readonly CaptureFailure[]) {
    super(
      `Captured screenshots could not be ingested:\n${problems
        .map((problem) => `  - ${problem.assetId} [${problem.kind}]: ${problem.detail}`)
        .join('\n')}`,
    );
    this.name = 'CaptureIngestionError';
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

export interface IngestCapturesOptions {
  readonly specification: AppCaptureSpecification;
  readonly run: CaptureRunResult;
  readonly rights: RightsDecision;
  readonly outputDirectory: string;
  readonly capturedAt: Date;
  readonly binaries?: FfmpegBinaries;
  readonly runner?: CommandRunner;
}

export interface IngestCapturesResult {
  readonly assets: readonly CapturedAppAsset[];
  readonly problems: readonly CaptureFailure[];
}

/**
 * Writes, measures and describes every captured image.
 *
 * All-or-nothing, matching `runAssetRootPreflight`: a library where one screen
 * came back as an error page is a library to re-capture, and quietly keeping
 * the survivors produces an advertisement missing a screen somebody asked for.
 */
export async function ingestCaptures(
  options: IngestCapturesOptions,
): Promise<IngestCapturesResult> {
  const runner = options.runner ?? new NodeCommandRunner();
  const imageDirectory = join(options.outputDirectory, CAPTURE_IMAGE_DIRECTORY);
  await mkdir(imageDirectory, { recursive: true });

  const problems: CaptureFailure[] = [];
  const assets: CapturedAppAsset[] = [];
  const seenChecksums = new Map<string, string>();

  for (const image of options.run.images) {
    const reject = (detail: string): void => {
      problems.push({ kind: 'INGESTION_FAILURE', assetId: image.assetId, detail });
    };

    if (image.pngBytes.length < MINIMUM_CAPTURE_BYTES) {
      reject(
        `the screenshot is ${image.pngBytes.length} bytes, below the ${MINIMUM_CAPTURE_BYTES}-byte floor. A page that failed to render still produces a valid, tiny PNG.`,
      );
      continue;
    }

    const checksumSha256 = sha256(image.pngBytes);
    const duplicateOf = seenChecksums.get(checksumSha256);
    if (duplicateOf) {
      reject(
        `these bytes are identical to "${duplicateOf}". Two screens that photograph the same pixels are usually one screen that never changed, and the same file under two ids defeats the selector's spread across the library.`,
      );
      continue;
    }
    seenChecksums.set(checksumSha256, image.assetId);

    const fileName = `${image.assetId}-${checksumSha256.slice(0, 16)}.png`;
    const absolutePath = join(imageDirectory, fileName);

    // Content-addressed, so an existing file with this name holds these bytes
    // by construction. Verified rather than assumed: a truncated earlier write
    // would otherwise be reused as if it were the capture.
    const existing = await readIfPresent(absolutePath);
    if (existing && sha256(existing) !== checksumSha256) {
      reject(
        `${fileName} already exists with different content; refusing to overwrite it. Remove the stale file and re-capture.`,
      );
      continue;
    }
    if (!existing) {
      await writeAtomically(absolutePath, image.pngBytes);
    }

    let probe;
    try {
      probe = await probeMedia(runner, absolutePath, {
        ...(options.binaries?.ffprobe ? { ffprobePath: options.binaries.ffprobe } : {}),
      });
    } catch (error) {
      reject(
        `ffprobe could not decode the screenshot: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (probe.mediaType !== 'IMAGE') {
      reject(`the written file decodes as ${probe.mediaType}, not an image`);
      continue;
    }
    if (probe.widthPx < MINIMUM_CAPTURE_WIDTH_PX) {
      reject(
        `${probe.widthPx}×${probe.heightPx} is below the ${MINIMUM_CAPTURE_WIDTH_PX}px minimum width a 1080-wide delivery needs`,
      );
      continue;
    }

    const preset = viewportFor(image.viewport);
    const stats = await stat(absolutePath);

    assets.push(
      CapturedAppAssetSchema.parse({
        assetId: image.assetId,
        role: image.screen.role,
        eligibility: options.rights.eligibility,
        rightsClassification: options.rights.classification,
        rightsBasis: options.rights.basis,
        relativePath: posix(relative(options.outputDirectory, absolutePath)),
        checksumSha256,
        widthPx: probe.widthPx,
        heightPx: probe.heightPx,
        format: probe.format,
        sizeBytes: stats.size,
        provenance: {
          sourceHost: image.sourceHost,
          sourcePath: image.sourcePath,
          queryPresent: image.queryPresent,
          capturedAt: options.capturedAt.toISOString(),
          viewport: image.viewport,
          viewportWidthCssPx: preset.widthCssPx,
          viewportHeightCssPx: preset.heightCssPx,
          deviceScaleFactor: preset.deviceScaleFactor,
          specificationVersion: options.specification.specificationVersion,
          specificationName: options.specification.name,
          rightsDeclarationVersion: options.rights.declarationVersion,
          browserEngine: options.run.browserEngine,
          browserVersion: options.run.browserVersion,
          playwrightVersion: options.run.playwrightVersion,
          redactedElementCount: image.redaction.totalElementsRedacted,
          croppedToSelector: image.croppedToSelector,
        },
      }),
    );
  }

  return { assets, problems };
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** Write via a temporary file and a rename: a half-written PNG is still a PNG. */
async function writeAtomically(target: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.partial`);
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

export interface WriteCaptureArtefactsOptions {
  readonly specification: AppCaptureSpecification;
  readonly run: CaptureRunResult;
  readonly rights: RightsDecision;
  readonly assets: readonly CapturedAppAsset[];
  readonly problems: readonly CaptureFailure[];
  readonly outputDirectory: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly binaries?: FfmpegBinaries;
  readonly runner?: CommandRunner;
}

export interface WriteCaptureArtefactsResult {
  readonly session: AppCaptureSession;
  readonly artefacts: readonly string[];
  readonly contactSheetPath: string | null;
  readonly contactSheetProblem: string | null;
}

/**
 * Writes the four reports and the contact sheet.
 *
 * Every one is passed through `assertCaptureArtefactSafe` before it reaches
 * the disk. That check is the reason the reports carry counts and selectors
 * rather than content: there is no field here that could hold a comment, a
 * name or a header, and the walker fails closed if one is ever added.
 */
export async function writeCaptureArtefacts(
  options: WriteCaptureArtefactsOptions,
): Promise<WriteCaptureArtefactsResult> {
  const host = new URL(options.specification.baseUrl).hostname.toLowerCase();

  const session: AppCaptureSession = AppCaptureSessionSchema.parse({
    sessionVersion: 1,
    specificationName: options.specification.name,
    specificationVersion: options.specification.specificationVersion,
    host,
    startedAt: options.startedAt.toISOString(),
    completedAt: options.completedAt.toISOString(),
    rightsMode: options.rights.mode,
    rightsDeclarationVersion: options.rights.declarationVersion,
    rightsDeclaredBy: options.rights.declaredBy,
    rightsExpiresAt: options.rights.expiresAt,
    screensRequested: options.specification.screens.length,
    screensEnabled: options.run.screensEnabled,
    screensCaptured: options.assets.length,
    screensSkippedDisabled: [...options.run.skippedDisabled],
    assets: options.assets,
    failures: [...options.run.failures, ...options.problems],
    blockedRequests: options.run.blockedRequests,
    totalElementsRedacted: options.run.images.reduce(
      (total, image) => total + image.redaction.totalElementsRedacted,
      0,
    ),
    browserEngine: options.run.browserEngine,
    browserVersion: options.run.browserVersion,
    playwrightVersion: options.run.playwrightVersion,
    requiresHumanApproval: true,
    paidProviderCalls: 0,
    notice: options.rights.notice,
  });

  const redactionReports: readonly CaptureRedactionReport[] = options.run.images.map(
    (image) => image.redaction,
  );

  const captureReport = {
    reportVersion: 1,
    specificationName: options.specification.name,
    host,
    readOnly: true,
    permittedMethods: ['GET', 'HEAD'],
    blockedRequests: options.run.blockedRequests,
    blockedRequestTotal: options.run.blockedRequests.reduce(
      (total, entry) => total + entry.count,
      0,
    ),
    screens: options.specification.screens.map((screen) => ({
      assetId: screen.assetId,
      role: screen.role,
      enabled: !options.run.skippedDisabled.includes(screen.assetId),
      required: screen.required,
      viewport: screen.viewport,
      readinessSelector: screen.readinessSelector,
      cropSelector: screen.cropSelector ?? null,
      navigationSteps: screen.navigation.map((step) => step.kind),
      captured: options.assets.some((asset) => asset.assetId === screen.assetId),
    })),
    failures: [...options.run.failures, ...options.problems],
    notice: options.rights.notice,
    paidProviderCalls: 0,
  };

  const redactionDocument = {
    reportVersion: 1,
    specificationName: options.specification.name,
    userContentPolicy:
      'User-written content is redacted on every screen whose role is not APP_DISCUSSION_SANITISED. That role is disabled unless a specification enables it by name.',
    screens: redactionReports,
    totalElementsRedacted: session.totalElementsRedacted,
  };

  const capturedAssetsDocument = {
    documentVersion: 1,
    library: options.specification.library,
    host,
    rightsMode: options.rights.mode,
    eligibility: options.rights.eligibility,
    notice: options.rights.notice,
    assets: options.assets,
  };

  const written: string[] = [];
  for (const [filename, document] of [
    [CAPTURE_SESSION_FILENAME, session],
    [CAPTURE_REPORT_FILENAME, captureReport],
    [REDACTION_REPORT_FILENAME, redactionDocument],
    [CAPTURED_ASSETS_FILENAME, capturedAssetsDocument],
  ] as const) {
    assertCaptureArtefactSafe(document, filename);
    const target = join(options.outputDirectory, filename);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    written.push(filename);
  }

  const sheet = await buildCaptureContactSheet(options);
  if (sheet.path) written.push(CAPTURE_CONTACT_SHEET_FILENAME);

  return {
    session,
    artefacts: written,
    contactSheetPath: sheet.path,
    contactSheetProblem: sheet.problem,
  };
}

/**
 * One tile per approved screenshot.
 *
 * Built by normalising each PNG to a fixed tile through the same extraction
 * the storyboard uses, then tiling — `xstack` requires identical inputs, and
 * a cropped screen is a different shape from a full one.
 */
async function buildCaptureContactSheet(
  options: WriteCaptureArtefactsOptions,
): Promise<{ path: string | null; problem: string | null }> {
  if (options.assets.length === 0) {
    return { path: null, problem: 'no screenshots were approved, so there is nothing to tile' };
  }
  const runner = options.runner ?? new NodeCommandRunner();
  const frameDirectory = join(options.outputDirectory, CAPTURE_FRAME_DIRECTORY);
  const sheetPath = join(options.outputDirectory, CAPTURE_CONTACT_SHEET_FILENAME);

  try {
    const frames = await extractStoryboardFrames(
      runner,
      options.assets.map((asset) => ({
        id: asset.assetId,
        sourcePath: join(options.outputDirectory, asset.relativePath),
        atSeconds: 0,
        isStill: true,
      })),
      frameDirectory,
      { ...(options.binaries?.ffmpeg ? { ffmpegPath: options.binaries.ffmpeg } : {}) },
    );
    await buildContactSheet(runner, frames, frameDirectory, sheetPath, {
      ...(options.binaries?.ffmpeg ? { ffmpegPath: options.binaries.ffmpeg } : {}),
    });
    return { path: sheetPath, problem: null };
  } catch (error) {
    // A missing FFmpeg costs the sheet, not the capture. The screenshots are
    // already on disk and already measured.
    return { path: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import { assertStoryboardVideoArtefactSafe } from './artefact-safety';
import { inspectSceneMotion, type SceneMotionInspection } from './motion-inspection';
import {
  reviewIdentitySha256,
  sceneContractSha256,
  type SceneReviewIdentity,
} from './motion-review-contracts';
import {
  evaluateMotionGate,
  sceneNeedsMotionReview,
  type MotionGateReport,
} from './motion-review-gate';
import { MOTION_REVIEW_GALLERY_FILENAME, writeMotionReviewGallery } from './motion-review-gallery';
import type { MotionReviewLedger } from './motion-review-store';
import type { SceneManifestEntry } from './scene-manifest';
import { movingSourcePathFor, type StoryboardVideoContext } from './source-resolution-stage';
import type { SceneSourceDecision } from './source-precedence';

/**
 * One pass of the motion review: inspect every resolved moving clip, work out
 * what each scene's approval is bound to, evaluate the gate, and write the
 * page a person reads.
 *
 * Called from two places and identical in both — the review command, where it
 * is the whole job, and the render run, where it is the check that happens
 * before anything is composited. That is deliberate: a gate that evaluated
 * different inputs from the ones the reviewer looked at would clear scenes
 * nobody had seen.
 *
 * It constructs no provider, reads no environment variable and makes no
 * request. Everything it needs is already on disk.
 */

export const MOTION_REVIEW_FRAMES_SUBDIRECTORY = 'frames';
export const MOTION_INSPECTION_REPORT_FILENAME = 'motion-inspection-report.json';
export const MOTION_GATE_REPORT_FILENAME = 'motion-gate-report.json';
export const GENERATED_SOURCES_SUBDIRECTORY = 'generated-sources';
export const GENERATED_SOURCES_INDEX_FILENAME = 'generated-sources.json';

/**
 * Generated clips, published into the review directory content-addressed.
 *
 * A generated clip otherwise lives only inside the run directory that produced
 * it, which a later review command has no way to find — so a reviewer could
 * never rule on a generated scene, and the gate would block forever. Copying
 * them here makes the review directory self-contained: the bytes a reviewer
 * looked at, addressed by their own checksum, still there on the next run.
 *
 * A copy is verified against the index on read. A file whose bytes no longer
 * hash to what the index recorded is not a source with a stale label; it is a
 * different file, and it is ignored rather than inspected.
 */
export async function recordGeneratedSources(
  reviewDirectory: string,
  generatedPathsByScene: ReadonlyMap<number, string>,
): Promise<void> {
  if (generatedPathsByScene.size === 0) return;
  const directory = join(reviewDirectory, GENERATED_SOURCES_SUBDIRECTORY);
  await mkdir(directory, { recursive: true });

  const entries: { sceneNumber: number; fileName: string; checksumSha256: string }[] = [];
  for (const [sceneNumber, sourcePath] of [...generatedPathsByScene].sort((a, b) => a[0] - b[0])) {
    // eslint-disable-next-line no-await-in-loop -- deterministic order
    const bytes = await readFile(sourcePath);
    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
    const fileName = `scene-${String(sceneNumber).padStart(2, '0')}-${checksumSha256.slice(0, 16)}.mp4`;
    // eslint-disable-next-line no-await-in-loop -- deterministic order
    await copyFile(sourcePath, join(directory, fileName));
    entries.push({ sceneNumber, fileName, checksumSha256 });
  }

  await writeFile(
    join(reviewDirectory, GENERATED_SOURCES_INDEX_FILENAME),
    `${JSON.stringify({ generatedSources: entries }, null, 2)}\n`,
    'utf8',
  );
}

export async function readGeneratedSourceIndex(
  reviewDirectory: string,
): Promise<ReadonlyMap<number, string>> {
  const paths = new Map<number, string>();
  let parsed: {
    generatedSources?: { sceneNumber: number; fileName: string; checksumSha256: string }[];
  };
  try {
    parsed = JSON.parse(
      await readFile(join(reviewDirectory, GENERATED_SOURCES_INDEX_FILENAME), 'utf8'),
    ) as typeof parsed;
  } catch {
    return paths;
  }
  for (const entry of parsed.generatedSources ?? []) {
    const absolutePath = join(reviewDirectory, GENERATED_SOURCES_SUBDIRECTORY, entry.fileName);
    // eslint-disable-next-line no-await-in-loop -- a handful of files, checked in order
    const bytes = await readFile(absolutePath).catch(() => null);
    if (!bytes) continue;
    if (createHash('sha256').update(bytes).digest('hex') !== entry.checksumSha256) continue;
    paths.set(entry.sceneNumber, absolutePath);
  }
  return paths;
}

export interface MotionReviewOutcome {
  readonly inspections: readonly SceneMotionInspection[];
  readonly inspectionsByScene: ReadonlyMap<number, SceneMotionInspection>;
  readonly identities: ReadonlyMap<number, SceneReviewIdentity>;
  readonly gate: MotionGateReport;
  readonly galleryPath: string | null;
  readonly reviewDirectory: string;
  readonly artefacts: readonly string[];
}

export interface RunMotionReviewOptions {
  readonly context: StoryboardVideoContext;
  /** Paths to clips this run generated, by scene. Absent for a review-only pass. */
  readonly generatedPathsByScene?: ReadonlyMap<number, string>;
  readonly reviewDirectory: string;
  readonly ledger: MotionReviewLedger;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly now: Date;
  readonly writeGallery: boolean;
  readonly onProgress?: (message: string) => void;
}

export async function runMotionReview(
  options: RunMotionReviewOptions,
): Promise<MotionReviewOutcome> {
  const { context } = options;
  const framesDirectory = join(options.reviewDirectory, MOTION_REVIEW_FRAMES_SUBDIRECTORY);
  await mkdir(framesDirectory, { recursive: true });

  // A run publishes what it generated; a review-only pass reads what an earlier
  // run published. Either way the clip inspected is the clip that renders.
  if (options.generatedPathsByScene) {
    await recordGeneratedSources(options.reviewDirectory, options.generatedPathsByScene);
  }
  const generatedPathsByScene =
    options.generatedPathsByScene ?? (await readGeneratedSourceIndex(options.reviewDirectory));

  const inspections: SceneMotionInspection[] = [];
  const identities = new Map<number, SceneReviewIdentity>();

  for (const decision of [...context.decisions].sort((a, b) => a.sceneNumber - b.sceneNumber)) {
    if (!sceneNeedsMotionReview(decision)) continue;

    const scene = context.sceneManifest.scenes.find((s) => s.sceneNumber === decision.sceneNumber);
    const keyframe = context.keyframes.frames.find((f) => f.sceneNumber === decision.sceneNumber);
    if (!scene || !keyframe) continue;

    const clipPath = movingSourcePathFor({
      decision,
      preGeneratedClips: context.preGeneratedClips,
      footagePack: context.footagePack,
      generatedPathsByScene,
    });
    if (!clipPath) continue;

    // eslint-disable-next-line no-await-in-loop -- scene order keeps the report stable
    const inspection = await inspectSceneMotion({
      decision,
      scene,
      keyframe,
      clipPath,
      requiredSourceSeconds: context.requiredSecondsByScene.get(decision.sceneNumber) ?? 0,
      inspectionDirectory: framesDirectory,
      runner: options.runner,
      binaries: options.binaries,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    inspections.push(inspection);
    identities.set(
      decision.sceneNumber,
      buildSceneIdentity({
        decision,
        scene,
        keyframeChecksumSha256: keyframe.checksumSha256,
        clipChecksumSha256: inspection.clipChecksumSha256,
      }),
    );
  }

  const gate = evaluateMotionGate({
    decisions: context.decisions,
    inspections: new Map(inspections.map((inspection) => [inspection.sceneNumber, inspection])),
    identities,
    ledger: options.ledger,
    now: options.now,
  });

  const artefacts: string[] = [];
  await mkdir(options.reviewDirectory, { recursive: true });

  const inspectionReport = {
    storyboardId: context.storyboard.storyboardId,
    generatedAt: options.now.toISOString(),
    paidProviderCalls: 0,
    apiKeyRead: false,
    notice: gate.notice,
    scenes: inspections,
    identities: [...identities.entries()].map(([sceneNumber, identity]) => ({
      sceneNumber,
      identity,
      identitySha256: reviewIdentitySha256(identity),
    })),
  };
  assertStoryboardVideoArtefactSafe(inspectionReport, MOTION_INSPECTION_REPORT_FILENAME);
  await writeFile(
    join(options.reviewDirectory, MOTION_INSPECTION_REPORT_FILENAME),
    `${JSON.stringify(inspectionReport, null, 2)}\n`,
    'utf8',
  );
  artefacts.push(MOTION_INSPECTION_REPORT_FILENAME);

  assertStoryboardVideoArtefactSafe(gate, MOTION_GATE_REPORT_FILENAME);
  await writeFile(
    join(options.reviewDirectory, MOTION_GATE_REPORT_FILENAME),
    `${JSON.stringify(gate, null, 2)}\n`,
    'utf8',
  );
  artefacts.push(MOTION_GATE_REPORT_FILENAME);

  let galleryPath: string | null = null;
  if (options.writeGallery) {
    galleryPath = await writeMotionReviewGallery({
      reviewDirectory: options.reviewDirectory,
      framesSubdirectory: MOTION_REVIEW_FRAMES_SUBDIRECTORY,
      storyboardId: context.storyboard.storyboardId,
      inspections,
      gate,
      decisionsByScene: new Map(
        inspections.map((inspection) => [
          inspection.sceneNumber,
          options.ledger.forScene(inspection.sceneNumber),
        ]),
      ),
      generatedAt: options.now.toISOString(),
    });
    artefacts.push(MOTION_REVIEW_GALLERY_FILENAME);
  }

  return {
    inspections,
    inspectionsByScene: new Map(inspections.map((i) => [i.sceneNumber, i])),
    identities,
    gate,
    galleryPath,
    reviewDirectory: options.reviewDirectory,
    artefacts,
  };
}

export function buildSceneIdentity(input: {
  readonly decision: SceneSourceDecision;
  readonly scene: SceneManifestEntry;
  readonly keyframeChecksumSha256: string;
  readonly clipChecksumSha256: string;
}): SceneReviewIdentity {
  return {
    sceneNumber: input.decision.sceneNumber,
    clipChecksumSha256: input.clipChecksumSha256,
    keyframeChecksumSha256: input.keyframeChecksumSha256,
    motionPromptSha256: createHash('sha256').update(input.scene.motionPrompt, 'utf8').digest('hex'),
    sceneContractSha256: sceneContractSha256(input.scene),
    sourceType: input.decision.selectedSourceType,
    generationProvenance: input.decision.generationProvenance ?? null,
  };
}

/**
 * What the whole storyboard looks like right now, in one table.
 *
 * Deliberately says what each scene *is* rather than what it should become:
 * a hand-animated clip and a clip this pipeline generated are the same kind of
 * source and different facts, an acquired plate is neither, and a scene with
 * no moving source at all is a scene that still needs one. Reporting them as
 * one category would make the readiness figure meaningless.
 */
export interface StoryboardReadinessRow {
  readonly sceneNumber: number;
  readonly sceneRole: string;
  readonly generationMode: string;
  readonly sourceType: string;
  readonly sourceIdentity: string;
  readonly requiresGeneration: boolean;
  readonly needsMotionReview: boolean;
  readonly gateStatus: string;
  readonly estimatedGenerationCostCents: number;
}

export interface StoryboardReadinessReport {
  readonly storyboardId: string;
  readonly generatedAt: string;
  readonly rows: readonly StoryboardReadinessRow[];
  readonly manualClipScenes: readonly number[];
  readonly acquiredFootageScenes: readonly number[];
  readonly deterministicGraphicsScenes: readonly number[];
  /**
   * Scenes with no moving source at all yet. Distinct from
   * `scenesRequiringGeneration`, which stays true for a generated scene whose
   * clip already exists — "this scene is generated" and "this scene has
   * nothing to render" are different facts and collapsing them would make the
   * readiness figure say the run was further along than it is.
   */
  readonly missingGenerationScenes: readonly number[];
  readonly scenesRequiringGeneration: readonly number[];
  readonly reviewedAndApprovedScenes: readonly number[];
  readonly blockingScenes: readonly number[];
  readonly remainingGenerationCeilingCents: number;
  readonly readyToRender: boolean;
  readonly paidProviderCalls: 0;
  readonly notice: string;
}

export function buildReadinessReport(input: {
  readonly context: StoryboardVideoContext;
  readonly gate: MotionGateReport;
  readonly costByScene: ReadonlyMap<number, number>;
  readonly now: Date;
}): StoryboardReadinessReport {
  const statusByScene = new Map(input.gate.rows.map((row) => [row.sceneNumber, row.status]));

  const rows: StoryboardReadinessRow[] = [...input.context.decisions]
    .sort((a, b) => a.sceneNumber - b.sceneNumber)
    .map((decision) => ({
      sceneNumber: decision.sceneNumber,
      sceneRole: decision.sceneRole,
      generationMode: decision.generationMode,
      sourceType: decision.selectedSourceType,
      sourceIdentity: decision.generationProvenance ?? decision.selectedIdentifier,
      requiresGeneration: decision.requiresGeneration,
      needsMotionReview: sceneNeedsMotionReview(decision),
      gateStatus: statusByScene.get(decision.sceneNumber) ?? 'NOT_REVIEWABLE',
      estimatedGenerationCostCents: input.costByScene.get(decision.sceneNumber) ?? 0,
    }));

  const scenesWhere = (predicate: (row: StoryboardReadinessRow) => boolean): number[] =>
    rows.filter(predicate).map((row) => row.sceneNumber);

  return {
    storyboardId: input.context.storyboard.storyboardId,
    generatedAt: input.now.toISOString(),
    rows,
    manualClipScenes: scenesWhere((row) => row.sourceType === 'PRE_GENERATED_MANUAL_CLIP'),
    acquiredFootageScenes: scenesWhere((row) => row.sourceType === 'ACQUIRED_PRODUCTION_FOOTAGE'),
    deterministicGraphicsScenes: scenesWhere(
      (row) => row.sourceType === 'DETERMINISTIC_MOTION_GRAPHICS',
    ),
    missingGenerationScenes: scenesWhere(
      (row) => row.requiresGeneration && row.gateStatus === 'MISSING_SOURCE',
    ),
    scenesRequiringGeneration: scenesWhere((row) => row.requiresGeneration),
    reviewedAndApprovedScenes: scenesWhere((row) => row.gateStatus === 'APPROVED'),
    blockingScenes: [...input.gate.blockingScenes],
    remainingGenerationCeilingCents: rows
      .filter((row) => row.gateStatus === 'MISSING_SOURCE')
      .reduce((sum, row) => sum + row.estimatedGenerationCostCents, 0),
    // The gate already refuses a scene with no source, so it is the whole
    // condition: a separate "and nothing needs generating" test would report a
    // generated-and-approved scene as unfinished forever.
    readyToRender: input.gate.clears,
    paidProviderCalls: 0,
    notice: input.gate.notice,
  };
}

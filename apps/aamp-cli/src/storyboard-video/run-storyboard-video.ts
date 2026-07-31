import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  NodeCommandRunner,
  parseRenderManifest,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';
import {
  createLtxHostedProvider,
  LTX_POLL_INTERVAL_MS,
  LTX_RESPONSE_CONTRACT_STATUS,
  LTX_SUPPORTED_FPS,
  LTX_SUPPORTED_RESOLUTION,
  routeLtxCameraMotion,
  type LtxModel,
  type VideoGenerationProvider,
} from '@combat/providers';

import {
  runFlagshipV2,
  V2_EXECUTION_MODE,
  V2_IS_PUBLIC_RELEASE_READY,
  V2_IS_REAL_CAMPAIGN_RUN,
  V2_OUTPUT_USE,
  type GeneratedSceneMedia,
  type SceneStillMedia,
} from '../flagship/run-flagship-v2';
import { loadAcceptanceBrief } from '../scene-acceptance/acceptance-brief';
import {
  compositeNotification,
  type NotificationCompositeResult,
} from '../scene-acceptance/notification-composite';
import { assertStoryboardVideoArtefactSafe } from './artefact-safety';
import {
  describeStagedPlates,
  stageCanonicalPlates,
  type StagedPlateLibrary,
} from './canonical-plate-staging';
import {
  assertWithinCostCeiling,
  assertWithinGenerationCeiling,
  buildCostEstimate,
  describeCostEstimate,
  type CostEstimate,
} from './cost-estimate';
import { deriveRenderPlan, writeDerivedPlan } from './derived-plan';
import {
  STORYBOARD_VIDEO_EXIT_CODES,
  StoryboardVideoError,
  type StoryboardVideoExitCode,
} from './failures';
import { GenerationCache } from './generation-cache';
import {
  assertMotionGateClears,
  assertReviewCandidateTechnicallySound,
  sceneNeedsMotionReview,
  type MotionGateReport,
} from './motion-review-gate';
import {
  applyPostMotion,
  buildPostMotionReport,
  POST_MOTION_DIRECTORY,
  type AppliedPostMotion,
} from './post-motion';
import {
  buildAudioReport,
  buildTransitionReport,
  buildUiCompositingReport,
  buildVisibleDefectsReport,
  findBenchmarkAudio,
} from './review-candidate-reports';
import { runMotionReview, type MotionReviewOutcome } from './motion-review-run';
import { DEFAULT_MOTION_REVIEW_DIRECTORY, MotionReviewLedger } from './motion-review-store';
import { MANUAL_GENERATION_PROVENANCE, type PreGeneratedClipLibrary } from './pre-generated-clips';
import {
  generateSceneClip,
  prepareSceneClip,
  probeClip,
  sceneCacheKey,
  type GeneratedSceneClip,
  type PreparedSceneClip,
} from './scene-media';
import { modeReachesGenerationProvider, type SceneManifest } from './scene-manifest';
import type { KeyframeLibrary } from './keyframe-library';
import {
  movingSourcePathFor,
  resolveStoryboardVideoContext,
  type StoryboardVideoContext,
} from './source-resolution-stage';
import {
  assertNoSilentStillFallback,
  buildSourceDecisionReport,
  nextRequiredGenerationScene,
  type GenerationOutcomeForReport,
  type SceneSourceDecision,
} from './source-precedence';
import type { FootagePack } from './footage-pack';

/**
 * Storyboard package to finished MP4, in one command.
 *
 * The order of the stages is the design, and it is the same discipline the
 * preview path already follows: **everything that can refuse the run happens
 * before anything that costs money.** The storyboard is verified, the scene
 * manifest is checked against it, the keyframes are resolved and probed, the
 * prompts are gated, the sources are decided and the cost is computed and
 * compared against the ceiling — and only then is a single byte uploaded.
 *
 * The render itself is not reimplemented. Once every scene has a prepared
 * clip, the run hands the whole thing to `runFlagshipV2`, which hands it to
 * the zero-cost preview path, which is what actually stages assets, resolves
 * rights, analyses clips, selects segments, builds the filter graph, runs
 * FFmpeg and measures the result. This module decides *what the pixels are*;
 * it does not decide how they are cut.
 */

export const STORYBOARD_VIDEO_RUN_VERSION = 1 as const;

/**
 * What the run is producing, and therefore which half of the motion gate binds.
 *
 * Two genuinely different artefacts, not two strictnesses of one:
 *
 * - `PRODUCTION_MASTER` is a file somebody could publish. Every moving scene
 *   carries a standing human approval of the exact bytes, or nothing is
 *   composited.
 * - `FULL_LENGTH_REVIEW_CANDIDATE` is the cut a reviewer watches *in order to*
 *   make those decisions. Continuity, pacing and the nine transitions between
 *   shots are not visible in ten isolated clips, so requiring the approvals
 *   first would mean approving the parts before anyone could see the whole. It
 *   still refuses a technically broken clip, and every scene it contains is
 *   recorded as `PENDING_HUMAN_REVIEW` in every artefact it writes.
 *
 * The value is fixed by the entry point the operator ran. Neither CLI exposes
 * a flag, an environment variable or an argument that changes it — a gate with
 * a switch is a gate that gets switched off on the afternoon somebody needs
 * the file quickly.
 */
export const STORYBOARD_VIDEO_OUTPUT_INTENTS = [
  'PRODUCTION_MASTER',
  'FULL_LENGTH_REVIEW_CANDIDATE',
] as const;
export type StoryboardVideoOutputIntent = (typeof STORYBOARD_VIDEO_OUTPUT_INTENTS)[number];

export interface StoryboardVideoOptions {
  readonly storyboardRoot: string;
  readonly framesDirectory: string;
  /**
   * The operator's read-only authoritative plate folder, when the run should
   * stage its own canonical keyframes from it.
   *
   * When supplied it *replaces* `framesDirectory`: the ten `FRAME1PLATE` …
   * `FRAME10PLATE` files are discovered, verified and copied into a run-owned
   * `FRAME-01` … `FRAME-10` directory, and the run reads from that. The
   * operator's folder is never written to.
   */
  readonly platesDirectory?: string;
  /** Fixed by the entry point. There is no flag for this. */
  readonly outputIntent?: StoryboardVideoOutputIntent;
  /**
   * The completed audio benchmark, when one exists.
   *
   * Checked rather than trusted: the run uses it only if its final report says
   * the model chain finished *and* it holds selected mixes. Anything else and
   * the cut is marked `AUDIO_TEMPORARY`, because putting a benchmark's
   * intermediate material into a reviewable cut would misrepresent both.
   */
  readonly audioBenchmarkDirectory?: string;
  /**
   * The authored brief carrying the locked notification treatment.
   *
   * Optional, and absent means no card is composited at all rather than a
   * default one being invented. The treatment is applied to the scene the
   * brief itself names, after the motion, so the model never sees a card and
   * the push underneath does not scale the type.
   */
  readonly notificationBriefPath?: string;
  readonly outputDirectory: string;
  readonly workPackRoot: string;
  readonly campaignDirectory: string;
  readonly model: LtxModel;
  readonly maxCostCents: number;
  /**
   * A hard ceiling on billable submissions, checked beside the cost ceiling and
   * before the first upload.
   *
   * The two fail differently and that is why there are two. A routing mistake
   * that turns four deterministic scenes into generations stays comfortably
   * under a generous cost ceiling while quietly quadrupling the number of paid
   * requests; a ceiling denominated in requests catches exactly that. Absent
   * means only the cost ceiling binds.
   */
  readonly maxGenerations?: number;
  readonly footagePackRoot?: string;
  readonly preGeneratedClipsDirectory?: string;
  readonly sceneManifestPath?: string;
  readonly storyboard01Root?: string;
  readonly dryRun: boolean;
  readonly generateAudio: boolean;
  readonly reuseGenerated: boolean;
  readonly regenerateScenes: ReadonlySet<number>;
  /**
   * Where human motion decisions live. Deliberately outside the run directory,
   * because an approval outlives the run that prompted it.
   */
  readonly reviewDirectory?: string;
  /**
   * Also regenerate every scene a reviewer rejected, without naming them.
   *
   * Additive to `regenerateScenes`: the two together are the complete set of
   * scenes this run may spend on beyond the ones that have no source at all.
   */
  readonly regenerateRejected?: boolean;
  readonly binaries: FfmpegBinaries;
  readonly workflowRunId: string;
  readonly now: Date;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly runner?: CommandRunner;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  /** Injected for tests only; the run builds its own from the API key otherwise. */
  readonly providerOverride?: VideoGenerationProvider;
  readonly onProgress?: (message: string) => void;
}

/**
 * A scene whose generated clip failed inspection and was demoted to its still.
 *
 * Only ever produced for a `FULL_LENGTH_REVIEW_CANDIDATE`, and never silent:
 * it is written to its own artefact, into the provenance record and into the
 * pending-review ledger, because a scene that quietly became a held frame is
 * the exact failure the source precedence exists to prevent.
 */
export interface DefectSubstitution {
  readonly sceneNumber: number;
  readonly sceneRole: string;
  readonly rejectedClipChecksumSha256: string | null;
  readonly failedBindingChecks: readonly string[];
  readonly substitutedWith: 'DETERMINISTIC_MOTION_GRAPHICS';
  /** What buying a replacement would cost, so the decision has a number on it. */
  readonly costOfARetryCents: number | null;
}

export interface StoryboardVideoResult {
  readonly exitCode: StoryboardVideoExitCode;
  readonly runDirectory: string;
  readonly dryRun: boolean;
  readonly costEstimate?: CostEstimate;
  readonly decisions?: readonly SceneSourceDecision[];
  readonly nextRequiredGenerationScene?: number | null;
  readonly generatedSceneCount: number;
  readonly ltxCallCount: number;
  readonly actualCostCents: number;
  readonly outputPath?: string;
  readonly qaVerdict?: string;
  readonly measured?: Record<string, unknown>;
  readonly galleryPath?: string;
  readonly artefacts: readonly string[];
  readonly failure?: string;
  readonly failureKind?: string;
  /** The motion gate as it stood when the run reached it. Absent on a dry run. */
  readonly motionGate?: MotionGateReport;
  readonly motionReviewGalleryPath?: string;
  /** Scenes regenerated because a reviewer had rejected them. */
  readonly regeneratedRejectedScenes?: readonly number[];
  readonly outputIntent: StoryboardVideoOutputIntent;
  /** The ten canonical plates this run staged for itself, when it staged any. */
  readonly stagedPlates?: StagedPlateLibrary;
  /** Scenes whose authored second stage was executed. */
  readonly postMotion?: readonly AppliedPostMotion[];
  /** Scenes demoted to their still because the generated clip failed inspection. */
  readonly defectSubstitutions?: readonly DefectSubstitution[];
}

async function writeArtefact(runDirectory: string, name: string, value: unknown): Promise<string> {
  assertStoryboardVideoArtefactSafe(value, name);
  const target = join(runDirectory, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return name;
}

export async function runStoryboardVideo(
  options: StoryboardVideoOptions,
): Promise<StoryboardVideoResult> {
  const runner = options.runner ?? new NodeCommandRunner();
  const runDirectory = resolve(options.outputDirectory);
  const onProgress = options.onProgress;
  const outputIntent: StoryboardVideoOutputIntent = options.outputIntent ?? 'PRODUCTION_MASTER';
  const artefacts: string[] = [];
  await mkdir(runDirectory, { recursive: true });

  // Held outside the try so a failure can still report the gate a person needs
  // to act on. A refusal that will not say which scenes blocked it is a
  // refusal an operator has to reproduce before they can fix anything.
  let motionReview: MotionReviewOutcome | null = null;
  let stagedPlates: StagedPlateLibrary | null = null;

  const fail = (error: unknown): StoryboardVideoResult => {
    const typed =
      error instanceof StoryboardVideoError
        ? error
        : new StoryboardVideoError(
            'FINAL_RENDER_FAILURE',
            error instanceof Error ? error.message : String(error),
          );
    return {
      exitCode: typed.exitCode,
      runDirectory,
      dryRun: options.dryRun,
      generatedSceneCount: 0,
      ltxCallCount: 0,
      actualCostCents: 0,
      artefacts,
      failure: typed.message,
      failureKind: typed.kind,
      outputIntent,
      ...(stagedPlates ? { stagedPlates } : {}),
      ...(motionReview ? { motionGate: motionReview.gate } : {}),
      ...(motionReview?.galleryPath ? { motionReviewGalleryPath: motionReview.galleryPath } : {}),
    };
  };

  try {
    // --- 0. the run's own canonical keyframes -------------------------------
    // Before anything else, because every later stage — the prompts, the
    // review identity, the cost, the uploads — is bound to these exact bytes.
    let framesDirectory = options.framesDirectory;
    if (options.platesDirectory) {
      stagedPlates = await stageCanonicalPlates({
        platesDirectory: options.platesDirectory,
        outputDirectory: runDirectory,
        runner,
        binaries: options.binaries,
        ...(onProgress ? { onProgress } : {}),
      });
      framesDirectory = stagedPlates.stagedDirectory;
      onProgress?.(`ten authoritative plates staged:\n${describeStagedPlates(stagedPlates)}`);
    }

    // --- 1–6. the storyboard, the plan, the keyframes, the sources ----------
    // One shared resolution stage, so the review command and this run always
    // decide over identical inputs. A second implementation would eventually
    // review a different set of clips from the ones that get rendered.
    const reviewDirectory = resolve(
      options.reviewDirectory ?? join(runDirectory, DEFAULT_MOTION_REVIEW_DIRECTORY),
    );
    const ledger = await MotionReviewLedger.open(reviewDirectory);

    const resolveContext = async (
      regenerateScenes: ReadonlySet<number>,
    ): Promise<StoryboardVideoContext> =>
      resolveStoryboardVideoContext({
        storyboardRoot: options.storyboardRoot,
        framesDirectory,
        workPackRoot: options.workPackRoot,
        campaignDirectory: options.campaignDirectory,
        ...(options.footagePackRoot ? { footagePackRoot: options.footagePackRoot } : {}),
        ...(options.preGeneratedClipsDirectory
          ? { preGeneratedClipsDirectory: options.preGeneratedClipsDirectory }
          : {}),
        ...(options.sceneManifestPath ? { sceneManifestPath: options.sceneManifestPath } : {}),
        scratchDirectory: runDirectory,
        regenerateScenes,
        runner,
        binaries: options.binaries,
        ...(onProgress ? { onProgress } : {}),
      });

    let context = await resolveContext(options.regenerateScenes);
    let regenerateScenes = new Set(options.regenerateScenes);
    let regeneratedRejectedScenes: number[] = [];

    if (context.preGeneratedClips.clips.length > 0) {
      onProgress?.(
        `found ${context.preGeneratedClips.clips.length} hand-animated clip(s) (${context.preGeneratedClips.clips
          .map((clip) => clip.frameId)
          .join(', ')}) — provenance ${MANUAL_GENERATION_PROVENANCE}, reused without any API call`,
      );
    }
    if (context.footagePack) {
      onProgress?.(
        `${context.footagePack.originals.length} verified original(s); ${context.footagePack.refusedByLocationCount} preview/contact-sheet file(s) refused by location`,
      );
    }

    // Rejected scenes become regeneration targets before the cost is computed,
    // so what a reviewer refused is priced into the ceiling rather than
    // discovered after the estimate was printed.
    if (options.regenerateRejected) {
      const rejected = await findRejectedScenes({
        context,
        ledger,
        reviewDirectory,
        runner,
        binaries: options.binaries,
        now: options.now,
      });
      regeneratedRejectedScenes = rejected.filter(
        (sceneNumber) => !regenerateScenes.has(sceneNumber),
      );
      if (regeneratedRejectedScenes.length > 0) {
        onProgress?.(
          `a reviewer rejected scene(s) ${regeneratedRejectedScenes.join(', ')} — they are added to the regeneration set`,
        );
        regenerateScenes = new Set([...regenerateScenes, ...regeneratedRejectedScenes]);
        context = await resolveContext(regenerateScenes);
      }
    }

    const {
      storyboard,
      sceneManifest,
      sceneManifestPath,
      basePlan,
      keyframes,
      preGeneratedClips,
      footagePack,
      decisions,
      checkedPrompts,
      campaignDirectory,
      workPackRoot,
    } = context;
    const requiredFor = (sceneNumber: number): number =>
      context.requiredSecondsByScene.get(sceneNumber) ?? 0;

    // Byte-identity of everything a reviewer already approved is a promise the
    // run keeps rather than states. The checksums are taken before generation
    // and compared after it.
    const approvedChecksumsBefore = collectApprovedClipChecksums(context, ledger);

    // --- 7. cost, before any upload ----------------------------------------
    //
    // The cache is consulted *here*, before the estimate, so the printed
    // maximum and both ceilings describe the run that is about to happen. An
    // estimate that counted a cached scene as a purchase could not tell a free
    // re-run from a second full one — which is exactly how a broken cache
    // bought the same storyboard twice without either ceiling noticing.
    const cache = await GenerationCache.open(join(runDirectory, 'generation-cache'));
    const alreadyCachedScenes = await findCachedScenes({
      decisions,
      sceneManifest,
      keyframes,
      cache,
      model: options.model,
      generateAudio: options.generateAudio,
      regenerateScenes,
      requiredFor,
    });
    if (alreadyCachedScenes.size > 0) {
      onProgress?.(
        `${alreadyCachedScenes.size} scene(s) are already covered by a byte-verified cached generation (${[...alreadyCachedScenes].sort((a, b) => a - b).join(', ')}) — they cost nothing and make no request`,
      );
    }

    const costEstimate = buildCostEstimate({
      decisions,
      model: options.model,
      resolution: LTX_SUPPORTED_RESOLUTION,
      ceilingCents: options.maxCostCents,
      requiredSourceSecondsForScene: requiredFor,
      alreadyCachedScenes,
    });
    onProgress?.(describeCostEstimate(costEstimate));

    artefacts.push(
      await writeArtefact(runDirectory, 'storyboard-run-plan.json', {
        runVersion: STORYBOARD_VIDEO_RUN_VERSION,
        workflowRunId: options.workflowRunId,
        storyboardId: storyboard.storyboardId,
        sceneManifestPath,
        sceneManifestAuthoredBy: sceneManifest.authoredBy,
        planAuthoredBy: basePlan.authoredBy,
        outputIntent,
        model: options.model,
        resolution: LTX_SUPPORTED_RESOLUTION,
        fps: LTX_SUPPORTED_FPS,
        generateAudio: options.generateAudio,
        maxCostCents: options.maxCostCents,
        maxGenerations: options.maxGenerations ?? null,
        dryRun: options.dryRun,
        reuseGenerated: options.reuseGenerated,
        regenerateScenes: [...regenerateScenes].sort((a, b) => a - b),
        regeneratedBecauseRejected: [...regeneratedRejectedScenes].sort((a, b) => a - b),
        reviewDirectory,
        framesDirectory: keyframes.framesDirectory,
        keyframes: keyframes.frames.map((frame) => ({
          frameId: frame.frameId,
          fileName: frame.fileName,
          checksumSha256: frame.checksumSha256,
          widthPx: frame.widthPx,
          heightPx: frame.heightPx,
        })),
        preGeneratedClips: preGeneratedClips.clips.map((clip) => ({
          frameId: clip.frameId,
          fileName: clip.fileName,
          checksumSha256: clip.checksumSha256,
          durationSeconds: clip.durationSeconds,
          widthPx: clip.widthPx,
          heightPx: clip.heightPx,
          provenance: clip.provenance,
          note: 'animated by hand in LTX Studio; this pipeline did not produce these bytes',
        })),
        footagePack: footagePack
          ? {
              packRoot: footagePack.packRoot,
              verifiedOriginals: footagePack.originals.map((original) => ({
                assetId: original.assetId,
                role: original.role,
                relativePath: original.relativePath,
                checksumSha256: original.checksumSha256,
                measured: original.measured,
                discrepancies: original.discrepancies,
                provider: original.provider,
                creator: original.creator,
                licence: original.licence,
              })),
              refusedByLocationCount: footagePack.refusedByLocationCount,
              unfilledRoles: footagePack.unfilledRoles,
            }
          : null,
        promptsChecked: checkedPrompts,
        responseContractStatus: LTX_RESPONSE_CONTRACT_STATUS,
      }),
    );
    artefacts.push(await writeArtefact(runDirectory, 'cost-estimate.json', costEstimate));

    // Both ceilings, before anything is uploaded. The request ceiling is
    // checked first: an operator who has mis-routed four scenes needs to be
    // told that rather than told the price.
    assertWithinGenerationCeiling(costEstimate, options.maxGenerations);
    assertWithinCostCeiling(costEstimate);

    const nextScene = nextRequiredGenerationScene(decisions);

    // --- 8. dry run stops here, having spent and contacted nothing ---------
    if (options.dryRun) {
      artefacts.push(
        await writeArtefact(
          runDirectory,
          'source-decision-report.json',
          buildSourceDecisionReport({
            decisions,
            outcomes: new Map(),
            finalManifestSourceByScene: new Map(),
          }),
        ),
      );
      onProgress?.(
        'dry run complete — no API key was read, no request was made and nothing was spent',
      );
      return {
        exitCode: STORYBOARD_VIDEO_EXIT_CODES.SUCCESS,
        runDirectory,
        dryRun: true,
        costEstimate,
        decisions,
        nextRequiredGenerationScene: nextScene?.sceneNumber ?? null,
        generatedSceneCount: 0,
        ltxCallCount: 0,
        actualCostCents: 0,
        artefacts,
        outputIntent,
        ...(stagedPlates ? { stagedPlates } : {}),
      };
    }

    // --- 9. generation -------------------------------------------------------
    const generating = decisions.filter((decision) => decision.requiresGeneration);
    let provider = options.providerOverride;
    if (generating.length > 0 && !provider) {
      if (!options.apiKey?.trim()) {
        throw new StoryboardVideoError(
          'MISSING_API_KEY',
          `${generating.length} scene(s) still need generating (${generating
            .map((decision) => `scene ${decision.sceneNumber}`)
            .join(
              ', ',
            )}) but LTXV_API_KEY is not set. Nothing has been uploaded and nothing has been spent. Set the key, or supply hand-animated clips for these scenes with --pre-generated-clips-dir.`,
        );
      }
      provider = createLtxHostedProvider({
        apiKey: options.apiKey,
        model: options.model,
        outputTimeoutMs: 20 * 60_000,
        outputDirectory: join(runDirectory, 'generated-originals', 'provider'),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    }

    // The same cache instance the estimate consulted. Reopening it would let
    // the run buy a scene the estimate had already promised was free.
    const generated = new Map<number, GeneratedSceneClip>();
    const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    for (const decision of generating) {
      const scene = sceneManifest.scenes.find((s) => s.sceneNumber === decision.sceneNumber);
      const keyframe = keyframes.frames.find((f) => f.frameId === decision.generationInputFrameId);
      if (!scene || !keyframe || !provider) continue;
      const lastFrame = scene.lastFrame
        ? keyframes.frames.find((f) => f.frameId === scene.lastFrame)
        : undefined;

      // eslint-disable-next-line no-await-in-loop -- scenes generate in order so cost is predictable
      const clip = await generateSceneClip({
        scene,
        keyframe,
        ...(lastFrame ? { lastFrame } : {}),
        provider,
        model: options.model,
        generateAudio: options.generateAudio,
        requiredSourceSeconds: requiredFor(decision.sceneNumber),
        cache,
        originalsDirectory: join(runDirectory, 'generated-originals'),
        workflowRunId: options.workflowRunId,
        pollIntervalMs: options.pollIntervalMs ?? LTX_POLL_INTERVAL_MS,
        sleep,
        runner,
        binaries: options.binaries,
        // A scene the operator or a reviewer targeted must not resolve to the
        // cached clip that was rejected: every cache-key input is unchanged, so
        // the lookup would hit and the regeneration would silently not happen.
        bypassCache: regenerateScenes.has(decision.sceneNumber),
        ...(onProgress ? { onProgress } : {}),
      });
      generated.set(decision.sceneNumber, clip);
    }

    // No scene may quietly become a still because its generation never happened.
    assertNoSilentStillFallback(decisions, new Set(generated.keys()));

    // --- 9b. the motion gate, before anything is trimmed or composited -----
    //
    // This is the last point at which the run has produced no timeline and no
    // file. Everything downstream — the trim, the staging, the filter graph,
    // FFmpeg — is skipped when a scene has no standing human approval of the
    // exact clip about to be used.
    onProgress?.('inspecting every resolved moving clip and evaluating the motion gate');
    const review = (motionReview = await runMotionReview({
      context,
      generatedPathsByScene: new Map(
        [...generated.entries()].map(([sceneNumber, clip]) => [sceneNumber, clip.originalPath]),
      ),
      reviewDirectory,
      ledger,
      runner,
      binaries: options.binaries,
      now: options.now,
      writeGallery: true,
      ...(onProgress ? { onProgress } : {}),
    }));

    assertApprovedClipsUnchanged({
      before: approvedChecksumsBefore,
      after: review.inspectionsByScene,
    });

    if (!review.gate.clears) {
      // Written before throwing, so the operator has the gate report and the
      // gallery in hand rather than only an error message.
      artefacts.push(
        await writeArtefact(runDirectory, 'motion-gate-blocked.json', {
          runVersion: STORYBOARD_VIDEO_RUN_VERSION,
          workflowRunId: options.workflowRunId,
          outputIntent,
          reviewDirectory,
          galleryPath: review.galleryPath,
          renderStarted: false,
          ffmpegCompositionStarted: false,
          gate: review.gate,
        }),
      );
    }

    const defectSubstitutions: DefectSubstitution[] = [];
    if (outputIntent === 'FULL_LENGTH_REVIEW_CANDIDATE') {
      // A review candidate may carry unreviewed motion — that is what it is
      // for — but never a technically broken clip.
      //
      // What it does instead of refusing outright is **demote** that scene to
      // its still and say so. The reviewer then sees the whole cut with one
      // clearly-labelled hole rather than nothing at all, and the alternative
      // — buying a replacement — is a decision about money that belongs to a
      // person, not to a run that has already spent its authorised budget.
      //
      // This is emphatically not the silent still fallback the source
      // precedence forbids. It is recorded in its own artefact, in the gate,
      // in the provenance and in the pending-review ledger; it happens only
      // for a `FULL_LENGTH_REVIEW_CANDIDATE`; and the production path still
      // refuses the scene outright.
      for (const row of review.gate.rows) {
        if (row.status !== 'TECHNICALLY_INVALID') continue;
        if (row.sourceType !== 'LTX_GENERATED') continue;
        const inspection = review.inspectionsByScene.get(row.sceneNumber);
        const failed = (inspection?.checks ?? [])
          .filter((check) => check.tier === 'BINDING_TECHNICAL')
          .filter((check) => check.status === 'FAIL' || check.status === 'NOT_MEASURED')
          .map((check) => `${check.id}: expected ${check.expected}, observed ${check.observed}`);
        defectSubstitutions.push({
          sceneNumber: row.sceneNumber,
          sceneRole: row.sceneRole,
          rejectedClipChecksumSha256: row.clipChecksumSha256,
          failedBindingChecks: failed,
          substitutedWith: 'DETERMINISTIC_MOTION_GRAPHICS',
          costOfARetryCents:
            costEstimate.lines.find((line) => line.sceneNumber === row.sceneNumber)?.costCents ??
            null,
        });
        generated.delete(row.sceneNumber);
        onProgress?.(
          `scene ${row.sceneNumber}: the generated clip failed local inspection, so this candidate renders its still under deterministic motion instead. No retry was purchased — that is a person's decision.`,
        );
      }

      if (defectSubstitutions.length > 0) {
        artefacts.push(
          await writeArtefact(runDirectory, 'technical-defect-substitutions.json', {
            notice:
              'Each scene below had a generated clip that failed local technical inspection. This candidate renders its still under deterministic motion so the whole cut can be watched; the scene is NOT what the storyboard approved, and no production master may be built from this state.',
            noRetryWasPurchased: true,
            whatToDoNext:
              'Decide whether the scene is worth regenerating. If it is: "pnpm aamp:storyboard-video --regenerate-scene <n>", which prices the retry into the ceiling you authorise.',
            substitutions: defectSubstitutions,
          }),
        );
      }

      // Re-asserted after the demotion, so the guard stays live: a scene that
      // could be neither used nor demoted still refuses the run.
      assertReviewCandidateTechnicallySound({
        ...review.gate,
        technicallyInvalidScenes: review.gate.technicallyInvalidScenes.filter(
          (sceneNumber) =>
            !defectSubstitutions.some((substitution) => substitution.sceneNumber === sceneNumber),
        ),
      });
      const pending = review.gate.rows.filter((row) => row.status !== 'APPROVED');
      artefacts.push(
        await writeArtefact(
          runDirectory,
          'pending-human-review-ledger.json',
          buildPendingReviewLedger({
            gate: review.gate,
            reviewDirectory,
            galleryPath: review.galleryPath ?? null,
            defectSubstitutions,
          }),
        ),
      );
      onProgress?.(
        `review candidate: ${pending.length} of ${review.gate.rows.length} moving scene(s) are PENDING_HUMAN_REVIEW and nothing here approves any of them`,
      );
    } else {
      assertMotionGateClears(review.gate);
      onProgress?.(
        `motion gate cleared — ${review.gate.rows.length} moving scene(s) carry a standing approval`,
      );
    }

    // --- 10. prepare every moving source -----------------------------------
    const prepared = new Map<number, PreparedSceneClip>();
    const trimmedDirectory = join(runDirectory, 'trimmed-scenes');
    for (const decision of decisions) {
      const source = resolveMovingSourcePath({
        decision,
        generated,
        preGeneratedClips,
        footagePack,
      });
      if (!source) continue;

      const beat = basePlan.beats[decision.sceneNumber - 1];
      if (!beat) continue;
      // eslint-disable-next-line no-await-in-loop -- deterministic order
      const clip = await prepareSceneClip({
        sceneNumber: decision.sceneNumber,
        sourcePath: source.absolutePath,
        sourceDurationSeconds: source.durationSeconds,
        beatDurationSeconds: beat.durationSeconds,
        hasTransitionIn: Boolean(beat.transitionIn),
        hasTransitionOut: Boolean(basePlan.beats[decision.sceneNumber]?.transitionIn),
        trimmedDirectory,
        runner,
        binaries: options.binaries,
        ...(onProgress ? { onProgress } : {}),
      });
      prepared.set(decision.sceneNumber, clip);
    }

    // --- 10b. the authored second stage, executed ---------------------------
    //
    // A routed scene asked the provider for a locked-off frame; this is where
    // the move it was promised actually happens. It runs on the trimmed clip,
    // so the magnitude spans the shot rather than the material the cut throws
    // away, and it writes a new file rather than overwriting the input — the
    // pre-motion clip stays on disk so the two can be compared.
    const applied: AppliedPostMotion[] = [];
    const routedScenes = sceneManifest.scenes
      .filter((scene) => scene.postMotion)
      .map((scene) => ({
        sceneNumber: scene.sceneNumber,
        cameraMotion: scene.cameraMotion,
        providerValue: routeLtxCameraMotion(scene.cameraMotion).providerValue,
        postMotion: scene.postMotion as NonNullable<typeof scene.postMotion>,
      }));

    for (const routed of routedScenes) {
      const clip = prepared.get(routed.sceneNumber);
      if (!clip) {
        // A routed scene with no moving clip means the source precedence chose
        // a still for it, which `assertNoSilentStillFallback` has already
        // refused for a generative scene. Recorded rather than silently
        // skipped, so the report can say the second stage did not run.
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- deterministic order
      const result = await applyPostMotion({
        sceneNumber: routed.sceneNumber,
        sourcePath: clip.absolutePath,
        sourceChecksumSha256: clip.checksumSha256,
        durationSeconds: clip.usedDurationSeconds,
        widthPx: clip.widthPx,
        heightPx: clip.heightPx,
        postMotion: routed.postMotion,
        ...(routed.postMotion.preservedRegionRect
          ? { preservedRegionRect: routed.postMotion.preservedRegionRect }
          : {}),
        outputDirectory: join(runDirectory, POST_MOTION_DIRECTORY),
        runner,
        binaries: options.binaries,
        ...(onProgress ? { onProgress } : {}),
      });
      applied.push(result);
      prepared.set(routed.sceneNumber, {
        ...clip,
        absolutePath: result.outputPath,
        checksumSha256: result.outputChecksumSha256,
      });
    }

    artefacts.push(
      await writeArtefact(
        runDirectory,
        'post-motion-report.json',
        buildPostMotionReport({ applied, routedScenes }),
      ),
    );

    // --- 10c. the locked notification, composited after the motion ----------
    //
    // Last, deliberately. The model was asked for a clean plate and never saw
    // a card, a mark or lettering; the treatment is laid out as one document,
    // rasterised, and composited over the finished picture — so it cannot have
    // been generated, and the push underneath it does not scale the type.
    let notification: AppliedNotification | null = null;
    if (options.notificationBriefPath) {
      notification = await compositeSceneNotification({
        briefPath: options.notificationBriefPath,
        prepared,
        workPackRoot,
        outputDirectory: join(runDirectory, NOTIFICATION_DIRECTORY),
        runner,
        binaries: options.binaries,
        ...(onProgress ? { onProgress } : {}),
      });
      if (notification) {
        const base = prepared.get(notification.sceneNumber) as PreparedSceneClip;
        prepared.set(notification.sceneNumber, {
          ...base,
          absolutePath: notification.outputPath,
          checksumSha256: notification.result.checksumSha256,
        });
        artefacts.push(
          await writeArtefact(runDirectory, 'notification-composite-report.json', {
            notice:
              'The notification is composited after the generated motion and could not have been generated. The model was asked for a clean plate and never saw a card, a mark or lettering; no authored string reaches FFmpeg at all, because the copy becomes pixels before the compositor is invoked.',
            sceneNumber: notification.sceneNumber,
            compositeVersion: notification.result.compositeVersion,
            treatmentVersion: notification.result.treatmentVersion,
            treatment: notification.result.treatment,
            headline: notification.result.headline,
            cardRect: notification.result.cardRect,
            occupiedRect: notification.result.occupiedRect,
            withinSafeBounds: notification.result.withinSafeBounds,
            inputChecksumSha256: notification.inputChecksumSha256,
            outputChecksumSha256: notification.result.checksumSha256,
            logoChecksumSha256: notification.result.logoChecksumSha256,
            notes: notification.result.notes,
            humanJudgementRequired:
              "Whether the card sits in clean space over this particular take, and whether it reads at delivery size, are a person's judgement. The placement measurement that proves clearance belongs to the notification proof, not to this run.",
          }),
        );
      }
    }

    artefacts.push(
      await writeArtefact(
        runDirectory,
        'scene-generation-records.json',
        buildGenerationRecords({ decisions, generated, prepared }),
      ),
    );
    await writePromptFiles(runDirectory, sceneManifest);

    // --- 11. the derived plan and the render --------------------------------
    const derived = deriveRenderPlan({ basePlan, preparedClips: prepared });
    const derivedPlanPath = join(runDirectory, 'derived-render-plan.json');
    await writeDerivedPlan(derivedPlanPath, derived.plan);

    const generatedSceneMedia = new Map<number, GeneratedSceneMedia>();
    for (const [sceneNumber, clip] of prepared) {
      const decision = decisions.find((d) => d.sceneNumber === sceneNumber);
      generatedSceneMedia.set(sceneNumber, {
        absolutePath: clip.absolutePath,
        widthPx: clip.widthPx,
        heightPx: clip.heightPx,
        durationSeconds: clip.usedDurationSeconds,
        provenance: describeProvenance(decision),
        description: `Scene ${sceneNumber} moving source — ${describeProvenance(decision)}. Trimmed to ${clip.usedDurationSeconds.toFixed(2)}s, 9:16 preserved.`,
      });
    }

    // A scene with no moving source renders a still, and there are two
    // candidates: the storyboard package's own 470px contact-sheet crop, and
    // the operator's finished portrait plate for the same scene.
    //
    // The plate is the better picture and it is **not** always the better
    // source. On this campaign the plates for the interface scenes are
    // photographic handsets with *blank* screens — they were shot for an
    // interface to be composited onto, and this milestone does not build that
    // compositor. The storyboard panel for the same scene carries the actual
    // Combat Reviews screen. A scene that declares exact product UI must
    // therefore render the source that contains the product, even though it is
    // the lower-resolution one: a beautiful empty handset is not a
    // demonstration of an application.
    //
    // Stated as a rule rather than a per-scene exception, so the next campaign
    // gets the same answer for the same reason.
    const sceneStillMedia = new Map<number, SceneStillMedia>();
    const plateSubstitutionsDeclined: {
      sceneNumber: number;
      frameId: string;
      reason: string;
    }[] = [];
    if (stagedPlates) {
      for (const decision of decisions) {
        if (prepared.has(decision.sceneNumber)) continue;
        const plate = stagedPlates.plates.find(
          (candidate) => candidate.sceneNumber === decision.sceneNumber,
        );
        if (!plate) continue;
        const scene = sceneManifest.scenes.find(
          (candidate) => candidate.sceneNumber === decision.sceneNumber,
        );
        if (scene?.preserveExactProductUi || scene?.preserveExactTypography) {
          plateSubstitutionsDeclined.push({
            sceneNumber: decision.sceneNumber,
            frameId: plate.frameId,
            reason:
              'this scene declares exact product UI or exact typography, and the authoritative plate for it is a photographic handset with a blank screen. The storyboard panel is rendered instead, because it carries the interface the scene is about.',
          });
          continue;
        }
        sceneStillMedia.set(decision.sceneNumber, {
          absolutePath: plate.stagedAbsolutePath,
          widthPx: plate.widthPx,
          heightPx: plate.heightPx,
          checksumSha256: plate.checksumSha256,
          provenance: 'OPERATOR_AUTHORITATIVE_PLATE',
          description: `Scene ${decision.sceneNumber} still source — the operator's own finished ${plate.widthPx}x${plate.heightPx} plate (${plate.sourceFileName}), staged read-only as ${plate.frameId}. Storyboard art direction, internal review only.`,
        });
      }
    }

    onProgress?.('handing the prepared scenes to the existing flagship render path');
    const flagship = await runFlagshipV2({
      storyboardRoot: options.storyboardRoot,
      workPackRoot,
      ...(options.storyboard01Root ? { storyboard01Root: options.storyboard01Root } : {}),
      campaignDirectory,
      planPath: derivedPlanPath,
      generatedSceneMedia,
      sceneStillMedia,
      outputDirectory: runDirectory,
      binaries: options.binaries,
      workflowRunId: options.workflowRunId,
      now: options.now,
      runner,
      ...(onProgress ? { onProgress } : {}),
    });

    // --- 12. the reports ----------------------------------------------------
    //
    // Measured from the finished file wherever a measurement exists, and
    // written even when the render failed — a report that says what could not
    // be measured is more use than no report at all.
    const benchmark = await findBenchmarkAudio(options.audioBenchmarkDirectory);
    artefacts.push(
      await writeArtefact(
        runDirectory,
        'transition-report.json',
        await buildTransitionReport({
          plan: derived.plan,
          moviePath: flagship.outputPath ?? null,
          runner,
          binaries: options.binaries,
        }),
      ),
    );
    artefacts.push(
      await writeArtefact(
        runDirectory,
        'ui-compositing-report.json',
        buildUiCompositingReport({
          sceneManifest,
          decisions,
          stillSceneNumbers: new Set(sceneStillMedia.keys()),
          plateSubstitutionsDeclined,
        }),
      ),
    );
    artefacts.push(
      await writeArtefact(
        runDirectory,
        'audio-report.json',
        buildAudioReport({
          plan: derived.plan,
          benchmark,
          measured: (flagship.measured as Record<string, unknown> | undefined) ?? null,
        }),
      ),
    );
    artefacts.push(
      await writeArtefact(
        runDirectory,
        'visible-defects-report.json',
        await buildVisibleDefectsReport({
          plan: derived.plan,
          moviePath: flagship.outputPath ?? null,
          framesDirectory: join(runDirectory, 'review-frames'),
          runner,
          binaries: options.binaries,
        }),
      ),
    );

    const finalManifestSourceByScene = await readFinalManifestSources(runDirectory, decisions);
    const outcomes = new Map<number, GenerationOutcomeForReport>();
    for (const decision of decisions) {
      const clip = generated.get(decision.sceneNumber);
      const preparedClip = prepared.get(decision.sceneNumber);
      outcomes.set(decision.sceneNumber, {
        sceneNumber: decision.sceneNumber,
        ltxCalled: clip?.ltxCalled ?? false,
        requestedGenerationSeconds: clip?.requestedDurationSeconds ?? null,
        usedSeconds: preparedClip?.usedDurationSeconds ?? null,
        costCents: clip?.costCents ?? 0,
      });
    }

    artefacts.push(
      await writeArtefact(
        runDirectory,
        'source-decision-report.json',
        buildSourceDecisionReport({ decisions, outcomes, finalManifestSourceByScene }),
      ),
    );

    const actualCostCents = [...generated.values()].reduce((sum, clip) => sum + clip.costCents, 0);
    const ltxCallCount = [...generated.values()].filter((clip) => clip.ltxCalled).length;

    artefacts.push(
      await writeArtefact(runDirectory, 'provenance.json', {
        runVersion: STORYBOARD_VIDEO_RUN_VERSION,
        workflowRunId: options.workflowRunId,
        executionMode: V2_EXECUTION_MODE,
        outputUse: V2_OUTPUT_USE,
        isRealCampaignRun: V2_IS_REAL_CAMPAIGN_RUN,
        isPublicReleaseReady: V2_IS_PUBLIC_RELEASE_READY,
        requiresHumanApproval: true,
        reasoningProviderCalls: 0,
        videoGenerationProviderCalls: ltxCallCount,
        paidProviderCalls: ltxCallCount,
        actualCostCents,
        maximumEstimatedCostCents: costEstimate.maximumTotalCostCents,
        pricingProfileVersion: costEstimate.pricingProfileVersion,
        responseContractStatus: LTX_RESPONSE_CONTRACT_STATUS,
        model: options.model,
        planAuthoredBy: basePlan.authoredBy,
        sceneManifestAuthoredBy: sceneManifest.authoredBy,
        derivedPlanChanges: derived.changes,
        sceneProvenance: decisions.map((decision) => {
          const row = review.gate.rows.find(
            (candidate) => candidate.sceneNumber === decision.sceneNumber,
          );
          const inspection = review.inspectionsByScene.get(decision.sceneNumber);
          return {
            sceneNumber: decision.sceneNumber,
            sceneRole: decision.sceneRole,
            sourceType: decision.selectedSourceType,
            identifier: decision.selectedIdentifier,
            generationProvenance: decision.generationProvenance ?? null,
            sourceClipChecksumSha256: inspection?.clipChecksumSha256 ?? null,
            motionReviewStatus: row?.status ?? 'NOT_REVIEWABLE',
            motionApprovedBy: row?.decidedBy ?? null,
            motionApprovedAt: row?.decidedAt ?? null,
            motionDecisionId: row?.decisionId ?? null,
            acknowledgedFidelityFindings: inspection?.openFidelityFindings ?? [],
          };
        }),
        motionGate: {
          evaluatedAt: review.gate.evaluatedAt,
          clears: review.gate.clears,
          reviewDirectory,
          galleryPath: review.galleryPath,
          notice: review.gate.notice,
        },
        outputIntent,
        productionUseAuthorised: false,
        stagedPlates: stagedPlates
          ? {
              sourceDirectory: stagedPlates.sourceDirectory,
              plates: stagedPlates.plates.map((plate) => ({
                frameId: plate.frameId,
                sourceFileName: plate.sourceFileName,
                checksumSha256: plate.checksumSha256,
                widthPx: plate.widthPx,
                heightPx: plate.heightPx,
              })),
            }
          : null,
        defectSubstitutions,
        postMotionScenes: applied.map((result) => ({
          sceneNumber: result.sceneNumber,
          treatment: result.compiled.treatment,
          magnitudePercent: result.compiled.magnitudePercent,
          direction: result.compiled.direction,
          outputChecksumSha256: result.outputChecksumSha256,
        })),
        regeneratedBecauseRejected: [...regeneratedRejectedScenes].sort((a, b) => a - b),
        manualClipNotice:
          preGeneratedClips.clips.length > 0
            ? `${preGeneratedClips.clips.length} scene(s) use footage animated by hand in LTX Studio (${MANUAL_GENERATION_PROVENANCE}). This pipeline did not produce those bytes and does not claim to have generated them.`
            : null,
        master: {
          path: flagship.outputPath ?? null,
          qaVerdict: flagship.qaVerdict ?? null,
          measured: flagship.measured ?? null,
        },
        caveat:
          outputIntent === 'FULL_LENGTH_REVIEW_CANDIDATE'
            ? 'FULL_LENGTH_REVIEW_CANDIDATE — a locked storyboard supplied by the operator, animated from approved production keyframes and real acquired footage, assembled so a person can judge the whole cut. Every moving scene in it is PENDING_HUMAN_REVIEW: nothing here approves anything, creative quality is not assessed, and this file is not a production master.'
            : 'HUMAN_ASSISTED_PREVIEW — a locked storyboard supplied by the operator, animated from approved production keyframes and real acquired footage. Creative quality is not assessed and human approval is required before publication.',
      }),
    );

    if (flagship.exitCode !== 0) {
      return {
        exitCode:
          flagship.exitCode === 8
            ? STORYBOARD_VIDEO_EXIT_CODES.QA_FAILURE
            : STORYBOARD_VIDEO_EXIT_CODES.FINAL_RENDER_FAILURE,
        runDirectory,
        dryRun: false,
        costEstimate,
        decisions,
        nextRequiredGenerationScene: nextScene?.sceneNumber ?? null,
        generatedSceneCount: prepared.size,
        ltxCallCount,
        actualCostCents,
        ...(flagship.outputPath ? { outputPath: flagship.outputPath } : {}),
        ...(flagship.qaVerdict ? { qaVerdict: flagship.qaVerdict } : {}),
        artefacts,
        motionGate: review.gate,
        ...(review.galleryPath ? { motionReviewGalleryPath: review.galleryPath } : {}),
        regeneratedRejectedScenes,
        outputIntent,
        ...(stagedPlates ? { stagedPlates } : {}),
        postMotion: applied,
        defectSubstitutions,
        failure: flagship.failure ?? 'the render path failed',
      };
    }

    return {
      exitCode: STORYBOARD_VIDEO_EXIT_CODES.SUCCESS,
      runDirectory,
      dryRun: false,
      costEstimate,
      decisions,
      nextRequiredGenerationScene: nextRequiredGenerationScene(decisions)?.sceneNumber ?? null,
      generatedSceneCount: prepared.size,
      ltxCallCount,
      actualCostCents,
      ...(flagship.outputPath ? { outputPath: flagship.outputPath } : {}),
      ...(flagship.qaVerdict ? { qaVerdict: flagship.qaVerdict } : {}),
      ...(flagship.measured ? { measured: flagship.measured } : {}),
      ...(flagship.galleryPath ? { galleryPath: flagship.galleryPath } : {}),
      artefacts,
      motionGate: review.gate,
      ...(review.galleryPath ? { motionReviewGalleryPath: review.galleryPath } : {}),
      regeneratedRejectedScenes,
      outputIntent,
      ...(stagedPlates ? { stagedPlates } : {}),
      postMotion: applied,
      defectSubstitutions,
    };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Which generating scenes a byte-verified cached clip already covers.
 *
 * Consulted before the cost estimate so both ceilings bind on real spend. A
 * scene the operator named with `--regenerate-scene` is excluded whatever the
 * cache holds: it is going to be bought again on purpose, and an estimate that
 * called it free would understate exactly the request the operator asked for.
 *
 * A lookup failure is a miss, not an error — the same rule the cache itself
 * follows — so a corrupt cache produces an honest "this will be bought" rather
 * than a refusal.
 */
export async function findCachedScenes(input: {
  readonly decisions: readonly SceneSourceDecision[];
  readonly sceneManifest: SceneManifest;
  readonly keyframes: KeyframeLibrary;
  readonly cache: GenerationCache;
  readonly model: LtxModel;
  readonly generateAudio: boolean;
  readonly regenerateScenes: ReadonlySet<number>;
  readonly requiredFor: (sceneNumber: number) => number;
}): Promise<Set<number>> {
  const cached = new Set<number>();
  for (const decision of input.decisions) {
    if (!decision.requiresGeneration) continue;
    if (input.regenerateScenes.has(decision.sceneNumber)) continue;
    const scene = input.sceneManifest.scenes.find(
      (candidate) => candidate.sceneNumber === decision.sceneNumber,
    );
    const keyframe = input.keyframes.frames.find(
      (frame) => frame.frameId === decision.generationInputFrameId,
    );
    if (!scene || !keyframe) continue;
    const lastFrame = scene.lastFrame
      ? input.keyframes.frames.find((frame) => frame.frameId === scene.lastFrame)
      : undefined;
    const key = sceneCacheKey({
      scene,
      keyframe,
      ...(lastFrame ? { lastFrame } : {}),
      model: input.model,
      generateAudio: input.generateAudio,
      requiredSourceSeconds: input.requiredFor(decision.sceneNumber),
    });
    // eslint-disable-next-line no-await-in-loop -- deterministic order
    if (await input.cache.lookup(key)) cached.add(decision.sceneNumber);
  }
  return cached;
}

export const NOTIFICATION_DIRECTORY = 'notification-composite';

export interface AppliedNotification {
  readonly sceneNumber: number;
  readonly inputChecksumSha256: string;
  readonly outputPath: string;
  readonly result: NotificationCompositeResult;
}

/**
 * Composites the locked notification treatment onto the scene the brief names.
 *
 * Returns `null` — rather than throwing — when that scene has no moving clip
 * in this cut, because the honest reading of "the scene the notification
 * belongs to is not moving picture here" is that there is nothing to composite
 * onto, not that the run is broken. Every other failure is the compositor's own
 * typed refusal and propagates.
 */
export async function compositeSceneNotification(input: {
  readonly briefPath: string;
  readonly prepared: ReadonlyMap<number, PreparedSceneClip>;
  readonly workPackRoot: string;
  readonly outputDirectory: string;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly onProgress?: (message: string) => void;
}): Promise<AppliedNotification | null> {
  const brief = await loadAcceptanceBrief(input.briefPath);
  const sceneNumber = brief.scene.sceneNumber;
  const clip = input.prepared.get(sceneNumber);
  if (!clip) {
    input.onProgress?.(
      `scene ${sceneNumber} has no moving clip in this cut, so the notification treatment has nothing to composite onto`,
    );
    return null;
  }

  const outputPath = join(
    input.outputDirectory,
    `scene-${String(sceneNumber).padStart(2, '0')}-notification.mp4`,
  );
  input.onProgress?.(
    `scene ${sceneNumber}: compositing the locked notification treatment (surface design v${brief.notification.surfaceDesignVersion}) after the motion`,
  );

  const result = await compositeNotification({
    sourceClipPath: clip.absolutePath,
    outputPath,
    notification: brief.notification,
    logoPath: join(input.workPackRoot, 'asset-root', 'brand', 'logo.png'),
    outputDurationSeconds: clip.usedDurationSeconds,
    runner: input.runner,
    binaries: input.binaries,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });

  return {
    sceneNumber,
    inputChecksumSha256: clip.checksumSha256,
    outputPath,
    result,
  };
}

/**
 * Every moving scene in a review candidate, and what a person still has to
 * decide about it.
 *
 * Written as its own artefact rather than left inside the gate report, because
 * the two answer different questions: the gate says whether the run may
 * proceed, and this says what is outstanding. It records no verdict and no
 * reviewer — a run cannot approve anything, and there is no flag that writes
 * one.
 */
export function buildPendingReviewLedger(input: {
  readonly gate: MotionGateReport;
  readonly reviewDirectory: string;
  readonly galleryPath: string | null;
  readonly defectSubstitutions?: readonly DefectSubstitution[];
}): unknown {
  const substituted = new Set(
    (input.defectSubstitutions ?? []).map((substitution) => substitution.sceneNumber),
  );
  const rows = input.gate.rows.map((row) => ({
    sceneNumber: row.sceneNumber,
    sceneRole: row.sceneRole,
    sourceType: row.sourceType,
    // A demoted scene has no generated motion in the cut, so there is nothing
    // for a reviewer to approve about it — what it needs is a decision about
    // whether to pay for a replacement.
    reviewStatus: substituted.has(row.sceneNumber)
      ? 'NOT_IN_THIS_CUT — the generated clip failed inspection and its still was rendered instead'
      : row.status === 'APPROVED'
        ? 'APPROVED'
        : 'PENDING_HUMAN_REVIEW',
    gateStatus: row.status,
    clipChecksumSha256: row.clipChecksumSha256,
    reviewIdentitySha256: row.identitySha256,
    inspectionVerdict: row.inspectionVerdict,
    openFidelityFindings: row.openFidelityFindings,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    decisionId: row.decisionId,
    nextAction: row.remedy,
  }));
  return {
    notice:
      'This run approved nothing and cannot. Every row below is a decision a named person still has to make about specific bytes, and no flag on any command writes one on their behalf.',
    outputIntent: 'FULL_LENGTH_REVIEW_CANDIDATE',
    productionUseAuthorised: false,
    evaluatedAt: input.gate.evaluatedAt,
    reviewDirectory: input.reviewDirectory,
    motionReviewGalleryPath: input.galleryPath,
    pendingSceneCount: rows.filter((row) => row.reviewStatus === 'PENDING_HUMAN_REVIEW').length,
    defectSubstitutions: input.defectSubstitutions ?? [],
    rows,
    howToDecide:
      'Open the motion-review gallery, then record each decision with "pnpm aamp:motion-review approve --scene <n>" or "… reject --scene <n>". An approval binds to the clip bytes, the authoritative keyframe, the generation prompt and the scene contract, so it stops applying if any of the four moves.',
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Which scenes a reviewer has refused, as things stand.
 *
 * Costs one inspection pass and no money. It runs *before* the cost estimate
 * so a rejected scene's regeneration is priced into the ceiling the operator
 * authorises, rather than discovered after the estimate was printed.
 */
async function findRejectedScenes(input: {
  context: StoryboardVideoContext;
  ledger: MotionReviewLedger;
  reviewDirectory: string;
  runner: CommandRunner;
  binaries: FfmpegBinaries;
  now: Date;
}): Promise<readonly number[]> {
  const review = await runMotionReview({
    context: input.context,
    reviewDirectory: input.reviewDirectory,
    ledger: input.ledger,
    runner: input.runner,
    binaries: input.binaries,
    now: input.now,
    writeGallery: false,
  });
  return review.gate.rows
    .filter((row) => row.status === 'REJECTED')
    .filter(
      (row) => row.sourceType === 'LTX_GENERATED' || row.sourceType === 'PRE_GENERATED_MANUAL_CLIP',
    )
    .map((row) => row.sceneNumber);
}

/**
 * The clip checksums a reviewer has already approved, taken before generation.
 *
 * The point is not to detect a deliberate replacement — an identity change
 * already invalidates the approval and blocks the gate. It is to catch a
 * selective regeneration that touched a scene it was never asked to touch,
 * which would otherwise show up only as a gate refusal with no explanation of
 * what moved.
 */
function collectApprovedClipChecksums(
  context: StoryboardVideoContext,
  ledger: MotionReviewLedger,
): ReadonlyMap<number, string> {
  const approved = new Map<number, string>();
  for (const decision of context.decisions) {
    if (!sceneNeedsMotionReview(decision)) continue;
    const latest = ledger.latestAny(decision.sceneNumber);
    if (latest?.verdict === 'APPROVED') {
      approved.set(decision.sceneNumber, latest.identity.clipChecksumSha256);
    }
  }
  return approved;
}

function assertApprovedClipsUnchanged(input: {
  before: ReadonlyMap<number, string>;
  after: ReadonlyMap<number, { readonly clipChecksumSha256: string }>;
}): void {
  const changed: string[] = [];
  for (const [sceneNumber, checksum] of input.before) {
    const now = input.after.get(sceneNumber)?.clipChecksumSha256;
    // A scene that dropped out of the inspection set entirely is not a change
    // to an approved file; the gate reports that as its own status.
    if (now && now !== checksum) {
      changed.push(
        `scene ${sceneNumber} (approved ${checksum.slice(0, 16)}…, now ${now.slice(0, 16)}…)`,
      );
    }
  }
  if (changed.length === 0) return;
  throw new StoryboardVideoError(
    'MOTION_REVIEW_BLOCKED',
    `this run changed the bytes of ${changed.length} scene(s) a reviewer had already approved: ${changed.join(
      '; ',
    )}. Selective regeneration must leave approved clips byte-identical; nothing has been composited.`,
  );
}

interface MovingSource {
  readonly absolutePath: string;
  readonly durationSeconds: number;
}

/**
 * The clip a scene renders, and how long it runs.
 *
 * The path comes from `movingSourcePathFor`, the same function the review uses,
 * so the file that was inspected and the file that is trimmed are the same
 * file by construction rather than by two implementations happening to agree.
 * Only the measured duration is looked up here, because the review has no use
 * for it.
 *
 * A capture or a deterministic-motion-graphics scene has no moving source and
 * keeps its still panel, which the flagship path stages exactly as it always
 * has.
 */
function resolveMovingSourcePath(input: {
  decision: SceneSourceDecision;
  generated: ReadonlyMap<number, GeneratedSceneClip>;
  preGeneratedClips: PreGeneratedClipLibrary;
  footagePack: FootagePack | null;
}): MovingSource | null {
  const { decision } = input;
  const absolutePath = movingSourcePathFor({
    decision,
    preGeneratedClips: input.preGeneratedClips,
    footagePack: input.footagePack,
    generatedPathsByScene: new Map(
      [...input.generated.entries()].map(([sceneNumber, clip]) => [sceneNumber, clip.originalPath]),
    ),
  });
  if (!absolutePath) return null;

  const durationSeconds =
    decision.selectedSourceType === 'LTX_GENERATED'
      ? input.generated.get(decision.sceneNumber)?.originalDurationSeconds
      : decision.selectedSourceType === 'PRE_GENERATED_MANUAL_CLIP'
        ? input.preGeneratedClips.clips.find(
            (candidate) => candidate.sceneNumber === decision.sceneNumber,
          )?.durationSeconds
        : input.footagePack?.originals.find(
            (candidate) => candidate.assetId === decision.acquiredAssetId,
          )?.measured.durationSeconds;

  return durationSeconds === undefined ? null : { absolutePath, durationSeconds };
}

function describeProvenance(decision: SceneSourceDecision | undefined): string {
  if (!decision) return 'UNKNOWN';
  if (decision.selectedSourceType === 'PRE_GENERATED_MANUAL_CLIP') {
    return `${MANUAL_GENERATION_PROVENANCE} (animated by hand outside this pipeline)`;
  }
  if (decision.selectedSourceType === 'LTX_GENERATED') {
    return `${decision.generationProvenance ?? 'AAMP_LTX_HOSTED_PROVIDER'} (generated by this pipeline)`;
  }
  return decision.selectedSourceType;
}

function buildGenerationRecords(input: {
  decisions: readonly SceneSourceDecision[];
  generated: ReadonlyMap<number, GeneratedSceneClip>;
  prepared: ReadonlyMap<number, PreparedSceneClip>;
}): unknown {
  return {
    note: 'One row per scene. "requested" is what was bought; "used" is what the cut kept; the difference is recorded rather than hidden.',
    scenes: input.decisions.map((decision) => {
      const clip = input.generated.get(decision.sceneNumber);
      const prepared = input.prepared.get(decision.sceneNumber);
      return {
        sceneNumber: decision.sceneNumber,
        sceneRole: decision.sceneRole,
        sourceType: decision.selectedSourceType,
        generationProvenance: decision.generationProvenance ?? null,
        ltxCalled: clip?.ltxCalled ?? false,
        cacheHit: clip?.cacheHit ?? false,
        model: clip?.model ?? null,
        promptSha256: clip?.promptSha256 ?? null,
        requestedDurationSeconds: clip?.requestedDurationSeconds ?? null,
        originalDurationSeconds: clip?.originalDurationSeconds ?? null,
        originalChecksumSha256: clip?.originalChecksumSha256 ?? null,
        usedInSeconds: prepared?.usedInSeconds ?? null,
        usedDurationSeconds: prepared?.usedDurationSeconds ?? null,
        discardedSeconds: prepared?.discardedSeconds ?? null,
        trimmedChecksumSha256: prepared?.checksumSha256 ?? null,
        costCents: clip?.costCents ?? 0,
      };
    }),
  };
}

/** The exact submitted prompt per scene, and its checksum. No credential, no URL. */
async function writePromptFiles(runDirectory: string, sceneManifest: SceneManifest): Promise<void> {
  const directory = join(runDirectory, 'ltx-prompts');
  await mkdir(directory, { recursive: true });
  for (const scene of sceneManifest.scenes) {
    if (!modeReachesGenerationProvider(scene.generationMode)) continue;
    const name = `scene-${String(scene.sceneNumber).padStart(2, '0')}`;
    // eslint-disable-next-line no-await-in-loop -- deterministic order
    await writeFile(join(directory, `${name}.txt`), `${scene.motionPrompt}\n`, 'utf8');
    // eslint-disable-next-line no-await-in-loop -- deterministic order
    await writeFile(
      join(directory, `${name}.sha256.json`),
      `${JSON.stringify(
        {
          sceneNumber: scene.sceneNumber,
          cameraMotion: scene.cameraMotion,
          promptSha256: createHash('sha256').update(scene.motionPrompt, 'utf8').digest('hex'),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
}

/**
 * What the finished render manifest actually resolved per scene.
 *
 * Read back from the manifest on disk rather than from in-memory state,
 * because the manifest is the thing the report is making a claim about.
 */
async function readFinalManifestSources(
  runDirectory: string,
  decisions: readonly SceneSourceDecision[],
): Promise<Map<number, { assetId: string; checksumSha256: string | null }>> {
  const byScene = new Map<number, { assetId: string; checksumSha256: string | null }>();
  try {
    const manifest = parseRenderManifest(
      JSON.parse(await readFile(join(runDirectory, 'render-manifest.json'), 'utf8')),
    );
    for (const decision of decisions) {
      const expected = `storyboard-panel-${String(decision.sceneNumber).padStart(2, '0')}`;
      const source = manifest.sources.find((candidate) => candidate.id === expected);
      if (source) {
        byScene.set(decision.sceneNumber, {
          assetId: source.id,
          checksumSha256: (source.expectedChecksum as string | undefined) ?? null,
        });
      }
    }
  } catch {
    // The manifest is absent when the render never reached that stage. An
    // empty map is the honest answer; the report prints null rather than a
    // value it could not read.
  }
  return byScene;
}

export { probeClip };

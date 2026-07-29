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
} from '../flagship/run-flagship-v2';
import { assertStoryboardVideoArtefactSafe } from './artefact-safety';
import {
  assertWithinCostCeiling,
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
  sceneNeedsMotionReview,
  type MotionGateReport,
} from './motion-review-gate';
import { runMotionReview, type MotionReviewOutcome } from './motion-review-run';
import { DEFAULT_MOTION_REVIEW_DIRECTORY, MotionReviewLedger } from './motion-review-store';
import { MANUAL_GENERATION_PROVENANCE, type PreGeneratedClipLibrary } from './pre-generated-clips';
import {
  generateSceneClip,
  prepareSceneClip,
  probeClip,
  type GeneratedSceneClip,
  type PreparedSceneClip,
} from './scene-media';
import { modeReachesGenerationProvider, type SceneManifest } from './scene-manifest';
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

export interface StoryboardVideoOptions {
  readonly storyboardRoot: string;
  readonly framesDirectory: string;
  readonly outputDirectory: string;
  readonly workPackRoot: string;
  readonly campaignDirectory: string;
  readonly model: LtxModel;
  readonly maxCostCents: number;
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
  const artefacts: string[] = [];
  await mkdir(runDirectory, { recursive: true });

  // Held outside the try so a failure can still report the gate a person needs
  // to act on. A refusal that will not say which scenes blocked it is a
  // refusal an operator has to reproduce before they can fix anything.
  let motionReview: MotionReviewOutcome | null = null;

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
      ...(motionReview ? { motionGate: motionReview.gate } : {}),
      ...(motionReview?.galleryPath ? { motionReviewGalleryPath: motionReview.galleryPath } : {}),
    };
  };

  try {
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
        framesDirectory: options.framesDirectory,
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
    const costEstimate = buildCostEstimate({
      decisions,
      model: options.model,
      resolution: LTX_SUPPORTED_RESOLUTION,
      ceilingCents: options.maxCostCents,
      requiredSourceSecondsForScene: requiredFor,
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
        model: options.model,
        resolution: LTX_SUPPORTED_RESOLUTION,
        fps: LTX_SUPPORTED_FPS,
        generateAudio: options.generateAudio,
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

    const cache = await GenerationCache.open(join(runDirectory, 'generation-cache'));
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
          reviewDirectory,
          galleryPath: review.galleryPath,
          renderStarted: false,
          ffmpegCompositionStarted: false,
          gate: review.gate,
        }),
      );
    }
    assertMotionGateClears(review.gate);
    onProgress?.(
      `motion gate cleared — ${review.gate.rows.length} moving scene(s) carry a standing approval`,
    );

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

    onProgress?.('handing the prepared scenes to the existing flagship render path');
    const flagship = await runFlagshipV2({
      storyboardRoot: options.storyboardRoot,
      workPackRoot,
      ...(options.storyboard01Root ? { storyboard01Root: options.storyboard01Root } : {}),
      campaignDirectory,
      planPath: derivedPlanPath,
      generatedSceneMedia,
      outputDirectory: runDirectory,
      binaries: options.binaries,
      workflowRunId: options.workflowRunId,
      now: options.now,
      runner,
      ...(onProgress ? { onProgress } : {}),
    });

    // --- 12. the reports ----------------------------------------------------
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
          'HUMAN_ASSISTED_PREVIEW — a locked storyboard supplied by the operator, animated from approved production keyframes and real acquired footage. Creative quality is not assessed and human approval is required before publication.',
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
    };
  } catch (error) {
    return fail(error);
  }
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

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { NodeCommandRunner, type CommandRunner, type FfmpegBinaries } from '@combat/media';
import {
  assertSupportedLtxDuration,
  assertSupportedLtxFps,
  assertSupportedLtxModel,
  createLtxHostedProvider,
  ltxGenerationCostCents,
  LTX_POLL_INTERVAL_MS,
  LTX_PRICING_PROFILE_VERSION,
  LTX_RESPONSE_CONTRACT_STATUS,
  LTX_SUPPORTED_FPS,
  LTX_SUPPORTED_HEIGHT_PX,
  LTX_SUPPORTED_RESOLUTION,
  LTX_SUPPORTED_WIDTH_PX,
  type LtxModel,
  type VideoGenerationProvider,
} from '@combat/providers';

import { assertStoryboardVideoArtefactSafe } from '../storyboard-video/artefact-safety';
import {
  STORYBOARD_VIDEO_EXIT_CODES,
  StoryboardVideoError,
  type StoryboardVideoExitCode,
} from '../storyboard-video/failures';
import { GenerationCache, computeGenerationCacheKey } from '../storyboard-video/generation-cache';
import type { ResolvedKeyframe } from '../storyboard-video/keyframe-library';
import {
  inspectSceneMotion,
  MOTION_INSPECTION_PROFILE_VERSION,
  type SceneMotionInspection,
} from '../storyboard-video/motion-inspection';
import { PROVIDER_GENERATION_PROVENANCE } from '../storyboard-video/pre-generated-clips';
import { assertPromptsAreSafe } from '../storyboard-video/prompt-safety';
import {
  probeClip,
  translateProviderError,
  SCENE_TRIM_HANDLE_SECONDS,
} from '../storyboard-video/scene-media';
import type { SceneSourceDecision } from '../storyboard-video/source-precedence';
import {
  ACCEPTANCE_SCENE_NUMBER,
  ACCEPTANCE_SCENE_ROLE,
  loadAcceptanceBrief,
  type AcceptanceBrief,
} from './acceptance-brief';
import { writeComparisonGallery, COMPARISON_GALLERY_FILENAME } from './comparison-gallery';
import { compositeNotification, type NotificationCompositeResult } from './notification-composite';
import { CountingFetch, OneRequestVideoGenerationProvider } from './one-request-guard';
import {
  assertNotPermanentlyRejected,
  PERMANENTLY_REJECTED_CLIP_NOTE,
  requirePlate,
  resolvePlateLibrary,
  type PlateLibrary,
} from './plate-library';
import { preparePlateForUpload, type PlatePreparation } from './plate-staging';
import { surveyRawClip, type RawClipSurvey } from './raw-clip-inspection';
import { buildPendingReviewRecord, type PendingReviewRecord } from './review-record';
import { buildVisualDefectReport, type VisualDefectReport } from './visual-defects';

/**
 * One Scene-1 plate, one capped LTX request, one raw clip, one composited
 * review cut, and a human review left open.
 *
 * The order of the stages is the design, and it is the order the existing
 * storyboard-video run already uses: **everything that can refuse the run
 * happens before anything that costs money.** The brief is validated, the ten
 * plates are discovered and measured, FRAME-01 is bound, the prompt is gated,
 * the plate is staged and its upload bytes prepared, the cost is computed and
 * compared against the ceiling — and only then is a single byte uploaded.
 *
 * What this deliberately does *not* do is render the fifteen-second cut. It
 * proves one scene, from the new authoritative plate, at a bounded cost, and
 * hands a person the evidence to decide whether that scene is a production
 * source. Scenes 2–10 are not generated and no master is produced.
 *
 * Nothing here approves anything. The run's own conclusion is
 * `VISUAL_REVIEW_PENDING`, always, because the only thing that can close it is
 * a named person's recorded decision.
 */

export const SCENE_ACCEPTANCE_RUN_VERSION = 1 as const;

/** Exactly one paid request. Not configurable, and asserted in the report. */
export const AUTHORISED_REQUEST_COUNT = 1 as const;

export type TechnicalVerdict = 'TECHNICALLY_VALID' | 'TECHNICALLY_REJECTED';
export const VISUAL_REVIEW_STATUS = 'VISUAL_REVIEW_PENDING' as const;

export interface SceneAcceptanceOptions {
  readonly platesDirectory: string;
  readonly briefPath: string;
  readonly outputDirectory: string;
  /** The owned Combat Reviews mark, overlaid into the notification card. */
  readonly logoPath: string;
  readonly maxCostCents: number;
  readonly dryRun: boolean;
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
  readonly reviewDirectory?: string;
  readonly onProgress?: (message: string) => void;
}

export interface SceneAcceptanceResult {
  readonly exitCode: StoryboardVideoExitCode;
  readonly runDirectory: string;
  readonly dryRun: boolean;
  readonly model: string;
  readonly plateFrameId: string;
  readonly platePath?: string;
  readonly plateChecksumSha256?: string;
  readonly requestedDurationSeconds: number;
  readonly maximumCostCents: number;
  readonly ceilingCents: number;
  /** Billable submissions actually made. Zero on a dry run and on a cache hit. */
  readonly ltxRequestCount: number;
  readonly networkRequestCount: number;
  readonly cacheHit: boolean;
  readonly costChargedCents: number | null;
  readonly costBasis: string;
  readonly rawClipPath?: string;
  readonly rawClipChecksumSha256?: string;
  readonly compositedClipPath?: string;
  readonly galleryPath?: string;
  readonly contactSheetPath?: string;
  readonly technicalVerdict?: TechnicalVerdict;
  readonly reviewStatus?: typeof VISUAL_REVIEW_STATUS;
  readonly safeAsProductionSource?: boolean;
  readonly measured?: SceneMotionInspection['measured'];
  readonly artefacts: readonly string[];
  readonly failure?: string;
  readonly failureKind?: string;
}

const RAW_DIRECTORY = 'raw';
const INSPECTION_DIRECTORY = 'inspection';
const COMPOSITED_DIRECTORY = 'composited';

async function writeArtefact(runDirectory: string, name: string, value: unknown): Promise<string> {
  assertStoryboardVideoArtefactSafe(value, name);
  const target = join(runDirectory, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return name;
}

export async function runSceneAcceptance(
  options: SceneAcceptanceOptions,
): Promise<SceneAcceptanceResult> {
  const runner = options.runner ?? new NodeCommandRunner();
  const runDirectory = resolve(options.outputDirectory);
  const onProgress = options.onProgress;
  const artefacts: string[] = [];
  const counting = new CountingFetch(options.fetchImpl ?? globalThis.fetch);
  await mkdir(runDirectory, { recursive: true });

  const fail = (error: unknown, partial: Partial<SceneAcceptanceResult>): SceneAcceptanceResult => {
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
      model: partial.model ?? 'unresolved',
      plateFrameId: 'FRAME-01',
      requestedDurationSeconds: partial.requestedDurationSeconds ?? 0,
      maximumCostCents: partial.maximumCostCents ?? 0,
      ceilingCents: options.maxCostCents,
      ltxRequestCount: partial.ltxRequestCount ?? 0,
      networkRequestCount: counting.requestCount,
      cacheHit: partial.cacheHit ?? false,
      costChargedCents: partial.costChargedCents ?? null,
      costBasis: partial.costBasis ?? 'NOT_APPLICABLE — the run did not reach a paid request',
      artefacts,
      failure: typed.message,
      failureKind: typed.kind,
      ...partial,
    };
  };

  let brief: AcceptanceBrief | undefined;
  let model: LtxModel | undefined;
  let maximumCostCents = 0;
  let guarded: OneRequestVideoGenerationProvider | undefined;

  try {
    // --- 1. the authored brief -------------------------------------------------
    onProgress?.('reading the Scene-1 acceptance brief');
    brief = await loadAcceptanceBrief(options.briefPath);

    model = assertSupportedLtxModel(brief.model);
    const requestedDurationSeconds = assertSupportedLtxDuration(brief.generationDurationSeconds);
    assertSupportedLtxFps(LTX_SUPPORTED_FPS);

    // --- 2. the authoritative plates -----------------------------------------
    onProgress?.(`inventorying the authoritative plates in ${options.platesDirectory}`);
    const plates = await resolvePlateLibrary({
      platesDirectory: options.platesDirectory,
      runner,
      binaries: options.binaries,
    });
    const plate = requirePlate(plates, brief.plateFrameId);
    onProgress?.(
      `all ${plates.plates.length} plates present; ${plate.frameId} resolves to ${plate.fileName} (${plate.widthPx}x${plate.heightPx}, ${plate.orientation})`,
    );

    // --- 3. the prompt gate, before anything is staged ------------------------
    const checkedPrompts = assertPromptsAreSafe([brief.scene], () => true);

    // --- 4. cost, before anything is staged, resampled or uploaded ------------
    const unitCostCents = ltxGenerationCostCents(
      model,
      LTX_SUPPORTED_RESOLUTION,
      requestedDurationSeconds,
    );
    maximumCostCents = unitCostCents * AUTHORISED_REQUEST_COUNT;
    const ceilingCents = Math.min(options.maxCostCents, brief.maximumAuthorisedCostCents);
    if (maximumCostCents > ceilingCents) {
      throw new StoryboardVideoError(
        'COST_CEILING_EXCEEDED',
        `one ${requestedDurationSeconds}s ${model} generation at ${LTX_SUPPORTED_RESOLUTION} costs at most ${maximumCostCents}¢, over the ${ceilingCents}¢ ceiling. Nothing has been uploaded and nothing has been spent.`,
      );
    }

    // --- 5. staging and the upload bytes --------------------------------------
    const preparation = await preparePlateForUpload({
      plate,
      outputDirectory: runDirectory,
      runner,
      binaries: options.binaries,
      ...(onProgress ? { onProgress } : {}),
    });

    // Keyed on the *source* plate rather than on the resampled upload: the
    // resample is a deterministic function of the plate, so the two are
    // equivalent, and keying on the source keeps the key computable before any
    // file is written.
    const cacheKey = computeGenerationCacheKey({
      inputFrameChecksumSha256: plate.checksumSha256,
      motionPromptSha256: checkedPrompts[0]?.promptSha256 ?? '',
      model,
      durationSeconds: requestedDurationSeconds,
      resolution: LTX_SUPPORTED_RESOLUTION,
      fps: LTX_SUPPORTED_FPS,
      generateAudio: brief.generateAudio,
      cameraMotion: brief.scene.cameraMotion,
    });

    const runPlan = buildRunPlan({
      brief,
      model,
      requestedDurationSeconds,
      plates,
      preparation,
      cacheKey,
      unitCostCents,
      maximumCostCents,
      ceilingCents,
      workflowRunId: options.workflowRunId,
      dryRun: options.dryRun,
    });
    artefacts.push(await writeArtefact(runDirectory, 'scene-01-run-plan.json', runPlan));
    await writePromptSnapshot(runDirectory, brief, checkedPrompts[0]?.promptSha256 ?? '');
    artefacts.push('generation-prompt.txt', 'generation-prompt.sha256.json');

    onProgress?.(
      `resolved ${plate.frameId} → ${plate.absolutePath} (sha256 ${plate.checksumSha256.slice(0, 16)}…); ${model}, ${requestedDurationSeconds}s, ${LTX_SUPPORTED_RESOLUTION}, ${LTX_SUPPORTED_FPS}fps, generate_audio=${brief.generateAudio}; ${AUTHORISED_REQUEST_COUNT} request, maximum ${maximumCostCents}¢ against a ${ceilingCents}¢ ceiling`,
    );

    // --- 6. the dry run stops here, having contacted and spent nothing --------
    if (options.dryRun) {
      if (counting.requestCount !== 0) {
        throw new StoryboardVideoError(
          'JOB_SUBMISSION_FAILED',
          `the dry run made ${counting.requestCount} network request(s); it must make none`,
        );
      }
      onProgress?.(
        'dry run complete — no API key was read, no request was made and nothing was spent',
      );
      return {
        exitCode: STORYBOARD_VIDEO_EXIT_CODES.SUCCESS,
        runDirectory,
        dryRun: true,
        model,
        plateFrameId: plate.frameId,
        platePath: plate.absolutePath,
        plateChecksumSha256: plate.checksumSha256,
        requestedDurationSeconds,
        maximumCostCents,
        ceilingCents,
        ltxRequestCount: 0,
        networkRequestCount: counting.requestCount,
        cacheHit: false,
        costChargedCents: 0,
        costBasis: 'DRY_RUN — nothing was submitted, so nothing was charged',
        artefacts,
      };
    }

    // --- 7. exactly one live request ------------------------------------------
    const cache = await GenerationCache.open(join(runDirectory, 'generation-cache'));
    const cached = await cache.lookup(cacheKey);

    let rawClipPath: string;
    let rawChecksum: string;
    let costChargedCents: number | null;
    let costBasis: string;
    let cacheHit = false;

    if (cached) {
      onProgress?.(
        'a byte-verified cached generation for exactly these inputs already exists — no upload, no request, no charge',
      );
      rawClipPath = cache.absolutePathFor(cached);
      rawChecksum = cached.checksumSha256;
      costChargedCents = 0;
      costBasis =
        'CACHE_HIT — these exact inputs were already generated and paid for by an earlier run. This run made no request and spent nothing.';
      cacheHit = true;
    } else {
      const inner =
        options.providerOverride ??
        buildProvider({ options, model, runDirectory, fetchImpl: counting.fetch });
      guarded = new OneRequestVideoGenerationProvider(inner);
      const generated = await generateOnce({
        provider: guarded,
        brief,
        model,
        plate,
        preparation,
        requestedDurationSeconds,
        runDirectory,
        workflowRunId: options.workflowRunId,
        pollIntervalMs: options.pollIntervalMs ?? LTX_POLL_INTERVAL_MS,
        sleep: options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
        runner,
        binaries: options.binaries,
        ...(onProgress ? { onProgress } : {}),
      });
      rawClipPath = generated.rawClipPath;
      rawChecksum = generated.checksumSha256;
      costChargedCents = generated.costChargedCents;
      costBasis = generated.costBasis;

      await cache.record({
        cacheKey,
        sceneNumber: ACCEPTANCE_SCENE_NUMBER,
        relativePath: relative(join(runDirectory, 'generation-cache'), rawClipPath)
          .split('\\')
          .join('/'),
        checksumSha256: rawChecksum,
        sizeBytes: generated.sizeBytes,
        durationSeconds: generated.measured.durationSeconds,
        widthPx: generated.measured.widthPx,
        heightPx: generated.measured.heightPx,
        model,
        requestedDurationSeconds,
        costCents: costChargedCents ?? 0,
        recordedAt: `run:${options.workflowRunId}`,
      });
    }

    // --- 8. inspect, before anything is composited ----------------------------
    const measuredRaw = await probeClip(rawClipPath, runner, options.binaries);
    const requiredSourceSeconds = Number(
      (
        brief.scene.outputEndSeconds -
        brief.scene.outputStartSeconds +
        SCENE_TRIM_HANDLE_SECONDS
      ).toFixed(6),
    );

    const stagedKeyframe: ResolvedKeyframe = {
      sceneNumber: plate.sceneNumber,
      frameId: plate.frameId,
      absolutePath: preparation.stagedPath,
      fileName: plate.fileName,
      checksumSha256: plate.checksumSha256,
      sizeBytes: plate.sizeBytes,
      widthPx: plate.widthPx,
      heightPx: plate.heightPx,
      mimeType: plate.mimeType,
    };
    const decision = buildDecision(brief);

    onProgress?.('inspecting the raw clip before anything is composited');
    const inspection = await inspectSceneMotion({
      decision,
      scene: brief.scene,
      keyframe: stagedKeyframe,
      clipPath: rawClipPath,
      requiredSourceSeconds,
      inspectionDirectory: join(runDirectory, INSPECTION_DIRECTORY),
      runner,
      binaries: options.binaries,
      ...(onProgress ? { onProgress } : {}),
    });
    const survey = await surveyRawClip({
      clipPath: rawClipPath,
      platePath: preparation.stagedPath,
      durationSeconds: measuredRaw.durationSeconds,
      inspectionDirectory: join(runDirectory, INSPECTION_DIRECTORY),
      runner,
      binaries: options.binaries,
      ...(onProgress ? { onProgress } : {}),
    });

    const defects = buildVisualDefectReport({
      inspection,
      survey,
      declaredCameraMotion: brief.scene.cameraMotion,
    });
    const technicalVerdict: TechnicalVerdict =
      inspection.verdict === 'TECHNICALLY_SOUND' && defects.measuredDefectCount === 0
        ? 'TECHNICALLY_VALID'
        : 'TECHNICALLY_REJECTED';

    artefacts.push(
      await writeArtefact(runDirectory, 'technical-inspection.json', {
        runVersion: SCENE_ACCEPTANCE_RUN_VERSION,
        profileVersion: MOTION_INSPECTION_PROFILE_VERSION,
        technicalVerdict,
        inspection,
        wholeClipSurvey: {
          motionEnergy: survey.wholeClipMotionEnergy,
          motionNotMeasuredReason: survey.wholeClipMotionNotMeasuredReason,
          firstFrameAgreement: survey.firstFrameAgreement,
          firstFrameAgreementFloor: survey.firstFrameAgreementFloor,
          firstFrameAgreementNotMeasuredReason: survey.firstFrameAgreementNotMeasuredReason,
          frames: survey.frames,
          contactSheet: survey.contactSheetFileName,
        },
      }),
    );
    artefacts.push(await writeArtefact(runDirectory, 'visual-defects.json', defects));

    // --- 9. the composite, only if the file is technically usable -------------
    let composite: NotificationCompositeResult | null = null;
    if (technicalVerdict === 'TECHNICALLY_VALID') {
      const compositedPath = join(runDirectory, COMPOSITED_DIRECTORY, 'scene-01-composited.mp4');
      await mkdir(join(runDirectory, COMPOSITED_DIRECTORY), { recursive: true });
      composite = await compositeNotification({
        rawClipPath,
        outputPath: compositedPath,
        notification: brief.notification,
        logoPath: resolve(options.logoPath),
        clipDurationSeconds: measuredRaw.durationSeconds,
        runner,
        binaries: options.binaries,
        ...(onProgress ? { onProgress } : {}),
      });
    } else {
      onProgress?.(
        'the raw clip did not pass technical inspection, so nothing was composited. No further paid request is made — a rejection never buys a replacement on its own.',
      );
    }

    // --- 10. the review artefacts --------------------------------------------
    const review = buildPendingReviewRecord({
      scene: brief.scene,
      sceneRole: ACCEPTANCE_SCENE_ROLE,
      clipChecksumSha256: rawChecksum,
      plateChecksumSha256: plate.checksumSha256,
      motionPromptSha256: inspection.motionPromptSha256,
      inspectionSha256: inspection.inspectionSha256,
      ...(options.reviewDirectory ? { reviewDirectory: options.reviewDirectory } : {}),
      openHumanJudgementQuestions: defects.observations
        .filter((row) => row.status === 'HUMAN_JUDGEMENT_REQUIRED')
        .map((row) => `${row.id}: ${row.what}`),
    });
    artefacts.push(await writeArtefact(runDirectory, 'human-review-record.json', review));

    artefacts.push(
      await writeArtefact(
        runDirectory,
        'provider-provenance.json',
        buildProvenance({
          brief,
          model,
          requestedDurationSeconds,
          plate: {
            frameId: plate.frameId,
            checksumSha256: plate.checksumSha256,
            fileName: plate.fileName,
          },
          preparation,
          cacheKey,
          cacheHit,
          ltxRequestCount: guarded?.billableSubmissionCount ?? 0,
          networkRequestCount: counting.requestCount,
          rawChecksum,
          measured: inspection.measured,
          composite,
          technicalVerdict,
          review,
          workflowRunId: options.workflowRunId,
        }),
      ),
    );

    artefacts.push(
      await writeArtefact(runDirectory, 'cost-report.json', {
        runVersion: SCENE_ACCEPTANCE_RUN_VERSION,
        pricingProfileVersion: LTX_PRICING_PROFILE_VERSION,
        model,
        resolution: LTX_SUPPORTED_RESOLUTION,
        requestedDurationSeconds,
        authorisedRequestCount: AUTHORISED_REQUEST_COUNT,
        billableRequestsMade: guarded?.billableSubmissionCount ?? 0,
        enforcedCeilingCents: ceilingCents,
        maximumPossibleCostCents: maximumCostCents,
        costChargedCents,
        costBasis,
        note: 'The rate card is operator-declared and the charge is computed from it. It is the maximum this run could have cost, not a figure the provider reported: the documented LTX status contract carries no billed-amount field, so no exact provider-reported cost is available to record. The enforced ceiling is stated separately and was checked before the first byte was uploaded.',
      }),
    );

    const galleryPath = await writeComparisonGallery({
      runDirectory,
      plateRelativePath: toRelative(runDirectory, preparation.stagedPath),
      rawClipRelativePath: toRelative(runDirectory, rawClipPath),
      compositedClipRelativePath: composite ? toRelative(runDirectory, composite.outputPath) : null,
      framesRelativeDirectory: INSPECTION_DIRECTORY,
      survey,
      checks: inspection.checks,
      defects,
      headline: brief.notification.headline,
      motionPrompt: brief.scene.motionPrompt,
      reviewStatus: VISUAL_REVIEW_STATUS,
      generatedAt: options.now.toISOString(),
      costNote: `${guarded?.billableSubmissionCount ?? 0} billable request(s), ceiling ${ceilingCents}¢`,
    });
    artefacts.push(COMPARISON_GALLERY_FILENAME);

    onProgress?.(
      `${technicalVerdict}; review is ${VISUAL_REVIEW_STATUS}. Nothing has been approved: an approval is a named person's recorded decision.`,
    );

    return {
      exitCode: STORYBOARD_VIDEO_EXIT_CODES.SUCCESS,
      runDirectory,
      dryRun: false,
      model,
      plateFrameId: plate.frameId,
      platePath: plate.absolutePath,
      plateChecksumSha256: plate.checksumSha256,
      requestedDurationSeconds,
      maximumCostCents,
      ceilingCents,
      ltxRequestCount: guarded?.billableSubmissionCount ?? 0,
      networkRequestCount: counting.requestCount,
      cacheHit,
      costChargedCents,
      costBasis,
      rawClipPath,
      rawClipChecksumSha256: rawChecksum,
      ...(composite ? { compositedClipPath: composite.outputPath } : {}),
      galleryPath,
      contactSheetPath: join(runDirectory, INSPECTION_DIRECTORY, survey.contactSheetFileName),
      technicalVerdict,
      reviewStatus: VISUAL_REVIEW_STATUS,
      // Never true from a run. Only a recorded human approval makes a clip a
      // production source, and this run has produced none.
      safeAsProductionSource: false,
      measured: inspection.measured,
      artefacts,
    };
  } catch (error) {
    return fail(error, {
      ...(model ? { model } : {}),
      ...(brief ? { requestedDurationSeconds: brief.generationDurationSeconds } : {}),
      maximumCostCents,
      ltxRequestCount: guarded?.billableSubmissionCount ?? 0,
    });
  }
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

interface GeneratedOnce {
  readonly rawClipPath: string;
  readonly checksumSha256: string;
  readonly sizeBytes: number;
  readonly measured: { durationSeconds: number; widthPx: number; heightPx: number };
  readonly costChargedCents: number | null;
  readonly costBasis: string;
}

/**
 * The one paid request, and everything that has to be true about what comes
 * back before it is written down as a clip.
 *
 * There is no retry anywhere in here. A failure — submission, generation,
 * timeout, download, or a result that is not a playable portrait clip — ends
 * the run. Retrying a billable request is how a transient blip becomes a
 * doubled invoice, and deciding to pay twice is a person's decision taken by
 * rerunning the command.
 */
async function generateOnce(input: {
  provider: OneRequestVideoGenerationProvider;
  brief: AcceptanceBrief;
  model: LtxModel;
  plate: { frameId: string; mimeType: string };
  preparation: PlatePreparation;
  requestedDurationSeconds: number;
  runDirectory: string;
  workflowRunId: string;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  runner: CommandRunner;
  binaries: FfmpegBinaries;
  onProgress?: (message: string) => void;
}): Promise<GeneratedOnce> {
  const scene = input.brief.scene;
  const shotId = `scene-${String(ACCEPTANCE_SCENE_NUMBER).padStart(2, '0')}`;
  const idempotencyKey = `${input.workflowRunId}:${shotId}:${input.preparation.uploadChecksumSha256.slice(0, 16)}`;

  input.onProgress?.(
    `submitting the single authorised ${input.requestedDurationSeconds}s ${input.model} generation`,
  );

  let handle;
  try {
    handle = await input.provider.submit({
      idempotencyKey,
      shotId,
      mode: 'IMAGE_TO_VIDEO',
      promptText: scene.motionPrompt,
      candidateCount: 1,
      referenceImages: [
        {
          assetId: input.plate.frameId,
          localPath: input.preparation.uploadPath,
          mimeType: input.preparation.uploadMimeType,
          role: 'START_FRAME',
          rights: {
            usageClass: 'OWNED',
            rightsHolder: 'Combat Reviews',
            licenseType: 'OWNED_PRODUCTION_KEYFRAME',
          },
        },
      ],
      params: {
        durationSeconds: input.requestedDurationSeconds,
        aspectRatio: '9:16',
        resolution: LTX_SUPPORTED_RESOLUTION,
        frameRate: LTX_SUPPORTED_FPS,
        providerOptions: {
          generateAudio: input.brief.generateAudio,
          cameraMotion: scene.cameraMotion,
        },
      },
    });
  } catch (error) {
    throw translateProviderError(error, ACCEPTANCE_SCENE_NUMBER, 'JOB_SUBMISSION_FAILED');
  }

  for (;;) {
    let status;
    try {
      status = await input.provider.getStatus(handle);
    } catch (error) {
      throw translateProviderError(error, ACCEPTANCE_SCENE_NUMBER, 'GENERATION_FAILED');
    }
    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
      const failure = await input.provider.getFailure(handle).catch(() => null);
      throw new StoryboardVideoError(
        status === 'TIMED_OUT' ? 'POLLING_TIMEOUT' : 'GENERATION_FAILED',
        `the Scene-1 generation ended ${status}${failure ? ` — ${failure.message}` : ''}. Nothing is retried automatically: rerun the command when you have decided to pay again.`,
        ACCEPTANCE_SCENE_NUMBER,
      );
    }
    input.onProgress?.(`scene 1: ${status.toLowerCase()}`);
    await input.sleep(input.pollIntervalMs);
  }

  let candidates;
  try {
    candidates = await input.provider.fetchResult(handle);
  } catch (error) {
    throw translateProviderError(error, ACCEPTANCE_SCENE_NUMBER, 'DOWNLOAD_FAILED');
  }
  const candidate = candidates[0];
  if (!candidate?.localPath) {
    throw new StoryboardVideoError(
      'DOWNLOAD_FAILED',
      'the provider reported success but produced no local file',
      ACCEPTANCE_SCENE_NUMBER,
    );
  }
  assertNotPermanentlyRejected(candidate.localPath, 'the downloaded result');

  const usage = await input.provider.getUsage(handle).catch(() => null);

  const bytes = await readFile(candidate.localPath);
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  if (candidate.checksumSha256 && candidate.checksumSha256 !== checksumSha256) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      'the downloaded result does not hash to what the provider reported for it',
      ACCEPTANCE_SCENE_NUMBER,
    );
  }

  const measured = await probeClip(candidate.localPath, input.runner, input.binaries);
  assertRawClipUsable(measured, input.requestedDurationSeconds);

  const rawDirectory = join(input.runDirectory, RAW_DIRECTORY);
  await mkdir(rawDirectory, { recursive: true });
  const rawClipPath = join(rawDirectory, `scene-01-raw-${checksumSha256.slice(0, 16)}.mp4`);
  await writeFile(rawClipPath, bytes);

  return {
    rawClipPath,
    checksumSha256,
    sizeBytes: bytes.byteLength,
    measured: {
      durationSeconds: measured.durationSeconds,
      widthPx: measured.widthPx,
      heightPx: measured.heightPx,
    },
    costChargedCents: usage?.costCents ?? null,
    costBasis:
      usage === null
        ? 'UNAVAILABLE — the provider reported no usage for this job and no figure is inferred'
        : 'DECLARED_RATE_CARD — computed from the operator-declared LTX rate card at the requested duration. The documented LTX status contract carries no billed-amount field, so this is not a provider-reported charge.',
  };
}

/**
 * What "the bytes are usable" means, measured rather than declared.
 *
 * Portrait is checked explicitly and by name. Landscape is the exact defect
 * the two permanently-rejected legacy clips carried, and a run that produced
 * another one should say so in those words rather than in a geometry mismatch.
 */
export function assertRawClipUsable(
  measured: { durationSeconds: number; widthPx: number; heightPx: number; videoCodec: string },
  requestedDurationSeconds: number,
): void {
  const problems: string[] = [];
  if (measured.heightPx <= measured.widthPx) {
    problems.push(
      `is ${measured.widthPx}x${measured.heightPx}, which is landscape. ${PERMANENTLY_REJECTED_CLIP_NOTE}`,
    );
  } else if (
    measured.widthPx !== LTX_SUPPORTED_WIDTH_PX ||
    measured.heightPx !== LTX_SUPPORTED_HEIGHT_PX
  ) {
    problems.push(
      `is ${measured.widthPx}x${measured.heightPx}, not the requested ${LTX_SUPPORTED_WIDTH_PX}x${LTX_SUPPORTED_HEIGHT_PX}`,
    );
  }
  if (!Number.isFinite(measured.durationSeconds) || measured.durationSeconds <= 0) {
    problems.push('reports no duration, so it is not footage');
  } else if (measured.durationSeconds + 0.25 < requestedDurationSeconds) {
    problems.push(
      `runs ${measured.durationSeconds.toFixed(2)}s against the ${requestedDurationSeconds}s requested. A short result is never stretched to fit.`,
    );
  }
  if (!measured.videoCodec || measured.videoCodec === 'unknown') {
    problems.push('has no recognisable video codec');
  }
  if (problems.length > 0) {
    throw new StoryboardVideoError(
      'INVALID_GENERATED_MEDIA',
      `the generated clip ${problems.join('; ')}`,
      ACCEPTANCE_SCENE_NUMBER,
    );
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function buildProvider(input: {
  options: SceneAcceptanceOptions;
  model: LtxModel;
  runDirectory: string;
  fetchImpl: typeof fetch;
}): VideoGenerationProvider {
  const apiKey = input.options.apiKey;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new StoryboardVideoError(
      'MISSING_API_KEY',
      'LTXV_API_KEY is not set. Nothing has been uploaded and nothing has been spent. There is no unauthenticated mode and no fallback to a fixture.',
    );
  }
  return createLtxHostedProvider({
    apiKey,
    model: input.model,
    outputTimeoutMs: 20 * 60_000,
    outputDirectory: join(input.runDirectory, RAW_DIRECTORY, 'provider'),
    ...(input.options.baseUrl ? { baseUrl: input.options.baseUrl } : {}),
    fetchImpl: input.fetchImpl,
  });
}

function buildDecision(brief: AcceptanceBrief): SceneSourceDecision {
  return {
    sceneNumber: ACCEPTANCE_SCENE_NUMBER,
    sceneRole: ACCEPTANCE_SCENE_ROLE,
    slotSeconds: Number((brief.scene.outputEndSeconds - brief.scene.outputStartSeconds).toFixed(6)),
    generationMode: brief.scene.generationMode,
    selectedSourceType: 'LTX_GENERATED',
    selectedIdentifier: brief.plateFrameId,
    reasonSelected:
      'Scene 1 is a photographic plate with no real product capture and no acquired original bound to it, so it is animated from the authoritative FRAME-01 plate.',
    rejectedAlternatives: [
      {
        sourceType: 'PRE_GENERATED_MANUAL_CLIP',
        identifier: 'FRAME-01.mp4 / FRAME-07.mp4 under generated-clips/',
        reason: PERMANENTLY_REJECTED_CLIP_NOTE,
      },
    ],
    requiresGeneration: true,
    generationInputFrameId: brief.plateFrameId,
    generationProvenance: PROVIDER_GENERATION_PROVENANCE,
  };
}

function buildRunPlan(input: {
  brief: AcceptanceBrief;
  model: LtxModel;
  requestedDurationSeconds: number;
  plates: PlateLibrary;
  preparation: PlatePreparation;
  cacheKey: string;
  unitCostCents: number;
  maximumCostCents: number;
  ceilingCents: number;
  workflowRunId: string;
  dryRun: boolean;
}): unknown {
  return {
    runVersion: SCENE_ACCEPTANCE_RUN_VERSION,
    workflowRunId: input.workflowRunId,
    dryRun: input.dryRun,
    storyboardId: input.brief.storyboardId,
    briefAuthoredBy: input.brief.authoredBy,
    scope: {
      scenesGenerated: [ACCEPTANCE_SCENE_NUMBER],
      scenesDeliberatelyNotGenerated: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      rendersFinalAdvertisement: false,
      note: 'This milestone proves one scene. Scenes 2–10 are not generated and the fifteen-second master is not rendered.',
    },
    request: {
      model: input.model,
      resolution: LTX_SUPPORTED_RESOLUTION,
      fps: LTX_SUPPORTED_FPS,
      durationSeconds: input.requestedDurationSeconds,
      generateAudio: input.brief.generateAudio,
      cameraMotion: input.brief.scene.cameraMotion,
      authorisedRequestCount: AUTHORISED_REQUEST_COUNT,
      retryPolicy: 'NONE — a failed generation stays failed until a person reruns the command',
    },
    cost: {
      pricingProfileVersion: LTX_PRICING_PROFILE_VERSION,
      unitCostCents: input.unitCostCents,
      maximumTotalCostCents: input.maximumCostCents,
      enforcedCeilingCents: input.ceilingCents,
    },
    platesDirectory: input.plates.platesDirectory,
    plates: input.plates.plates.map((plate) => ({
      frameId: plate.frameId,
      fileName: plate.fileName,
      checksumSha256: plate.checksumSha256,
      sizeBytes: plate.sizeBytes,
      widthPx: plate.widthPx,
      heightPx: plate.heightPx,
      orientation: plate.orientation,
      aspectRatio: plate.aspectRatio,
      mimeType: plate.mimeType,
    })),
    ignoredFilesInPlateDirectory: input.plates.ignoredFiles,
    staging: {
      stagedPath: input.preparation.stagedPath,
      stagedChecksumSha256: input.preparation.stagedChecksumSha256,
      uploadChecksumSha256: input.preparation.uploadChecksumSha256,
      uploadWidthPx: input.preparation.uploadWidthPx,
      uploadHeightPx: input.preparation.uploadHeightPx,
      resample: input.preparation.resample,
      externalInputsAreReadOnly: true,
    },
    generationCacheKey: input.cacheKey,
    generationCacheKeyInputs: [
      'source image checksum',
      'complete prompt',
      'model',
      'duration',
      'resolution',
      'frame rate',
      'generate-audio setting',
      'camera motion',
    ],
    permanentlyRejectedSources: PERMANENTLY_REJECTED_CLIP_NOTE,
    responseContractStatus: LTX_RESPONSE_CONTRACT_STATUS,
  };
}

function buildProvenance(input: {
  brief: AcceptanceBrief;
  model: LtxModel;
  requestedDurationSeconds: number;
  plate: { frameId: string; checksumSha256: string; fileName: string };
  preparation: PlatePreparation;
  cacheKey: string;
  cacheHit: boolean;
  ltxRequestCount: number;
  networkRequestCount: number;
  rawChecksum: string;
  measured: SceneMotionInspection['measured'];
  composite: NotificationCompositeResult | null;
  technicalVerdict: TechnicalVerdict;
  review: PendingReviewRecord;
  workflowRunId: string;
}): unknown {
  return {
    runVersion: SCENE_ACCEPTANCE_RUN_VERSION,
    workflowRunId: input.workflowRunId,
    provider: 'ltx-hosted',
    model: input.model,
    responseContractStatus: LTX_RESPONSE_CONTRACT_STATUS,
    generationProvenance: PROVIDER_GENERATION_PROVENANCE,
    reasoningProviderCalls: 0,
    videoGenerationProviderCalls: input.ltxRequestCount,
    paidProviderCalls: input.ltxRequestCount,
    networkRequestCount: input.networkRequestCount,
    authorisedRequestCount: AUTHORISED_REQUEST_COUNT,
    cacheHit: input.cacheHit,
    generationCacheKey: input.cacheKey,
    source: {
      plateFrameId: input.plate.frameId,
      plateFileName: input.plate.fileName,
      plateChecksumSha256: input.plate.checksumSha256,
      stagedChecksumSha256: input.preparation.stagedChecksumSha256,
      uploadedChecksumSha256: input.preparation.uploadChecksumSha256,
      resample: input.preparation.resample,
    },
    request: {
      durationSeconds: input.requestedDurationSeconds,
      resolution: LTX_SUPPORTED_RESOLUTION,
      fps: LTX_SUPPORTED_FPS,
      generateAudio: input.brief.generateAudio,
      cameraMotion: input.brief.scene.cameraMotion,
    },
    result: {
      rawChecksumSha256: input.rawChecksum,
      measured: input.measured,
      technicalVerdict: input.technicalVerdict,
    },
    composite: input.composite
      ? {
          checksumSha256: input.composite.checksumSha256,
          treatment: input.composite.treatment,
          cardRect: input.composite.cardRect,
          withinSafeBounds: input.composite.withinSafeBounds,
          settleWindows: input.composite.settleWindows,
          pulse: input.composite.pulse,
          logoChecksumSha256: input.composite.logoChecksumSha256,
          notes: input.composite.notes,
        }
      : null,
    review: {
      status: input.review.status,
      identitySha256: input.review.identitySha256,
      inspectionSha256: input.review.inspectionSha256,
    },
    isRealCampaignRun: false,
    isPublicReleaseReady: false,
    requiresHumanApproval: true,
    scenesGenerated: [ACCEPTANCE_SCENE_NUMBER],
    scenesNotGenerated: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    finalAdvertisementRendered: false,
    caveat:
      'A Scene-1 acceptance proof. One paid generation from the authoritative plate, inspected locally and left pending a named reviewer. Creative quality is not assessed, no master was rendered, and this clip is not a production source until a person records an approval of these exact bytes.',
  };
}

async function writePromptSnapshot(
  runDirectory: string,
  brief: AcceptanceBrief,
  promptSha256: string,
): Promise<void> {
  await writeFile(
    join(runDirectory, 'generation-prompt.txt'),
    `${brief.scene.motionPrompt}\n`,
    'utf8',
  );
  await writeFile(
    join(runDirectory, 'generation-prompt.sha256.json'),
    `${JSON.stringify(
      {
        sceneNumber: ACCEPTANCE_SCENE_NUMBER,
        authoredBy: brief.authoredBy,
        cameraMotion: brief.scene.cameraMotion,
        wordCount: brief.scene.motionPrompt.trim().split(/\s+/).filter(Boolean).length,
        promptSha256,
        gate: 'checked by the existing storyboard-video prompt gate; refused rather than rewritten',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function toRelative(from: string, target: string): string {
  return relative(from, target).split('\\').join('/');
}

export { COMPARISON_GALLERY_FILENAME };
export type { RawClipSurvey, VisualDefectReport };

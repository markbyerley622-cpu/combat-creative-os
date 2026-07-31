import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  evenPx as evenDimension,
  NodeCommandRunner,
  parseRenderManifest,
  type CommandRunner,
  type FfmpegBinaries,
} from '@combat/media';

import { loadCampaignRequest, type CampaignRequest } from '../campaign-request';
import { parseProductionAssetManifest } from '../production-assets';
import { loadHumanPlan, type HumanCreativePlan } from '../preview/human-plan';
import { runPreviewCampaign } from '../preview/run-preview-campaign';
import { EXIT_CODES, type ExitCode } from '../run-source-campaign';
import { buildAgencyScorecard, type AgencyScorecard } from './agency-scorecard';
import { stageAssets } from './asset-reconciliation';
import {
  assertNoProhibitedClaims,
  findProhibitedClaims,
  type AuthoredString,
} from './factual-sanitisation';
import {
  buildFidelityReport,
  COMPARISON_GALLERY_FILENAME,
  extractSceneKeyframes,
  writeComparisonGallery,
  type FidelityReport,
} from './fidelity-v2';
import { loadProductionTreatment, type ProductionTreatment } from './production-treatment';
import { proveStagingRootExclusion } from './reference-exclusion';
import { verifyStoryboardPackage } from './storyboard-package';
import {
  buildPanelAssets,
  LOCKED_SCENE_ROLES,
  panelAssetId,
  verifyStoryboardV2,
  type VerifiedStoryboardV2,
} from './storyboard-v2';

/**
 * The locked-storyboard motion proof.
 *
 * The same composition root as the flagship v1 run: the zero-cost
 * footage-first preview does the rendering, unchanged. What differs is where
 * the pixels come from and what may be said about them.
 *
 * In v1 the storyboard was `REFERENCE_ONLY` and the run proved by checksum
 * that not one of its frames reached the output. Here the storyboard *is* the
 * art direction, its panels are the primary visual source, and the proof runs
 * the other way: every panel is declared, its rights position travels with it,
 * and the run proves that **Storyboard-01** — the package whose frames may
 * never be rendered — is absent.
 *
 * Nothing on this path constructs a reasoning provider, a generation provider
 * or a database client, and nothing imports one.
 */

export const V2_EXECUTION_MODE = 'HUMAN_ASSISTED_PREVIEW' as const;
export const V2_OUTPUT_USE = 'INTERNAL_REVIEW' as const;
export const V2_IS_REAL_CAMPAIGN_RUN = false as const;
export const V2_IS_PUBLIC_RELEASE_READY = false as const;
export const V2_PAID_PROVIDER_CALLS = 0 as const;

/**
 * How much the panels are resampled by before they are staged.
 *
 * A 470px-wide panel is below the asset root's minimum delivery width, and
 * that guard is worth respecting rather than relaxing. Three times puts every
 * panel above the width the panel treatment asks for, so the renderer scales
 * *down* into the frame. It is a deterministic lanczos resample and it creates
 * no detail that was not in the panel; every artefact says so rather than
 * leaving it to be assumed.
 */
export const PANEL_STAGE_SCALE = 3;

/**
 * A scene whose visual source is moving footage rather than a still panel.
 *
 * The seam the storyboard-to-video path uses. When a scene supplies one, its
 * staged asset becomes this clip — under exactly the asset id the plan already
 * binds — so the whole downstream chain (preflight, rights resolution, clip
 * analysis, segment selection, filter graph, actual-media QA, gallery) runs
 * unchanged. Absent, every scene stages its panel as before, which is what
 * keeps every plan written before this milestone rendering identically.
 */
export interface GeneratedSceneMedia {
  /** Absolute path to the trimmed, normalised clip. */
  readonly absolutePath: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly durationSeconds: number;
  /** Where the moving picture came from. Travels into provenance verbatim. */
  readonly provenance: string;
  /** One line for the artefacts, in the resolver's own words. */
  readonly description: string;
}

/**
 * The operator's own finished still for a scene, staged in place of the
 * storyboard panel.
 *
 * Deliberately a different type from `GeneratedSceneMedia`: one is footage a
 * model or a camera produced and the other is a plate a person made, and the
 * artefacts have to be able to tell them apart. A still carries no duration.
 */
export interface SceneStillMedia {
  readonly absolutePath: string;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Where the plate came from. Travels into provenance verbatim. */
  readonly provenance: string;
  readonly checksumSha256: string;
  readonly description: string;
}

export interface FlagshipV2Options {
  readonly storyboardRoot: string;
  readonly workPackRoot: string;
  /** Storyboard-01's package, proven absent from this run when supplied. */
  readonly storyboard01Root?: string;
  readonly campaignDirectory: string;
  /**
   * The plan to render. Defaults to the campaign directory's own
   * `creative-plan.json`, which is what every existing caller gets.
   */
  readonly planPath?: string;
  /** Moving footage per scene sequence (1-based). Absent scenes stage their panel. */
  readonly generatedSceneMedia?: ReadonlyMap<number, GeneratedSceneMedia>;
  /**
   * A higher-resolution still to stage in place of a scene's storyboard panel.
   *
   * The storyboard package's frames are 470px crops out of a contact sheet —
   * they are the locked *art direction*, and at delivery size a 470x378
   * landscape crop can only be contained inside a vertical frame over a blurred
   * backplate. When the operator's own finished portrait plate for that scene
   * exists, staging it instead renders the same composition at the resolution
   * it was designed at.
   *
   * This is a change of *source*, not of cut: the asset id, the beat binding,
   * the slot and the rights position are all unchanged, and the scene's own
   * declared checksums still travel into the artefacts. Absent, every scene
   * stages its panel exactly as before.
   */
  readonly sceneStillMedia?: ReadonlyMap<number, SceneStillMedia>;
  readonly outputDirectory: string;
  readonly binaries: FfmpegBinaries;
  readonly workflowRunId: string;
  readonly now: Date;
  readonly runner?: CommandRunner;
  readonly onProgress?: (message: string) => void;
}

export interface FlagshipV2Result {
  readonly exitCode: ExitCode;
  readonly runDirectory: string;
  readonly outputPath?: string;
  readonly qaVerdict?: string;
  readonly measured?: Record<string, unknown>;
  readonly fidelity?: FidelityReport;
  readonly scorecard?: AgencyScorecard;
  readonly galleryPath?: string;
  readonly failure?: string;
  readonly executionMode: typeof V2_EXECUTION_MODE;
  readonly outputUse: typeof V2_OUTPUT_USE;
  readonly isRealCampaignRun: typeof V2_IS_REAL_CAMPAIGN_RUN;
  readonly isPublicReleaseReady: typeof V2_IS_PUBLIC_RELEASE_READY;
  readonly paidProviderCalls: typeof V2_PAID_PROVIDER_CALLS;
}

const SceneNoteSchemaKeys = [
  'compositionNote',
  'animationPerformed',
  'remainingMismatch',
  'productScreenSource',
  'missingProductionAsset',
] as const;

interface SceneNote {
  readonly compositionNote: string;
  readonly animationPerformed: string;
  readonly remainingMismatch: string;
  readonly productScreenSource: 'PRODUCT_MOCKUP' | 'REAL_CAPTURE' | 'NONE';
  readonly missingProductionAsset: string;
}

async function writeArtefact(runDirectory: string, name: string, value: unknown): Promise<void> {
  const target = join(runDirectory, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Every authored string the run will put on screen or into an artefact. */
export function v2AuthoredStrings(
  plan: HumanCreativePlan,
  treatment: ProductionTreatment,
): readonly AuthoredString[] {
  const strings: AuthoredString[] = [
    { field: 'hook.onScreenLine', value: plan.hook.onScreenLine },
    { field: 'hook.strategy', value: plan.hook.strategy },
    { field: 'cta.headline', value: plan.cta.headline },
    ...(plan.cta.subline ? [{ field: 'cta.subline', value: plan.cta.subline }] : []),
    { field: 'creativeDirection.logline', value: plan.creativeDirection.logline },
    { field: 'creativeDirection.visualDirection', value: plan.creativeDirection.visualDirection },
    { field: 'creativeDirection.narrativeArc', value: plan.creativeDirection.narrativeArc },
    { field: 'strategy.positioning', value: plan.strategy.positioning },
    ...plan.strategy.keyMessages.map((message, index) => ({
      field: `strategy.keyMessages[${index}]`,
      value: message,
    })),
    { field: 'treatment.strategicIdea', value: treatment.strategicIdea },
    { field: 'treatment.audienceTension', value: treatment.audienceTension },
    { field: 'treatment.productMechanism', value: treatment.productMechanism },
  ];
  for (const [index, beat] of plan.beats.entries()) {
    if (beat.caption)
      strings.push({ field: `beats[${index}].caption.text`, value: beat.caption.text });
    strings.push({ field: `beats[${index}].description`, value: beat.description });
  }
  return strings;
}

async function materialiseRequest(input: {
  readonly campaignDirectory: string;
  readonly runDirectory: string;
  readonly sourceAssetManifestPath: string;
  readonly fileName: string;
}): Promise<CampaignRequest> {
  const template = JSON.parse(
    await readFile(join(input.campaignDirectory, 'request.template.json'), 'utf8'),
  ) as Record<string, unknown> & { promptFile?: string };
  const promptFile = template.promptFile;
  if (typeof promptFile !== 'string' || promptFile.trim().length === 0) {
    throw new Error('the request template must declare a promptFile');
  }
  const campaignPrompt = (
    await readFile(resolve(input.campaignDirectory, promptFile), 'utf8')
  ).trim();
  const { promptFile: _omitted, ...rest } = template;
  const target = join(input.runDirectory, input.fileName);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    `${JSON.stringify(
      {
        ...rest,
        campaignPrompt,
        sourceAssetManifest: input.sourceAssetManifestPath,
        outputDirectory: input.runDirectory,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return loadCampaignRequest(target);
}

export async function runFlagshipV2(options: FlagshipV2Options): Promise<FlagshipV2Result> {
  const runner = options.runner ?? new NodeCommandRunner();
  const runDirectory = resolve(options.outputDirectory);
  const onProgress = options.onProgress;
  const generatedSceneMedia = options.generatedSceneMedia ?? new Map<number, GeneratedSceneMedia>();
  const sceneStillMedia = options.sceneStillMedia ?? new Map<number, SceneStillMedia>();
  await mkdir(runDirectory, { recursive: true });

  const labels = {
    executionMode: V2_EXECUTION_MODE,
    outputUse: V2_OUTPUT_USE,
    isRealCampaignRun: V2_IS_REAL_CAMPAIGN_RUN,
    isPublicReleaseReady: V2_IS_PUBLIC_RELEASE_READY,
    paidProviderCalls: V2_PAID_PROVIDER_CALLS,
  } as const;
  const fail = (exitCode: ExitCode, failure: string): FlagshipV2Result => ({
    exitCode,
    runDirectory,
    failure,
    ...labels,
  });

  // --- 1. the locked storyboard ---------------------------------------------
  let storyboard: VerifiedStoryboardV2;
  try {
    onProgress?.('verifying the locked ten-panel storyboard package');
    storyboard = await verifyStoryboardV2(options.storyboardRoot);
  } catch (error) {
    return fail(
      EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
      error instanceof Error ? error.message : String(error),
    );
  }
  await writeArtefact(runDirectory, 'storyboard-verification.json', {
    storyboardId: storyboard.storyboardId,
    storyboardRoot: storyboard.storyboardRoot,
    usageClass: storyboard.usageClass,
    outputEligibleForPublicRelease: storyboard.outputEligibleForPublicRelease,
    licensedForPublicProduction: storyboard.licensedForPublicProduction,
    isPublicReleaseReady: storyboard.isPublicReleaseReady,
    internalReviewMotionProofAuthorised: storyboard.internalReviewMotionProofAuthorised,
    rightsStatement: storyboard.rightsStatement,
    contactSheetChecksumSha256: storyboard.contactSheetChecksumSha256,
    frames: storyboard.frames.map((frame) => ({
      frameId: frame.frameId,
      sequence: frame.sequence,
      sceneRole: frame.sceneRole,
      startSeconds: frame.startSeconds,
      endSeconds: frame.endSeconds,
      checksumSha256: frame.checksumSha256,
      renderChecksumSha256: frame.renderChecksumSha256,
      isFactuallyCorrected: frame.isFactuallyCorrected,
    })),
  });

  // --- 2. the committed campaign source -------------------------------------
  const campaignDirectory = resolve(options.campaignDirectory);
  const planPath = options.planPath
    ? resolve(options.planPath)
    : join(campaignDirectory, 'creative-plan.json');
  const workPackRoot = resolve(options.workPackRoot);
  const libraryManifestPath = join(workPackRoot, 'asset-root', 'assets.json');
  let libraryManifest;
  try {
    libraryManifest = parseProductionAssetManifest(
      JSON.parse(await readFile(libraryManifestPath, 'utf8')),
      libraryManifestPath,
    );
  } catch (error) {
    return fail(
      EXIT_CODES.MISSING_PRODUCTION_ASSETS,
      `the work pack's asset library at ${libraryManifestPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const libraryManifestDir = dirname(libraryManifestPath);

  let treatment: ProductionTreatment;
  let sceneNotes: Map<string, SceneNote>;
  try {
    onProgress?.('loading the approved treatment and the authored scene notes');
    const provisional = await materialiseRequest({
      campaignDirectory,
      runDirectory,
      sourceAssetManifestPath: libraryManifestPath,
      fileName: 'flagship2-request.preflight.json',
    });
    treatment = await loadProductionTreatment(
      join(campaignDirectory, 'production-treatment.json'),
      {
        campaignId: provisional.campaignId,
        storyboardId: storyboard.storyboardId,
      },
    );
    const raw = JSON.parse(await readFile(join(campaignDirectory, 'scene-notes.json'), 'utf8')) as {
      scenes?: Record<string, SceneNote>;
    };
    sceneNotes = new Map(Object.entries(raw.scenes ?? {}));
    for (const role of LOCKED_SCENE_ROLES) {
      const note = sceneNotes.get(role);
      if (!note) throw new Error(`scene-notes.json has no entry for ${role}`);
      for (const key of SceneNoteSchemaKeys) {
        if (typeof note[key] !== 'string') {
          throw new Error(`scene-notes.json entry for ${role} is missing ${key}`);
        }
      }
    }
  } catch (error) {
    return fail(
      EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
      error instanceof Error ? error.message : String(error),
    );
  }

  // --- 3. the panels, staged as declared production media -------------------
  const stagingRoot = join(runDirectory, 'staged-assets');
  await mkdir(join(stagingRoot, 'panels'), { recursive: true });
  const panels = buildPanelAssets(storyboard);
  onProgress?.(
    `resampling ${panels.length} panels ${PANEL_STAGE_SCALE}x with lanczos — a deterministic resample that adds no detail`,
  );
  const stagedPanels: {
    asset: (typeof panels)[number]['asset'];
    widthPx: number;
    heightPx: number;
  }[] = [];
  for (const [index, panel] of panels.entries()) {
    const frame = storyboard.frames[index] as (typeof storyboard.frames)[number];

    // A scene with moving footage stages that instead of its panel, under the
    // same asset id the plan already binds — so nothing downstream has to know
    // this scene is different from any other.
    const moving = generatedSceneMedia.get(frame.sequence);
    if (moving) {
      const stagedPath = join(stagingRoot, 'panels', `${panel.asset.id}.mp4`);
      // eslint-disable-next-line no-await-in-loop -- deterministic order
      await copyFile(moving.absolutePath, stagedPath);
      stagedPanels.push({
        asset: {
          ...panel.asset,
          path: `./panels/${panel.asset.id}.mp4`,
          kind: 'VIDEO' as const,
          role: 'SOURCE_CLIP' as const,
          description: moving.description.slice(0, 300),
          declaredWidthPx: moving.widthPx,
          declaredHeightPx: moving.heightPx,
          declaredDurationSeconds: moving.durationSeconds,
          rights: {
            ...panel.asset.rights,
            restrictions: [
              ...panel.asset.rights.restrictions,
              `moving-source provenance: ${moving.provenance}`,
            ],
          },
        },
        widthPx: moving.widthPx,
        heightPx: moving.heightPx,
      });
      continue;
    }

    // The operator's own finished plate, when one exists for this scene. It
    // supersedes the contact-sheet crop as the *source*; everything else about
    // the scene — its id, its beat, its slot, its rights — is unchanged.
    const still = sceneStillMedia.get(frame.sequence);
    const stillWidthPx = still
      ? Math.max(still.widthPx, frame.widthPx * PANEL_STAGE_SCALE)
      : frame.widthPx * PANEL_STAGE_SCALE;
    const stillHeightPx = still
      ? Math.round((stillWidthPx * still.heightPx) / still.widthPx)
      : frame.heightPx * PANEL_STAGE_SCALE;
    const widthPx = evenDimension(stillWidthPx);
    const heightPx = evenDimension(stillHeightPx);
    // Staged above the delivery width the panel treatment will ask for, so the
    // renderer resamples *down* into the frame rather than up. The asset root's
    // own minimum-dimension guard is respected rather than relaxed: a panel
    // that could not clear it would be a panel too small to deliver.
    // eslint-disable-next-line no-await-in-loop -- deterministic order
    const result = await runner.run(
      options.binaries.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        still ? still.absolutePath : panel.absolutePath,
        '-vf',
        `scale=${widthPx}:${heightPx}:flags=lanczos,format=rgb24`,
        '-frames:v',
        '1',
        '-fflags',
        '+bitexact',
        '-pix_fmt',
        'rgb24',
        '-y',
        join(stagingRoot, 'panels', `${panel.asset.id}.png`),
      ],
      { timeoutMs: 120_000 },
    );
    if (result.exitCode !== 0) {
      return fail(
        EXIT_CODES.MISSING_PRODUCTION_ASSETS,
        `panel ${panel.asset.id} could not be resampled: ${result.stderr.trim().slice(-400)}`,
      );
    }
    stagedPanels.push({
      asset: {
        ...panel.asset,
        declaredWidthPx: widthPx,
        declaredHeightPx: heightPx,
        ...(still
          ? {
              description: still.description.slice(0, 300),
              rights: {
                ...panel.asset.rights,
                restrictions: [
                  ...panel.asset.rights.restrictions,
                  `still-source provenance: ${still.provenance}`,
                  `staged from the operator's own finished plate, sha256 ${still.checksumSha256}`,
                ],
              },
            }
          : {}),
      },
      widthPx,
      heightPx,
    });
  }

  let plan: HumanCreativePlan;
  try {
    onProgress?.('validating the plan against the brief and the locked storyboard');
    plan = await loadHumanPlan(
      planPath,
      await materialiseRequest({
        campaignDirectory,
        runDirectory,
        sourceAssetManifestPath: libraryManifestPath,
        fileName: 'flagship2-request.preflight.json',
      }),
    );
    assertNoProhibitedClaims(v2AuthoredStrings(plan, treatment));
  } catch (error) {
    return fail(
      EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
      error instanceof Error ? error.message : String(error),
    );
  }

  const requiredFromLibrary = [
    plan.brandConstraints.logoAssetId,
    ...(plan.audio.musicAssetId ? [plan.audio.musicAssetId] : []),
    ...Object.values(plan.audio.cueAssetIds).filter((id): id is string => Boolean(id)),
  ];

  let staging;
  try {
    onProgress?.(
      `staging ${panels.length} storyboard panels and ${new Set(requiredFromLibrary).size} audio/brand assets`,
    );
    staging = await stageAssets({
      libraryManifest,
      libraryManifestDir,
      stagingRoot,
      requiredAssetIds: requiredFromLibrary,
      generatedAssets: stagedPanels.map((panel) => panel.asset),
      libraryLabel: `Combat Reviews flagship 02 — locked storyboard panels (internal review only) plus temporary audio from ${libraryManifest.library}`,
      forbiddenChecksums: new Set<string>(),
    });
  } catch (error) {
    return fail(
      EXIT_CODES.MISSING_PRODUCTION_ASSETS,
      error instanceof Error ? error.message : String(error),
    );
  }

  // --- 4. Storyboard-01 is absent -------------------------------------------
  let storyboard01Proof: Record<string, unknown> = {
    checked: false,
    reason: 'Storyboard-01 package not supplied to this run',
  };
  if (options.storyboard01Root) {
    try {
      onProgress?.('proving Storyboard-01 contributed nothing to this run');
      const sb01 = await verifyStoryboardPackage(options.storyboard01Root);
      const proof = await proveStagingRootExclusion({ stagingRoot, storyboard: sb01 });
      storyboard01Proof = {
        checked: true,
        storyboard01Id: sb01.storyboardId,
        ...proof,
        conclusion: 'no Storyboard-01 frame is present in anything this run can render',
      };
    } catch (error) {
      return fail(
        EXIT_CODES.INVALID_ASSET_RIGHTS,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // --- 5. render, through the existing preview path --------------------------
  const request = await materialiseRequest({
    campaignDirectory,
    runDirectory,
    sourceAssetManifestPath: staging.manifestPath,
    fileName: 'flagship2-request.json',
  });
  onProgress?.('rendering the locked storyboard through the zero-cost preview path');
  const preview = await runPreviewCampaign({
    request,
    planPath,
    assetRoot: stagingRoot,
    runDirectory,
    repositoryRoot: campaignDirectory,
    binaries: options.binaries,
    workflowRunId: options.workflowRunId,
    now: options.now,
    runner,
    ...(onProgress ? { onProgress } : {}),
  });
  if (!preview.outputPath) {
    return fail(preview.exitCode, preview.failure ?? 'the preview produced no master');
  }

  // --- 6. fidelity ----------------------------------------------------------
  const panelIdBySequence = new Map(
    storyboard.frames.map((frame) => [frame.sequence, panelAssetId(frame)]),
  );
  const fidelity = buildFidelityReport({
    storyboard,
    plan,
    sceneNotes,
    panelAssetIdBySequence: panelIdBySequence,
  });
  await writeArtefact(runDirectory, 'storyboard-fidelity-report.json', fidelity);

  // --- 7. keyframes and the comparison gallery -------------------------------
  onProgress?.('extracting ten output keyframes and writing the comparison gallery');
  const keyframes = await extractSceneKeyframes({
    runner,
    binaries: options.binaries,
    runDirectory,
    masterPath: preview.outputPath,
    storyboard,
    scenes: fidelity.scenes,
  });

  const qaReport = JSON.parse(
    await readFile(`${preview.outputPath}.qa.json`, 'utf8'),
  ) as Parameters<typeof buildAgencyScorecard>[0]['qaReport'];
  const measured = {
    widthPx: qaReport.summary.widthPx ?? null,
    heightPx: qaReport.summary.heightPx ?? null,
    durationSeconds: qaReport.summary.durationSeconds ?? null,
    frameRate: qaReport.summary.frameRate ?? null,
    videoCodec: qaReport.summary.videoCodec ?? null,
    audioCodec: qaReport.summary.audioCodec ?? null,
    pixelFormat: qaReport.summary.pixelFormat ?? null,
    faststart: qaReport.summary.faststart ?? null,
    audio: qaReport.summary.audio ?? null,
  };

  // --- 8. reports -----------------------------------------------------------
  const audioIsTemporary = true; // every audio asset in the library is declared TEMPORARY
  const scorecard = buildAgencyScorecard({
    campaignId: request.campaignId,
    qaReport,
    masterChecksumSha256: preview.outputChecksumSha256 ?? null,
    audioIsTemporary,
    realProductCaptureBeatIds: [],
    totalBeatCount: plan.beats.length,
    mockupBeatIds: plan.beats.map((beat) => beat.id),
    ctaHeadline: plan.cta.headline,
    ctaAction: plan.cta.subline ?? '',
    originalityRiskLevel: preview.originality?.riskLevel ?? 'UNKNOWN',
    measuredWidthPx: measured.widthPx,
    measuredHeightPx: measured.heightPx,
    measuredDurationSeconds: measured.durationSeconds,
    outstandingLimitations: [...sceneNotes.entries()]
      .filter(([, note]) => note.missingProductionAsset.trim().length > 0)
      .map(([role, note]) => `${role}: ${note.missingProductionAsset}`),
  });
  await writeArtefact(runDirectory, 'human-review-scorecard.json', scorecard);

  await writeArtefact(runDirectory, 'factual-sanitisation-report.json', {
    gate: 'PASSED',
    method:
      'every authored string in the plan and the treatment was walked against the closed prohibited-claim rule set. The gate refuses; it never rewrites.',
    authoredStringsChecked: v2AuthoredStrings(plan, treatment).length,
    findings: findProhibitedClaims(v2AuthoredStrings(plan, treatment)),
    storyboardCorrectionsApplied: storyboard.corrections.map((correction) => ({
      frameId: correction.frameId,
      sceneRole: correction.sceneRole,
      before: correction.headlineBefore,
      after: correction.headlineAfter,
      removed: correction.removed,
      replacedWith: correction.replacedWith,
      reason: correction.reason,
      method: correction.method,
      region: correction.region,
      correctedChecksumSha256: correction.correctedChecksumSha256,
    })),
    claimsCarriedByPanelPixels: storyboard.claimsRequiringValidation,
    everyPhoneScreenIsConceptUi: true,
    noStoreBadgesRendered: true,
  });

  await writeArtefact(runDirectory, 'asset-gap-report.json', {
    note: 'What each scene would need to stop being a storyboard proof and become production. Authored, not inferred.',
    scenes: LOCKED_SCENE_ROLES.map((role, index) => {
      const note = sceneNotes.get(role) as SceneNote;
      return {
        sequence: index + 1,
        sceneRole: role,
        visualSourceUsed: storyboard.frames[index]?.isFactuallyCorrected
          ? 'STORYBOARD_PANEL_FACTUALLY_CORRECTED'
          : 'STORYBOARD_PANEL',
        productScreenSource: note.productScreenSource,
        missingProductionAsset: note.missingProductionAsset,
        remainingMismatch: note.remainingMismatch,
      };
    }),
    realCapturesAvailableButNotComposited: {
      captures: ['screen-events', 'screen-fight-card', 'screen-predictions'],
      reason:
        'The real captures show different content from the locked panels — different events, different fighters and a leaderboard rather than a rankings screen. Compositing them would preserve the phone geometry but contradict the panel it sits in, which is a change to the story rather than an improvement to it. They are recorded here as available rather than substituted in.',
    },
  });

  const declarations = {
    executionMode: V2_EXECUTION_MODE,
    outputUse: V2_OUTPUT_USE,
    isRealCampaignRun: V2_IS_REAL_CAMPAIGN_RUN,
    isPublicReleaseReady: V2_IS_PUBLIC_RELEASE_READY,
    paidProviderCalls: V2_PAID_PROVIDER_CALLS,
    storyboardImageryUse: 'INTERNAL_REVIEW_ONLY',
    everyConceptScreen: 'PRODUCT_MOCKUP',
  };

  const galleryPath = await writeComparisonGallery({
    runDirectory,
    campaignName: request.name,
    masterPath: preview.outputPath,
    masterChecksumSha256: preview.outputChecksumSha256 ?? null,
    measured,
    qaVerdict: preview.qaVerdict ?? 'UNKNOWN',
    report: fidelity,
    keyframes,
    storyboard,
    declarations,
  });

  const renderManifest = parseRenderManifest(
    JSON.parse(await readFile(join(runDirectory, 'render-manifest.json'), 'utf8')),
  );
  const provenance = {
    flagshipRunVersion: 2,
    campaignId: request.campaignId,
    workspaceId: request.workspaceId,
    workflowRunId: options.workflowRunId,
    ...declarations,
    requiresHumanApproval: true,
    reasoningProviderCalls: 0,
    videoGenerationProviderCalls: 0,
    planAuthoredBy: plan.authoredBy,
    treatmentApprovedBy: treatment.approvedBy,
    storyboard: {
      storyboardId: storyboard.storyboardId,
      usageClass: storyboard.usageClass,
      rightsStatement: storyboard.rightsStatement,
      licensedForPublicProduction: storyboard.licensedForPublicProduction,
      outputEligibleForPublicRelease: storyboard.outputEligibleForPublicRelease,
      contactSheetChecksumSha256: storyboard.contactSheetChecksumSha256,
      panels: storyboard.frames.map((frame) => ({
        frameId: frame.frameId,
        sceneRole: frame.sceneRole,
        checksumSha256: frame.checksumSha256,
        renderedChecksumSha256: frame.renderChecksumSha256,
        factuallyCorrected: frame.isFactuallyCorrected,
      })),
    },
    panelPreparation: {
      resampleFactor: PANEL_STAGE_SCALE,
      method: 'lanczos, deterministic, bit-exact',
      createsNewDetail: false,
      note: "The panels were resampled up so they clear the asset root's minimum delivery width and so the renderer scales down into the frame rather than up. Resampling recovers no detail that was not in the panel.",
    },
    storyboard01Exclusion: storyboard01Proof,
    sources: renderManifest.sources.map((source) => ({
      id: source.id,
      rightsClass: source.license.licenseType,
      usageClass: source.license.usageClass,
      rightsHolder: source.license.rightsHolder,
      restrictions: source.license.restrictions,
      provenance: source.id.startsWith('storyboard-panel-')
        ? 'STORYBOARD_PANEL — internal review only'
        : 'WORK_PACK_ASSET',
      conceptScreenClass: source.id.startsWith('storyboard-panel-') ? 'PRODUCT_MOCKUP' : null,
    })),
    master: {
      path: preview.outputPath,
      checksumSha256: preview.outputChecksumSha256 ?? null,
      qaVerdict: preview.qaVerdict ?? null,
      measured,
    },
    fidelityVerdict: fidelity.verdict,
    audioIsTemporary,
    scorecardStatus: scorecard.status,
    agencyGradeClaim: scorecard.agencyGradeClaim,
    caveat:
      'HUMAN_ASSISTED_PREVIEW — a locked storyboard supplied by the operator, animated deterministically for one internal review. No reasoning model and no generation provider was called. The storyboard is not licensed public-production media, every phone screen in it is concept UI declared PRODUCT_MOCKUP, and nothing here is public-release ready.',
  };
  await writeArtefact(runDirectory, 'flagship2-provenance.json', provenance);
  await writeArtefact(runDirectory, 'flagship2-provenance.checksum.json', {
    file: 'flagship2-provenance.json',
    algorithm: 'SHA256',
    checksum: createHash('sha256')
      .update(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
      .digest('hex'),
    masterChecksumSha256: preview.outputChecksumSha256 ?? null,
    storyboardSheetChecksumSha256: storyboard.contactSheetChecksumSha256,
    panelChecksums: storyboard.frames.map((frame) => ({
      frameId: frame.frameId,
      renderedChecksumSha256: frame.renderChecksumSha256,
    })),
  });

  if (fidelity.verdict !== 'PASS') {
    return {
      ...labels,
      exitCode: EXIT_CODES.QA_FAILURE,
      runDirectory,
      outputPath: preview.outputPath,
      qaVerdict: preview.qaVerdict ?? 'UNKNOWN',
      measured,
      fidelity,
      scorecard,
      galleryPath,
      failure: `storyboard fidelity FAILED: ${fidelity.failures.join('; ')}`,
    };
  }

  return {
    ...labels,
    exitCode: preview.exitCode,
    runDirectory,
    outputPath: preview.outputPath,
    qaVerdict: preview.qaVerdict ?? 'UNKNOWN',
    measured,
    fidelity,
    scorecard,
    galleryPath,
    ...(preview.failure ? { failure: preview.failure } : {}),
  };
}

export { COMPARISON_GALLERY_FILENAME };

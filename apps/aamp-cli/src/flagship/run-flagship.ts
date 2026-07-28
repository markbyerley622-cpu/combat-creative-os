import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
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
import {
  reconcileAssets,
  stageAssets,
  type BeatSubstitution,
  type DeclaredSourceRoot,
  type ReconciliationReport,
} from './asset-reconciliation';
import {
  assertNoProhibitedClaims,
  CORRECTED_CTA,
  type AuthoredString,
} from './factual-sanitisation';
import { extractGalleryFrames, writeGallery } from './gallery';
import { buildProductMockup, PRODUCT_MOCKUP_ASSET_ID } from './product-mockup';
import { loadProductionTreatment, type ProductionTreatment } from './production-treatment';
import { proveReferenceExclusion, proveStagingRootExclusion } from './reference-exclusion';
import { verifyStoryboardPackage, type VerifiedStoryboardPackage } from './storyboard-package';

/**
 * The flagship run: a verified storyboard, real assets reconciled across every
 * pack, an authored plan, one master, and the evidence for every claim made
 * about it.
 *
 * This is an orchestration, not a new pipeline. Everything that actually makes
 * the advertisement — preflight, rights enforcement, deterministic segment
 * selection, the motion catalogue, the filter graph, actual-media QA — is the
 * existing zero-cost footage-first preview, called unchanged. What is added
 * here is the storyboard contract around it: prove the reference package, hold
 * the copy to what can be verified, reconcile before selecting, prove nothing
 * reference-shaped can reach the encoder, and score the result honestly.
 *
 * The labels are not configurable and cannot be argued up. There is no
 * execution-mode flag on this path, no `--allow-*`, and no branch that writes
 * anything other than `HUMAN_ASSISTED_PREVIEW`, `isRealCampaignRun: false`,
 * `paidProviderCalls: 0` and `outputUse: INTERNAL_REVIEW`. Nothing here
 * constructs a reasoning provider or a generation provider, and nothing
 * imports one — which is what makes the zero-cost claim a property of the
 * object graph rather than a sentence in a comment.
 */

export const FLAGSHIP_EXECUTION_MODE = 'HUMAN_ASSISTED_PREVIEW' as const;
export const FLAGSHIP_OUTPUT_USE = 'INTERNAL_REVIEW' as const;
export const FLAGSHIP_IS_REAL_CAMPAIGN_RUN = false as const;
export const FLAGSHIP_PAID_PROVIDER_CALLS = 0 as const;

/** The eight slots the storyboard defines, as a contract this run must meet. */
export const FLAGSHIP_BEAT_COUNT = 8;
export const FLAGSHIP_DURATION_SECONDS = 15;

export interface FlagshipOptions {
  readonly storyboardRoot: string;
  readonly workPackRoot: string;
  readonly premiumPackRoot?: string;
  readonly pilotPackRoot?: string;
  /** Committed campaign source: request, prompt, plan, treatment. */
  readonly campaignDirectory: string;
  readonly outputDirectory: string;
  readonly binaries: FfmpegBinaries;
  readonly workflowRunId: string;
  readonly now: Date;
  readonly runner?: CommandRunner;
  readonly onProgress?: (message: string) => void;
}

export interface FlagshipResult {
  readonly exitCode: ExitCode;
  readonly runDirectory: string;
  readonly outputPath?: string;
  readonly qaVerdict?: string;
  readonly measured?: Record<string, unknown>;
  readonly scorecard?: AgencyScorecard;
  readonly reconciliation?: ReconciliationReport;
  readonly galleryPath?: string;
  readonly artefacts?: readonly string[];
  readonly failure?: string;
  readonly executionMode: typeof FLAGSHIP_EXECUTION_MODE;
  readonly outputUse: typeof FLAGSHIP_OUTPUT_USE;
  readonly isRealCampaignRun: typeof FLAGSHIP_IS_REAL_CAMPAIGN_RUN;
  readonly paidProviderCalls: typeof FLAGSHIP_PAID_PROVIDER_CALLS;
}

async function writeArtefact(
  runDirectory: string,
  filename: string,
  value: unknown,
): Promise<string> {
  const target = join(runDirectory, filename);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

/**
 * Every authored string this run will put on screen or into an artefact.
 *
 * Collected in one place so the prohibited-claim gate sees all of it. A field
 * added to the plan without being added here would be copy nobody checked,
 * which is precisely the failure the gate exists to prevent — so the plan's
 * own shape is walked rather than a hand-picked subset.
 */
export function authoredStringsOf(
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
    ...plan.creativeDirection.referenceNotes.map((note, index) => ({
      field: `creativeDirection.referenceNotes[${index}]`,
      value: note,
    })),
    { field: 'treatment.strategicIdea', value: treatment.strategicIdea },
    { field: 'treatment.audienceTension', value: treatment.audienceTension },
    { field: 'treatment.productMechanism', value: treatment.productMechanism },
  ];
  for (const [index, beat] of plan.beats.entries()) {
    if (beat.caption) {
      strings.push({ field: `beats[${index}].caption.text`, value: beat.caption.text });
    }
    strings.push({ field: `beats[${index}].description`, value: beat.description });
  }
  return strings;
}

export interface StoryboardConformance {
  readonly beatCount: number;
  readonly totalSeconds: number;
  readonly slots: readonly {
    readonly beatId: string;
    readonly storyboardFrameId: string;
    /** Where the shot is fully established — the storyboard's own slot start. */
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly durationSeconds: number;
    /** Where the beat's own frames begin, which is earlier by its transition. */
    readonly enteringAtSeconds: number;
  }[];
}

export class StoryboardConformanceError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(
      `The plan does not execute the storyboard:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
    this.name = 'StoryboardConformanceError';
  }
}

/**
 * Proves the plan's timeline is the storyboard's timeline.
 *
 * The plan schema already guarantees the beats sum to the requested duration.
 * What it cannot know is whether *those* beats land on the storyboard's eight
 * slots — a plan could reallocate 2 seconds from the product reveal to the CTA
 * and still validate perfectly while telling a different story from the one
 * that was approved.
 *
 * Beat durations carry their own transition overlap, so the on-timeline start
 * of each beat is computed the same way the edit builder computes it, and
 * compared to the storyboard frame at the same position.
 *
 * The comparison is against the beat's *settled* start — where the incoming
 * shot is fully established — rather than the instant its first frame appears.
 * A beat that crossfades in begins contributing pixels a third of a second
 * before its slot by design; holding the raw start to the slot boundary would
 * make every transition an error and push an author toward hard cuts to
 * satisfy a check.
 */
export function assertStoryboardConformance(
  plan: HumanCreativePlan,
  storyboard: VerifiedStoryboardPackage,
): StoryboardConformance {
  const problems: string[] = [];
  if (plan.beats.length !== FLAGSHIP_BEAT_COUNT) {
    problems.push(
      `the storyboard has ${FLAGSHIP_BEAT_COUNT} panels but the plan has ${plan.beats.length} beats`,
    );
  }
  if (Math.abs(plan.targetDurationSeconds - FLAGSHIP_DURATION_SECONDS) > 1e-6) {
    problems.push(
      `this milestone cuts exactly ${FLAGSHIP_DURATION_SECONDS}s; the plan targets ${plan.targetDurationSeconds}s`,
    );
  }

  const frames = [...storyboard.frames].sort((a, b) => a.sequence - b.sequence);
  const slots: StoryboardConformance['slots'][number][] = [];
  let running = 0;
  plan.beats.forEach((beat, index) => {
    const overlap = beat.transitionIn?.durationSeconds ?? 0;
    const enteringAtSeconds = index === 0 ? 0 : Number((running - overlap).toFixed(6));
    // The settled start is where the previous beat ended: the overlap belongs
    // to the outgoing shot, not to this one's slot.
    const startSeconds = index === 0 ? 0 : Number(running.toFixed(6));
    running = index === 0 ? beat.durationSeconds : running + beat.durationSeconds - overlap;
    const endSeconds = Number(running.toFixed(6));

    const frame = frames[index];
    if (!frame) {
      problems.push(`beat "${beat.id}" has no storyboard panel at position ${index + 1}`);
      return;
    }
    if (Math.abs(startSeconds - frame.startSeconds) > 1e-3) {
      problems.push(
        `beat "${beat.id}" settles at ${startSeconds.toFixed(3)}s but ${frame.frameId} starts at ${frame.startSeconds}s`,
      );
    }
    if (Math.abs(endSeconds - frame.endSeconds) > 1e-3) {
      problems.push(
        `beat "${beat.id}" ends at ${endSeconds.toFixed(3)}s but ${frame.frameId} ends at ${frame.endSeconds}s`,
      );
    }
    slots.push({
      beatId: beat.id,
      storyboardFrameId: frame.frameId,
      startSeconds,
      endSeconds,
      durationSeconds: Number((endSeconds - startSeconds).toFixed(6)),
      enteringAtSeconds,
    });
  });

  const total =
    slots.length > 0 ? (slots[slots.length - 1] as (typeof slots)[number]).endSeconds : 0;
  if (Math.abs(total - FLAGSHIP_DURATION_SECONDS) > 1e-3) {
    problems.push(`the plan's beats tile ${total.toFixed(3)}s, not ${FLAGSHIP_DURATION_SECONDS}s`);
  }

  if (problems.length > 0) throw new StoryboardConformanceError(problems);
  return { beatCount: plan.beats.length, totalSeconds: total, slots };
}

/**
 * The substitutions this cut makes, in the author's own words.
 *
 * Loaded from the campaign directory rather than inferred, for the same reason
 * the plan is: what a beat could not have and why the thing it got is honest
 * instead is a creative judgement. Application code records it; it does not
 * write it.
 */
/**
 * Turns the committed request template into a loadable request for this run.
 *
 * The template deliberately omits `sourceAssetManifest` and `outputDirectory`:
 * both are properties of *where this run happens*, not of the brief, and
 * committing either would mean committing a path that is wrong everywhere
 * except one machine. The prompt is inlined from `promptFile` so the
 * materialised request carries the brief itself rather than a reference to a
 * file outside the run directory.
 */
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
  const materialised = {
    ...rest,
    campaignPrompt,
    sourceAssetManifest: input.sourceAssetManifestPath,
    outputDirectory: input.runDirectory,
  };

  const target = join(input.runDirectory, input.fileName);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(materialised, null, 2)}\n`, 'utf8');
  return loadCampaignRequest(target);
}

async function loadSubstitutions(campaignDirectory: string): Promise<readonly BeatSubstitution[]> {
  const raw = JSON.parse(
    await readFile(join(campaignDirectory, 'asset-substitutions.json'), 'utf8'),
  ) as { substitutions?: BeatSubstitution[] };
  return raw.substitutions ?? [];
}

export async function runFlagshipCampaign(options: FlagshipOptions): Promise<FlagshipResult> {
  const runner = options.runner ?? new NodeCommandRunner();
  const runDirectory = resolve(options.outputDirectory);
  const onProgress = options.onProgress;
  await mkdir(runDirectory, { recursive: true });

  const labels = {
    executionMode: FLAGSHIP_EXECUTION_MODE,
    outputUse: FLAGSHIP_OUTPUT_USE,
    isRealCampaignRun: FLAGSHIP_IS_REAL_CAMPAIGN_RUN,
    paidProviderCalls: FLAGSHIP_PAID_PROVIDER_CALLS,
  } as const;

  const fail = (exitCode: ExitCode, failure: string): FlagshipResult => ({
    exitCode,
    runDirectory,
    failure,
    ...labels,
  });

  // --- 1. the storyboard ----------------------------------------------------
  let storyboard: VerifiedStoryboardPackage;
  try {
    onProgress?.('verifying the storyboard package');
    storyboard = await verifyStoryboardPackage(options.storyboardRoot);
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
    outputEligible: storyboard.outputEligible,
    referenceRule: storyboard.referenceRule,
    frameCount: storyboard.frames.length,
    frames: storyboard.frames.map((frame) => ({
      frameId: frame.frameId,
      sequence: frame.sequence,
      startSeconds: frame.startSeconds,
      endSeconds: frame.endSeconds,
      purpose: frame.purpose,
      requiredProductionRole: frame.requiredProductionRole,
      checksumSha256: frame.checksumSha256,
      referenceOnly: frame.referenceOnly,
      outputEligible: frame.outputEligible,
    })),
    claimsRequiringValidation: storyboard.claimsRequiringValidation,
  });

  // --- 2. the library the packs supply --------------------------------------
  const campaignDirectory = resolve(options.campaignDirectory);
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

  // --- 3. the committed campaign source -------------------------------------
  //
  // The campaign directory holds a request *template*: everything about the
  // brief that is fixed, and nothing about where this particular run reads its
  // media from or writes its output to. Those two are supplied by flags, so
  // they are injected here rather than committed as paths that would be wrong
  // on every machine but one.
  let sourceRequest: CampaignRequest;
  let treatment: ProductionTreatment;
  let substitutions: readonly BeatSubstitution[];
  try {
    onProgress?.('loading the campaign brief, plan and approved treatment');
    sourceRequest = await materialiseRequest({
      campaignDirectory,
      runDirectory,
      sourceAssetManifestPath: libraryManifestPath,
      fileName: 'flagship-request.preflight.json',
    });
    treatment = await loadProductionTreatment(
      join(campaignDirectory, 'production-treatment.json'),
      {
        campaignId: sourceRequest.campaignId,
        storyboardId: storyboard.storyboardId,
      },
    );
    substitutions = await loadSubstitutions(campaignDirectory);
  } catch (error) {
    return fail(
      EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
      error instanceof Error ? error.message : String(error),
    );
  }

  // --- 4. the plan, and the two contracts it has to satisfy ------------------
  const planPath = join(campaignDirectory, 'creative-plan.json');
  let plan: HumanCreativePlan;
  let conformance: StoryboardConformance;
  try {
    onProgress?.('validating the plan against the brief and the storyboard');
    plan = await loadHumanPlan(planPath, sourceRequest);
    conformance = assertStoryboardConformance(plan, storyboard);
    assertNoProhibitedClaims(authoredStringsOf(plan, treatment));
  } catch (error) {
    return fail(
      EXIT_CODES.INVALID_CAMPAIGN_REQUEST,
      error instanceof Error ? error.message : String(error),
    );
  }
  await writeArtefact(runDirectory, 'storyboard-conformance.json', {
    ...conformance,
    correctedCta: CORRECTED_CTA,
    prohibitedClaimGate: 'PASSED — every authored string was checked against the closed rule set',
  });

  // --- 5. the generated discussion mockup ------------------------------------
  const stagingRoot = join(runDirectory, 'staged-assets');
  await mkdir(stagingRoot, { recursive: true });
  const logoAsset = libraryManifest.assets.find(
    (asset) => asset.id === plan.brandConstraints.logoAssetId,
  );
  if (!logoAsset) {
    return fail(
      EXIT_CODES.MISSING_PRODUCTION_ASSETS,
      `the plan's logo asset "${plan.brandConstraints.logoAssetId}" is not in the work pack library`,
    );
  }

  const needsMockup = plan.beats.some((beat) => beat.source.assetId === PRODUCT_MOCKUP_ASSET_ID);
  let mockup: Awaited<ReturnType<typeof buildProductMockup>> | null = null;
  if (needsMockup) {
    try {
      onProgress?.('building the declared PRODUCT_MOCKUP discussion screen');
      mockup = await buildProductMockup({
        runner,
        binaries: options.binaries,
        stagingRoot,
        logoAbsolutePath: resolve(libraryManifestDir, logoAsset.path),
        brand: {
          backgroundHex: plan.brandConstraints.primaryColorHex,
          accentHex: plan.brandConstraints.accentColorHex,
          surfaceHex: '#15151C',
          mutedHex: '#3A3A46',
        },
        widthPx: 1080,
        heightPx: 1920,
      });
      await writeArtefact(runDirectory, 'product-mockup-provenance.json', mockup.provenance);
    } catch (error) {
      return fail(
        EXIT_CODES.MISSING_PRODUCTION_ASSETS,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // --- 6. reconciliation across every declared pack --------------------------
  const roots: DeclaredSourceRoot[] = [
    {
      label: 'work-pack',
      path: workPackRoot,
      expectation:
        'real Combat Reviews captures, the owned mark, approved licensed footage, temporary audio',
    },
    ...(options.premiumPackRoot
      ? [
          {
            label: 'premium-pack',
            path: resolve(options.premiumPackRoot),
            expectation: 'premium craft documentation, rights evidence and benchmark annotations',
          },
        ]
      : []),
    ...(options.pilotPackRoot
      ? [
          {
            label: 'pilot-pack',
            path: resolve(options.pilotPackRoot),
            expectation: 'earlier candidate media, previews and licence evidence',
          },
        ]
      : []),
  ];

  let reconciliation: ReconciliationReport;
  try {
    onProgress?.(`reconciling assets across ${roots.length} declared pack(s)`);
    reconciliation = await reconcileAssets({
      roots,
      plan,
      storyboard,
      libraryManifest,
      libraryManifestDir,
      substitutions,
      generatedAssets: mockup
        ? [
            {
              asset: mockup.asset,
              absolutePath: mockup.absolutePath,
              sourceRootLabel: 'generated by this run (PRODUCT_MOCKUP)',
            },
          ]
        : [],
    });
  } catch (error) {
    return fail(
      EXIT_CODES.MISSING_PRODUCTION_ASSETS,
      error instanceof Error ? error.message : String(error),
    );
  }

  // --- 7. staging -----------------------------------------------------------
  const requiredAssetIds = [
    ...plan.beats
      .map((beat) => beat.source.assetId)
      .filter((id): id is string => Boolean(id) && id !== PRODUCT_MOCKUP_ASSET_ID),
    plan.brandConstraints.logoAssetId,
    ...(plan.audio.musicAssetId ? [plan.audio.musicAssetId] : []),
    ...Object.values(plan.audio.cueAssetIds).filter((id): id is string => Boolean(id)),
  ];

  let staging;
  try {
    onProgress?.(`staging ${new Set(requiredAssetIds).size} asset(s) into a root this run owns`);
    staging = await stageAssets({
      libraryManifest,
      libraryManifestDir,
      stagingRoot,
      requiredAssetIds,
      generatedAssets: mockup ? [mockup.asset] : [],
      libraryLabel: `Combat Reviews flagship 01 — staged from ${libraryManifest.library}`,
      forbiddenChecksums: new Set(storyboard.excludedChecksums),
    });
  } catch (error) {
    return fail(
      EXIT_CODES.MISSING_PRODUCTION_ASSETS,
      error instanceof Error ? error.message : String(error),
    );
  }
  await writeArtefact(runDirectory, 'asset-reconciliation.json', {
    roots: reconciliation.roots,
    totalMediaFilesDiscovered: reconciliation.totalMediaFilesDiscovered,
    beats: reconciliation.rows,
    unresolvedGaps: reconciliation.unresolvedGaps,
    staged: staging.assets.map((asset) => ({
      assetId: asset.assetId,
      stagedRelativePath: asset.stagedRelativePath,
      checksumSha256: asset.checksumSha256,
      copiedThisRun: asset.copied,
    })),
    generatedAssetIds: staging.generatedAssetIds,
    externalRootsWereReadOnly: true,
  });

  // --- 8. nothing reference-shaped can reach the encoder ---------------------
  let stagingProof;
  try {
    onProgress?.('proving no storyboard byte can reach the renderer');
    stagingProof = await proveStagingRootExclusion({ stagingRoot, storyboard });
  } catch (error) {
    return fail(
      EXIT_CODES.INVALID_ASSET_RIGHTS,
      error instanceof Error ? error.message : String(error),
    );
  }

  // --- 9. the render, through the existing preview path, unchanged -----------
  //
  // The same template again, now pointing at the staged root rather than the
  // pack. Identical in every field the plan is bound to — prompt hash,
  // campaign, duration, CTA, logo — so the plan that validated in step 4
  // validates against this one too.
  const request = await materialiseRequest({
    campaignDirectory,
    runDirectory,
    sourceAssetManifestPath: staging.manifestPath,
    fileName: 'flagship-request.json',
  });
  onProgress?.('rendering through the zero-cost footage-first preview path');
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

  // --- 10. the same proof again, over what was actually rendered ------------
  let exclusionProof;
  try {
    const renderManifest = parseRenderManifest(
      JSON.parse(await readFile(join(runDirectory, 'render-manifest.json'), 'utf8')),
    );
    exclusionProof = await proveReferenceExclusion({ manifest: renderManifest, storyboard });
  } catch (error) {
    return fail(
      EXIT_CODES.INVALID_ASSET_RIGHTS,
      error instanceof Error ? error.message : String(error),
    );
  }
  await writeArtefact(runDirectory, 'reference-exclusion-proof.json', {
    beforeRender: stagingProof,
    afterRender: exclusionProof,
    storyboardFramesUsedAsProductionMedia: 0,
    referenceMaterialIsAnalysisOnly: true,
  });

  // --- 11. the gallery ------------------------------------------------------
  onProgress?.('sampling review frames and writing the gallery');
  const gallery = await extractGalleryFrames({
    runner,
    binaries: options.binaries,
    runDirectory,
    masterPath: preview.outputPath,
    beats: conformance.slots.map((slot) => ({
      beatId: slot.beatId,
      label: slot.storyboardFrameId,
      startSeconds: slot.startSeconds,
      endSeconds: slot.endSeconds,
    })),
  });

  // --- 12. the scorecard ----------------------------------------------------
  const assetsById = new Map(libraryManifest.assets.map((asset) => [asset.id, asset]));
  const realCaptureBeatIds = plan.beats
    .filter((beat) => assetsById.get(beat.source.assetId ?? '')?.role === 'APP_SCREENSHOT')
    .map((beat) => beat.id);
  const mockupBeatIds = plan.beats
    .filter((beat) => beat.source.assetId === PRODUCT_MOCKUP_ASSET_ID)
    .map((beat) => beat.id);
  const audioIsTemporary = [plan.audio.musicAssetId, ...Object.values(plan.audio.cueAssetIds)]
    .filter((id): id is string => Boolean(id))
    .some((id) =>
      (assetsById.get(id)?.rights.restrictions ?? []).some((restriction) =>
        restriction.toUpperCase().includes('TEMPORARY'),
      ),
    );

  const qaReport = JSON.parse(
    await readFile(`${preview.outputPath}.qa.json`, 'utf8'),
  ) as Parameters<typeof buildAgencyScorecard>[0]['qaReport'];

  const scorecard = buildAgencyScorecard({
    campaignId: request.campaignId,
    qaReport,
    masterChecksumSha256: preview.outputChecksumSha256 ?? null,
    audioIsTemporary,
    realProductCaptureBeatIds: realCaptureBeatIds,
    totalBeatCount: plan.beats.length,
    mockupBeatIds,
    ctaHeadline: plan.cta.headline,
    ctaAction: plan.cta.subline ?? '',
    originalityRiskLevel: preview.originality?.riskLevel ?? 'UNKNOWN',
    measuredWidthPx: qaReport.summary.widthPx ?? null,
    measuredHeightPx: qaReport.summary.heightPx ?? null,
    measuredDurationSeconds: qaReport.summary.durationSeconds ?? null,
    outstandingLimitations: reconciliation.unresolvedGaps,
  });
  await writeArtefact(runDirectory, 'agency-scorecard.json', scorecard);

  const galleryPath = await writeGallery({
    runDirectory,
    campaignName: request.name,
    masterPath: preview.outputPath,
    masterChecksumSha256: preview.outputChecksumSha256 ?? null,
    measured: {
      widthPx: qaReport.summary.widthPx ?? null,
      heightPx: qaReport.summary.heightPx ?? null,
      durationSeconds: qaReport.summary.durationSeconds ?? null,
      videoCodec: qaReport.summary.videoCodec ?? null,
      audioCodec: qaReport.summary.audioCodec ?? null,
      pixelFormat: qaReport.summary.pixelFormat ?? null,
    },
    qaVerdict: preview.qaVerdict ?? 'UNKNOWN',
    frames: gallery.frames,
    contactSheet: gallery.contactSheet,
    rows: reconciliation.rows,
    scorecard,
    executionMode: FLAGSHIP_EXECUTION_MODE,
    outputUse: FLAGSHIP_OUTPUT_USE,
  });

  // --- 13. provenance -------------------------------------------------------
  const provenance = {
    flagshipRunVersion: 1,
    campaignId: request.campaignId,
    workspaceId: request.workspaceId,
    workflowRunId: options.workflowRunId,
    ...labels,
    requiresHumanApproval: true,
    reasoningProviderCalls: 0,
    videoGenerationProviderCalls: 0,
    planAuthoredBy: plan.authoredBy,
    treatmentApprovedBy: treatment.approvedBy,
    storyboard: {
      storyboardId: storyboard.storyboardId,
      usageClass: storyboard.usageClass,
      outputEligible: storyboard.outputEligible,
      frameChecksums: storyboard.frames.map((frame) => ({
        frameId: frame.frameId,
        checksumSha256: frame.checksumSha256,
        referenceOnly: true,
        outputEligible: false,
      })),
    },
    master: {
      path: preview.outputPath,
      checksumSha256: preview.outputChecksumSha256 ?? null,
      qaVerdict: preview.qaVerdict ?? null,
      measured: {
        widthPx: qaReport.summary.widthPx ?? null,
        heightPx: qaReport.summary.heightPx ?? null,
        durationSeconds: qaReport.summary.durationSeconds ?? null,
        frameRate: qaReport.summary.frameRate ?? null,
        videoCodec: qaReport.summary.videoCodec ?? null,
        audioCodec: qaReport.summary.audioCodec ?? null,
        pixelFormat: qaReport.summary.pixelFormat ?? null,
        faststart: qaReport.summary.faststart ?? null,
      },
    },
    audioIsTemporary,
    agencyGradeClaim: scorecard.agencyGradeClaim,
    scorecardStatus: scorecard.status,
    blockingDefectCodes: scorecard.blockingDefects.map((defect) => defect.code),
    anyReferenceOutputEligible: false,
    externalRootsWereReadOnly: true,
    caveat:
      'HUMAN_ASSISTED_PREVIEW — a person authored every creative decision and the pipeline executed them deterministically. No reasoning model and no generation provider was called. The storyboard is REFERENCE_ONLY and contributed no pixel. This is an internal-review cut, not a published advertisement, and it is not agency-grade.',
  };
  await writeArtefact(runDirectory, 'flagship-provenance.json', provenance);

  // A self-checksum over the canonical serialisation, so a later reader can
  // tell an edited provenance record from an original one.
  const provenanceJson = `${JSON.stringify(provenance, null, 2)}\n`;
  await writeArtefact(runDirectory, 'flagship-provenance.checksum.json', {
    file: 'flagship-provenance.json',
    algorithm: 'SHA256',
    checksum: createHash('sha256').update(provenanceJson, 'utf8').digest('hex'),
    masterChecksumSha256: preview.outputChecksumSha256 ?? null,
    storyboardContactSheetSha256: storyboard.contactSheet.checksumSha256,
  });

  const artefacts = [
    'storyboard-verification.json',
    'storyboard-conformance.json',
    'asset-reconciliation.json',
    ...(mockup ? ['product-mockup-provenance.json'] : []),
    'reference-exclusion-proof.json',
    'render-manifest.json',
    'agency-scorecard.json',
    'flagship-provenance.json',
    'flagship-provenance.checksum.json',
    'flagship-gallery.html',
    ...(gallery.contactSheet ? [gallery.contactSheet] : []),
    ...(preview.artefacts ?? []),
  ];

  return {
    exitCode: preview.exitCode,
    runDirectory,
    outputPath: preview.outputPath,
    qaVerdict: preview.qaVerdict ?? 'UNKNOWN',
    measured: provenance.master.measured,
    scorecard,
    reconciliation,
    galleryPath,
    artefacts,
    ...(preview.failure ? { failure: preview.failure } : {}),
    ...labels,
  };
}

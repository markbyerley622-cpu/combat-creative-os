import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  CANONICAL_SCREEN_ASPECT,
  canonicalMobileViewport,
  compileShotComposite,
  compileUiLayerGraph,
  concatDemuxerList,
  devicePixelRect,
  documentRectToScreen,
  measureMappingUniformity,
  measureQuadGeometry,
  normaliseQuadForCover,
  quadAtZoom,
  runActualMediaQa,
  type ActualMediaQaReport,
  type CameraMove,
  type CommandRunner,
  type FfmpegBinaries,
  type NormalisedQuad,
  type RenderManifest,
  type ShotCompositeSpec,
  type UiAccent,
  type UiDocument,
  type UiFixedOverlay,
  type UiState,
} from '@combat/media';

import { calibrateScreen, readPlateLuma, type CalibratedScreen } from './calibration';
import { renderMobileDocuments } from './document-renderer';
import { buildMobileDocuments, loadMarkDataUri, MOCKUP_NOTICE } from './mobile-documents';
import { buildComparisonGallery } from './gallery';
import { buildDefectsReport, buildTimingReport, type ProductMotionReports } from './reports';
import {
  parseProductMotionPlan,
  PRODUCT_MOTION_LABEL,
  ProductMotionError,
  type ProductMotionPlan,
} from './product-motion-contracts';

/**
 * The Product Motion Proof run.
 *
 * Three FFmpeg passes, in an order chosen by what each one protects:
 *
 * 1. **The interface layer**, alone, at canvas resolution. Rendering it
 *    separately means the type is rasterised once, from captured pixels,
 *    before anything geometric happens to it — and it leaves a artefact a
 *    reviewer can scrub on its own when the composite looks wrong.
 * 2. **The shots**, each moving its plate and then warping the interface onto
 *    the handset. Compositing *after* the photographic move is what keeps the
 *    type from being scaled by the camera.
 * 3. **The mix and the mux**, with the video stream copied rather than
 *    re-encoded, so the picture that passed the eye in pass 2 is the picture
 *    that ships.
 *
 * Nothing in this file constructs a reasoning provider, a generation provider,
 * a database client or an HTTP client. That is a property of the object graph,
 * and `product-motion-source-hygiene.test.ts` asserts it rather than trusting
 * this comment.
 */

export interface ProductMotionRequest {
  readonly planPath: string;
  readonly platesRoot: string;
  readonly assetsRoot: string;
  readonly outputRoot: string;
  readonly binaries: FfmpegBinaries;
  readonly runner: CommandRunner;
  readonly measuredAt: Date;
  readonly renderTimeoutMs?: number;
}

export interface ProductMotionResult {
  readonly plan: ProductMotionPlan;
  readonly outputPath: string;
  readonly uiLayerPath: string;
  readonly qaReport: ActualMediaQaReport;
  readonly calibration: readonly CalibratedScreen[];
  readonly reports: ProductMotionReports;
  readonly galleryPath: string;
  readonly paidProviderCalls: 0;
  readonly isRealCampaignRun: false;
}

const ACCENT_INTENT_NOTICE =
  'Every mark this proof adds is a rectangle in the brand accent. No text, label, number or ' +
  'interface element is drawn by this pipeline; all product typography is captured pixels.';

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function resolveUnder(root: string, relativePath: string, what: string): string {
  if (isAbsolute(relativePath) || relativePath.includes('..')) {
    throw new ProductMotionError(
      'INVALID_PLAN',
      `${what} "${relativePath}" must be a relative path inside its root; the plan may not name absolute or parent paths`,
    );
  }
  return resolve(root, relativePath);
}

export async function runProductMotionProof(
  request: ProductMotionRequest,
): Promise<ProductMotionResult> {
  const plan = parseProductMotionPlan(
    JSON.parse(await readFile(request.planPath, 'utf8')),
    request.planPath,
  );

  const runDirectory = join(request.outputRoot, plan.id);
  const stagingDirectory = join(runDirectory, 'staged-inputs');
  const workDirectory = join(runDirectory, 'work');
  const galleryDirectory = join(runDirectory, 'gallery');
  await mkdir(stagingDirectory, { recursive: true });
  await mkdir(workDirectory, { recursive: true });
  await mkdir(galleryDirectory, { recursive: true });

  // ---- staging -------------------------------------------------------------
  // External packs are read-only. Everything the render touches is a copy this
  // run owns, and every copy's checksum is recomputed after the copy so a
  // truncated read cannot pass as the original.
  const staged = new Map<string, { path: string; checksum: string; origin: string }>();
  const stage = async (key: string, origin: string, fileName: string): Promise<void> => {
    const target = join(stagingDirectory, fileName);
    await copyFile(origin, target);
    const checksum = await sha256(target);
    const originChecksum = await sha256(origin);
    if (checksum !== originChecksum) {
      throw new ProductMotionError('ASSET_NOT_FOUND', `staging changed the bytes of ${origin}`);
    }
    staged.set(key, { path: target, checksum, origin });
  };

  for (const plate of plan.plates) {
    await stage(
      `plate:${plate.id}`,
      resolveUnder(request.platesRoot, plate.file, 'plate'),
      `plate-${plate.id}.png`,
    );
  }
  // Documents are not staged: they are rendered, below, from the canonical
  // viewport. Only the brand mark is read from the assets root.
  await stage(
    'brand:mark',
    resolveUnder(request.assetsRoot, plan.brandMarkFile, 'brand mark'),
    'brand-mark.png',
  );
  await stage(
    'audio:bed',
    resolveUnder(request.assetsRoot, plan.audio.bedFile, 'audio bed'),
    'audio-bed.wav',
  );
  for (const cue of plan.audio.cues) {
    await stage(
      `audio:${cue.id}`,
      resolveUnder(request.assetsRoot, cue.file, 'audio cue'),
      `audio-${cue.id}.wav`,
    );
  }

  const stagedPath = (key: string): string => {
    const entry = staged.get(key);
    if (!entry) throw new ProductMotionError('ASSET_NOT_FOUND', `nothing staged for ${key}`);
    return entry.path;
  };

  // ---- calibration ---------------------------------------------------------
  const calibration: CalibratedScreen[] = [];
  const normalisedQuads = new Map<string, NormalisedQuad>();
  for (const plate of plan.plates) {
    const plane = await readPlateLuma({
      ffmpegPath: request.binaries.ffmpeg,
      platePath: stagedPath(`plate:${plate.id}`),
      widthPx: plate.widthPx,
      heightPx: plate.heightPx,
    });
    calibration.push(calibrateScreen({ plateId: plate.id, quad: plate.screen, plane }));
    normalisedQuads.set(
      plate.id,
      normaliseQuadForCover(plate.screen, {
        sourceWidthPx: plate.widthPx,
        sourceHeightPx: plate.heightPx,
        outputWidthPx: plan.output.widthPx,
        outputHeightPx: plan.output.heightPx,
      }),
    );
  }

  // ---- the canonical mobile screen ----------------------------------------
  // The viewport width is fixed at the canonical phone width for every
  // document. Only its height follows the calibrated screen, which is what
  // lets the whole rectangle map onto the glass without stretching, cropping
  // or padding — all three of which are forbidden. The reference height and
  // the deviation are reported.
  const referenceQuad = normalisedQuads.get(plan.shots[0]?.plateId ?? '');
  if (!referenceQuad) {
    throw new ProductMotionError('INVALID_PLAN', 'the first shot names no calibrated plate');
  }
  const referencePlate = plan.plates.find((plate) => plate.id === plan.shots[0]?.plateId);
  const screenAspect = referencePlate
    ? measureQuadGeometry(referencePlate.screen).aspectRatio
    : CANONICAL_SCREEN_ASPECT;
  const viewport = canonicalMobileViewport(screenAspect);
  const screen = devicePixelRect(viewport);

  const documentDirectory = join(runDirectory, 'documents');
  await mkdir(documentDirectory, { recursive: true });
  const markDataUri = await loadMarkDataUri(stagedPath('brand:mark'));
  const renderedDocuments = await renderMobileDocuments({
    viewport,
    documents: buildMobileDocuments({ viewport, markDataUri }).filter((specification) =>
      plan.documents.some((planned) => planned.id === specification.id),
    ),
    outputDirectory: documentDirectory,
  });
  const renderedById = new Map(renderedDocuments.map((entry) => [entry.id, entry]));

  const uniformity = plan.plates.map((plate) => ({
    plateId: plate.id,
    ...measureMappingUniformity(viewport, plate.screen),
  }));

  // ---- pass 1: the interface layer ----------------------------------------
  const uiDocumentIdFor = (planId: string): string => planId.replace(/[^A-Za-z0-9]/g, '');
  const uiDocuments: UiDocument[] = plan.documents.map((document, index) => {
    const renderedDocument = renderedById.get(document.id);
    if (!renderedDocument) {
      throw new ProductMotionError('INVALID_PLAN', `document "${document.id}" was not rendered`);
    }
    return {
      id: uiDocumentIdFor(document.id),
      inputIndex: index + 1,
      widthPx: renderedDocument.documentWidthPx,
      heightPx: renderedDocument.documentHeightPx,
    };
  });

  const uiStates: UiState[] = plan.states.map((state) => ({
    id: state.id,
    documentId: uiDocumentIdFor(state.documentId),
    startSeconds: state.startSeconds,
    endSeconds: state.endSeconds,
    entrance: state.entrance,
    entranceSeconds: state.entranceSeconds,
    scroll: state.scroll,
  }));

  const uiAccents: UiAccent[] = plan.accents.map((accent) => {
    const rect = documentRectToScreen(
      accent.documentRect,
      uiDocuments[0] as UiDocument,
      accent.atScrollPx,
    );
    return {
      id: accent.id,
      key: accent.key,
      xPx: rect.xPx,
      yPx: rect.yPx,
      widthPx: rect.widthPx,
      heightPx: rect.heightPx,
      startSeconds: accent.startSeconds,
      endSeconds: accent.endSeconds,
      colorHex: accent.colorHex,
    };
  });

  // The bottom navigation is fixed to the screen, so it is composited rather
  // than scrolled with the document. Each surface's own variant is enabled
  // while that surface is showing.
  const navigationInputBase = 1 + plan.documents.length;
  const fixedOverlays: UiFixedOverlay[] = plan.documents.flatMap((document, index) => {
    const renderedDocument = renderedById.get(document.id);
    if (!renderedDocument) return [];
    const windows = plan.states.filter((state) => state.documentId === document.id);
    if (windows.length === 0) return [];
    return [
      {
        id: `nav-${document.id}`,
        inputIndex: navigationInputBase + index,
        xPx: 0,
        yPx: screen.heightPx - renderedDocument.navigationHeightPx,
        startSeconds: Math.min(...windows.map((state) => state.startSeconds)),
        endSeconds: Math.max(...windows.map((state) => state.endSeconds)),
      },
    ];
  });

  const uiLayer = compileUiLayerGraph({
    canvasWidthPx: screen.widthPx,
    canvasHeightPx: screen.heightPx,
    frameRate: plan.output.frameRate,
    durationSeconds: plan.output.durationSeconds,
    documents: uiDocuments,
    states: uiStates,
    fixedOverlays,
    accents: uiAccents,
    baseInputIndex: 0,
  });

  const totalFrames = Math.round(plan.output.durationSeconds * plan.output.frameRate);
  const uiLayerPath = join(workDirectory, 'ui-layer.mp4');
  const uiArgs = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${screen.widthPx}x${screen.heightPx}:r=${plan.output.frameRate}`,
    ...plan.documents.flatMap((document) => [
      '-loop',
      '1',
      '-i',
      renderedById.get(document.id)?.documentPath ?? '',
    ]),
    ...plan.documents.flatMap((document) => [
      '-loop',
      '1',
      '-i',
      renderedById.get(document.id)?.navigationPath ?? '',
    ]),
    '-filter_complex',
    uiLayer.graph,
    '-map',
    `[${uiLayer.outputLabel}]`,
    '-frames:v',
    String(totalFrames),
    '-c:v',
    'libx264',
    '-crf',
    '12',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    uiLayerPath,
  ];
  await runFfmpeg(request, uiArgs, 'interface layer');

  // ---- pass 2: the shots ---------------------------------------------------
  // Each shot gets its own plate and interface-layer input rather than a split
  // off a shared one: two shots on the same plate is the return match cut, and
  // `filter_complex` will not let one input feed two chains.
  const shotSpecs: ShotCompositeSpec[] = [];
  const cameraMoves = new Map<string, CameraMove>();

  plan.shots.forEach((shot) => {
    const quad = normalisedQuads.get(shot.plateId);
    if (!quad) {
      throw new ProductMotionError('INVALID_PLAN', `shot "${shot.id}" names unknown plate`);
    }
    const duration = shot.endSeconds - shot.startSeconds;
    // Offsets are measured from the *frame* centre, not the screen's. At the
    // shallow zooms a restrained push uses there is barely any window to pan
    // inside — `assertPanWindowInsidePlate` bounds it — so anchoring on the
    // frame keeps the legal range obvious to whoever authors the plan, instead
    // of making it depend on where the handset happens to sit in the plate.
    const move: CameraMove = {
      startZoom: shot.move.startZoom,
      endZoom: shot.move.endZoom,
      panCentreU: 0.5 + shot.move.offsetU,
      panCentreV: 0.5 + shot.move.offsetV,
      frames: Math.round(duration * plan.output.frameRate),
    };
    cameraMoves.set(shot.id, move);

    // Every shot is its own FFmpeg invocation, so the input indices are fixed:
    // the plate first, the interface layer second.
    shotSpecs.push({
      shotId: shot.id,
      plateInputIndex: 0,
      uiInputIndex: 1,
      outputWidthPx: plan.output.widthPx,
      outputHeightPx: plan.output.heightPx,
      uiCanvasWidthPx: screen.widthPx,
      uiCanvasHeightPx: screen.heightPx,
      frameRate: plan.output.frameRate,
      durationSeconds: duration,
      uiStartSeconds: shot.startSeconds,
      quad,
      move,
    });
  });

  const shotPaths: string[] = [];
  for (const [index, spec] of shotSpecs.entries()) {
    const compiled = compileShotComposite(spec);
    const shotPath = join(workDirectory, `shot-${index}-${spec.shotId}.mp4`);
    await runFfmpeg(
      request,
      [
        '-y',
        '-loop',
        '1',
        '-i',
        stagedPath(`plate:${plan.shots[index]?.plateId ?? ''}`),
        '-i',
        uiLayerPath,
        '-filter_complex',
        compiled.graph,
        '-map',
        `[${compiled.outputLabel}]`,
        '-frames:v',
        String(Math.round(spec.durationSeconds * plan.output.frameRate)),
        '-c:v',
        'libx264',
        '-crf',
        '12',
        '-preset',
        'medium',
        '-pix_fmt',
        'yuv420p',
        shotPath,
      ],
      `shot ${spec.shotId}`,
    );
    shotPaths.push(shotPath);
  }

  const listPath = join(workDirectory, 'shots.txt');
  await writeFile(listPath, concatDemuxerList(shotPaths), 'utf8');
  const sequencePath = join(workDirectory, 'sequence.mp4');
  await runFfmpeg(
    request,
    ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', sequencePath],
    'shot concatenation',
  );

  // ---- pass 3: the mix, and the mux ---------------------------------------
  const duration = plan.output.durationSeconds;
  const audioSteps: string[] = [];
  audioSteps.push(
    `[1:a]aloop=loop=-1:size=2e9,atrim=duration=${duration},asetpts=PTS-STARTPTS,` +
      `volume=${plan.audio.bedGainDb}dB,afade=t=in:st=0:d=0.35,afade=t=out:st=${(duration - 0.7).toFixed(4)}:d=0.7[bed]`,
  );
  plan.audio.cues.forEach((cue, index) => {
    const delayMs = Math.round(cue.atSeconds * 1000);
    audioSteps.push(
      `[${index + 2}:a]asetpts=PTS-STARTPTS,volume=${cue.gainDb}dB,` +
        `adelay=${delayMs}|${delayMs},apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[cue${index}]`,
    );
  });
  const mixInputs = ['[bed]', ...plan.audio.cues.map((_, index) => `[cue${index}]`)].join('');
  audioSteps.push(
    `${mixInputs}amix=inputs=${plan.audio.cues.length + 1}:duration=first:dropout_transition=0:normalize=0[mix]`,
  );
  audioSteps.push(
    `[mix]aresample=48000,loudnorm=I=${plan.audio.integratedLufs}:TP=${plan.audio.truePeakDbtp}:LRA=11,` +
      `apad,atrim=duration=${duration},asetpts=PTS-STARTPTS,` +
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]',
  );

  const outputPath = join(runDirectory, `${plan.id}-${PRODUCT_MOTION_LABEL}.mp4`);
  await runFfmpeg(
    request,
    [
      '-y',
      '-i',
      sequencePath,
      '-i',
      stagedPath('audio:bed'),
      ...plan.audio.cues.flatMap((cue) => ['-i', stagedPath(`audio:${cue.id}`)]),
      '-filter_complex',
      audioSteps.join(';'),
      '-map',
      '0:v',
      '-map',
      '[aout]',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-shortest',
      outputPath,
    ],
    'mix and mux',
  );

  // ---- measurement ---------------------------------------------------------
  const qaManifest = buildQaDescriptorManifest(plan, staged);
  const qaReport = await runActualMediaQa(request.runner, {
    outputPath,
    manifest: qaManifest,
    workDir: workDirectory,
    ffmpegPath: request.binaries.ffmpeg,
    ffprobePath: request.binaries.ffprobe,
    measuredAt: request.measuredAt,
  });

  // ---- artefacts -----------------------------------------------------------
  const screenPositions = plan.shots.map((shot) => {
    const quad = normalisedQuads.get(shot.plateId);
    const move = cameraMoves.get(shot.id);
    if (!quad || !move)
      throw new ProductMotionError('INVALID_PLAN', `shot "${shot.id}" is unresolved`);
    return {
      shotId: shot.id,
      atStart: quadAtZoom(
        quad,
        move,
        shot.move.startZoom,
        plan.output.widthPx,
        plan.output.heightPx,
      ),
      atEnd: quadAtZoom(quad, move, shot.move.endZoom, plan.output.widthPx, plan.output.heightPx),
    };
  });

  const reports = {
    timing: buildTimingReport(plan, screenPositions, qaReport),
    defects: buildDefectsReport({
      plan,
      qaReport,
      calibration,
      plateSourceWidthPx: Math.max(...plan.plates.map((plate) => plate.widthPx)),
      accentNotice: ACCENT_INTENT_NOTICE,
    }),
  } satisfies ProductMotionReports;

  await writeFile(
    join(runDirectory, 'timing-and-transitions.json'),
    `${JSON.stringify(reports.timing, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(runDirectory, 'defects.json'),
    `${JSON.stringify(reports.defects, null, 2)}\n`,
    'utf8',
  );
  // The measurements that answer "is this a phone layout?" — written whether
  // or not anything failed, because a reader needs the numbers, not a verdict.
  await writeFile(
    join(runDirectory, 'viewport-measurements.json'),
    `${JSON.stringify(
      {
        label: PRODUCT_MOTION_LABEL,
        classification: 'PRODUCT_MOCKUP',
        notice: MOCKUP_NOTICE,
        canonicalViewport: {
          cssWidthPx: viewport.cssWidthPx,
          cssHeightPx: viewport.cssHeightPx,
          deviceScaleFactor: viewport.deviceScaleFactor,
          isMobile: viewport.isMobile,
          hasTouch: viewport.hasTouch,
          orientation: viewport.orientation,
          fullPage: viewport.fullPage,
          userAgent: viewport.userAgent,
        },
        canonicalReferenceCssHeightPx: Math.round(viewport.cssWidthPx * CANONICAL_SCREEN_ASPECT),
        deviceScreenPx: screen,
        documentAspect: viewport.cssHeightPx / viewport.cssWidthPx,
        mappingUniformity: uniformity,
        documents: renderedDocuments.map((entry) => ({
          id: entry.id,
          surface: entry.surface,
          documentWidthPx: entry.documentWidthPx,
          documentHeightPx: entry.documentHeightPx,
          scrollTravelPx: entry.documentHeightPx - screen.heightPx,
          navigationHeightPx: entry.navigationHeightPx,
          measurement: entry.measurement,
          horizontalOverflowPx: Math.max(
            0,
            entry.measurement.scrollWidthPx - entry.measurement.clientWidthPx,
          ),
          clippedElementCount: entry.measurement.overflowingElements.length,
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await writeFile(
    join(runDirectory, 'calibration.json'),
    `${JSON.stringify(
      calibration.map((entry) => ({ plateId: entry.plateId, ...entry.report })),
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(runDirectory, 'provenance.json'),
    `${JSON.stringify(
      {
        label: PRODUCT_MOTION_LABEL,
        planId: plan.id,
        authoredBy: plan.authoredBy,
        isRealCampaignRun: false,
        paidProviderCalls: 0,
        providersConstructed: [],
        credentialsRead: [],
        networkRequests: 0,
        requiresHumanApproval: true,
        isPublicReleaseReady: false,
        accentNotice: ACCENT_INTENT_NOTICE,
        stagedInputs: [...staged.entries()].map(([key, entry]) => ({
          key,
          origin: entry.origin,
          staged: entry.path,
          checksumSha256: entry.checksum,
          checksumRecalculatedAfterStaging: true,
        })),
        master: {
          path: outputPath,
          checksumSha256: qaReport.summary.checksumSha256,
          qaVerdict: qaReport.verdict,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const galleryPath = await buildComparisonGallery({
    plan,
    runner: request.runner,
    binaries: request.binaries,
    calibration,
    normalisedQuads,
    cameraMoves,
    platePathFor: (plateId) => stagedPath(`plate:${plateId}`),
    uiLayerPath,
    outputPath,
    galleryDirectory,
  });

  return {
    plan,
    outputPath,
    uiLayerPath,
    qaReport,
    calibration,
    reports,
    galleryPath,
    paidProviderCalls: 0,
    isRealCampaignRun: false,
  };
}

async function runFfmpeg(
  request: ProductMotionRequest,
  args: readonly string[],
  stage: string,
): Promise<void> {
  const result = await request.runner.run(request.binaries.ffmpeg, args, {
    timeoutMs: request.renderTimeoutMs ?? 20 * 60_000,
  });
  if (result.exitCode !== 0) {
    throw new ProductMotionError(
      'RENDER_FAILED',
      `FFmpeg failed during the ${stage} pass (exit ${result.exitCode}):\n${result.stderr.slice(-4000)}`,
    );
  }
}

/**
 * A descriptor manifest, purely so the existing actual-media QA can run.
 *
 * It is not the render input — this path composites through its own graph —
 * and it says so in its campaign prompt. What it must be is *accurate*: the
 * delivery block, the scene durations and the sources are the real ones, so
 * every measurement QA takes from the file is compared against what was
 * actually intended. A one-frame `CUT` overlap is how this repository's
 * manifest vocabulary already spells a hard cut at 30fps.
 */
function buildQaDescriptorManifest(
  plan: ProductMotionPlan,
  staged: ReadonlyMap<string, { path: string; checksum: string; origin: string }>,
): RenderManifest {
  const cutSeconds = 1 / plan.output.frameRate;
  const scenes = plan.shots.map((shot, index) => ({
    id: shot.id,
    sourceId: `plate-${shot.plateId}`,
    durationSeconds: shot.endSeconds - shot.startSeconds + (index === 0 ? 0 : cutSeconds),
    framing: { mode: 'COVER' as const, anchorX: 0.5, anchorY: 0.5 },
    // Every shot pushes in, and saying so is load-bearing rather than
    // decorative: QA excludes scenes that declare stillness from its
    // frozen-frame walk, so a descriptor claiming `STATIC` would switch off
    // the one check that catches this proof failing at its own purpose. A
    // sequence that had quietly stopped moving would pass.
    motion: 'PUSH_IN' as const,
    motionIntensity: Math.min(1, Math.abs(shot.move.endZoom - shot.move.startZoom) * 10),
    useSourceAudio: false,
    ...(index === 0 ? {} : { transitionIn: { kind: 'CUT' as const, durationSeconds: cutSeconds } }),
  }));

  const sources = plan.plates.map((plate) => {
    const entry = staged.get(`plate:${plate.id}`);
    return {
      id: `plate-${plate.id}`,
      kind: 'IMAGE' as const,
      path: entry?.path ?? '',
      description: plate.description,
      license: {
        usageClass: 'OWNED' as const,
        rightsHolder: 'Combat Reviews',
        licenseType: 'OWNED',
        restrictions: [`${PRODUCT_MOTION_LABEL} — internal motion proof, not an approved master`],
      },
      expectedChecksum: entry?.checksum,
    };
  });

  return {
    manifestVersion: 2,
    name: plan.id,
    campaignId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    campaignPrompt: `${PRODUCT_MOTION_LABEL}. ${plan.brief}`,
    output: {
      durationSeconds: plan.output.durationSeconds,
      aspectRatio: '9:16',
      widthPx: plan.output.widthPx,
      heightPx: plan.output.heightPx,
      frameRate: plan.output.frameRate,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      durationToleranceFrames: 2,
      deliveryProfileKey: 'VERTICAL_SHORT_FORM_V1',
      deliveryProfileVersion: 1,
    },
    sources,
    scenes,
    overlays: [],
    audio: {
      tracks: [],
      loudness: {
        integratedLufs: plan.audio.integratedLufs,
        truePeakDbtp: plan.audio.truePeakDbtp,
        loudnessRange: 11,
      },
      musicDuckingDb: 0,
    },
  } as unknown as RenderManifest;
}

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { NodeCommandRunner, resolveFfmpegBinaries } from '@combat/media';
import { LtxHostedVideoGenerationProvider } from '@combat/providers';
import { FakeLtxServer } from '@combat/providers/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOCKED_SCENE_ROLES, LOCKED_SCENE_SLOTS } from '../flagship/storyboard-v2';
import { STORYBOARD_VIDEO_EXIT_CODES } from './failures';
import { runMotionReviewCli } from './motion-review-cli';
import { MOTION_REVIEW_GALLERY_FILENAME } from './motion-review-gallery';
import { MotionReviewLedger } from './motion-review-store';
import { runStoryboardVideo, type StoryboardVideoResult } from './run-storyboard-video';

/**
 * The whole path, proven with committed synthetic fixtures and the in-process
 * fake LTX server.
 *
 * What this establishes, all of it against real FFmpeg and none of it against
 * a third party: ten scene sources resolve; a run with nothing reviewed
 * refuses before FFmpeg composition starts; one rejected scene blocks it;
 * replacing that scene invalidates the earlier decision; approving the
 * replacement unblocks it; and the finished master is a genuine 15.000 s
 * 1080x1920 h264/AAC file that passes actual-media QA, with provenance naming
 * every source, no reference material in the manifest and no credential in any
 * artefact.
 *
 * Not one paid call is made. `LTXV_API_KEY` is never read: the run is handed a
 * provider built against the fake server through the injection seam that
 * exists for exactly this.
 *
 * It needs a real FFmpeg and skips loudly without one, which is the normal
 * outcome under `pnpm test` on a machine that has none.
 */

/** Synchronous: `describe.skip` has to be chosen while the module is evaluated. */
function ffmpegAvailable(): boolean {
  const binaries = resolveFfmpegBinaries(process.env);
  const probe = spawnSync(binaries.ffprobe, ['-version'], { stdio: 'ignore' });
  const encode = spawnSync(binaries.ffmpeg, ['-version'], { stdio: 'ignore' });
  return probe.status === 0 && encode.status === 0;
}

const available = ffmpegAvailable();
const suite = available ? describe : describe.skip;
if (!available) {
  // eslint-disable-next-line no-console -- a skipped acceptance test must say why
  console.warn(
    '[motion-review-acceptance] SKIPPED: no FFmpeg/ffprobe on PATH (set FFMPEG_PATH / FFPROBE_PATH). This suite proves the gate against a real 1080x1920 master; it is not being proven here.',
  );
}

const API_KEY = 'ltx_test_key_do_not_use_0123456789';
const CAMPAIGN_SOURCE_DIRECTORY = resolve(
  __dirname,
  '..',
  '..',
  'campaigns',
  'combat-reviews-flagship-02',
);

/**
 * A fixture copy of the campaign, with the two `HANDHELD_DRIFT` scenes retimed
 * to a motion `ltx-hosted` can express.
 *
 * The committed campaign asks LTX for a handheld drift on scenes 8 and 9, and
 * that provider has no handheld value at all — so those scenes are now refused
 * before upload, by design. This suite is about the *motion gate*, not the
 * camera vocabulary, and it needs ten resolvable scenes to exercise one.
 * Choosing a motion here is a fixture concern; the advertisement's own
 * manifest is left exactly as its author wrote it, and the refusal it now
 * provokes is pinned by its own test in `storyboard-video-contracts`.
 */
let campaignDirectory: string;
const REVIEWER = 'Riki Taylor';

/** Scenes whose source is a clip the operator animated outside this pipeline. */
const MANUAL_SCENES = [1, 7];
/** The scene an acquired production plate fills. */
const ACQUIRED_SCENE = 2;
/** Scenes this pipeline generates. */
const GENERATED_SCENES = [5, 8, 9];
/** Scenes animated deterministically from their panel. */
const DETERMINISTIC_SCENES = [3, 4, 6, 10];

const binaries = resolveFfmpegBinaries(process.env);
const runner = new NodeCommandRunner();

let workspace: string;
let storyboardRoot: string;
let framesDirectory: string;
let manualClipsDirectory: string;
let footagePackRoot: string;
let workPackRoot: string;
let reviewDirectory: string;
let generatedClipBytes: Map<number, Uint8Array>;
/** A visibly different clip for scene 8, used to prove a replacement invalidates a decision. */
let replacementClipBytes: Uint8Array;

async function ffmpeg(args: readonly string[]): Promise<void> {
  const result = await runner.run(binaries.ffmpeg, ['-nostdin', '-v', 'error', ...args], {
    timeoutMs: 300_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr.trim().slice(-400)}`);
  }
}

const sha = (bytes: Buffer | Uint8Array): string =>
  createHash('sha256').update(Buffer.from(bytes)).digest('hex');

/**
 * A detailed synthetic still, distinct per scene.
 *
 * `testsrc2` at a different second per scene gives ten genuinely different
 * compositions with enough high-frequency detail that a motion measurement and
 * a layout correlation both have something to work with — a flat colour card
 * would make every measurement degenerate and prove nothing.
 */
async function makeKeyframe(
  target: string,
  seed: number,
  widthPx = 1080,
  heightPx = 1920,
): Promise<void> {
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${widthPx}x${heightPx}:rate=1:duration=30`,
    '-ss',
    String(seed * 2 + 1),
    '-frames:v',
    '1',
    '-y',
    target,
  ]);
}

/**
 * A clip that genuinely starts from the keyframe and genuinely moves.
 *
 * A push-in built from the plate itself, so the first frame is the approved
 * composition and the layout agreement clears its floor — the same
 * relationship a real image-to-video generation is supposed to have with the
 * frame it was seeded from.
 *
 * The zoom rate is calibrated, not guessed: at 0.0009 per frame this fixture
 * measures 0.38 motion energy and would fail the `HANDHELD_DRIFT` floor of
 * 0.45 that scenes 8 and 9 declare. At 0.0045 it measures 2.07 and clears
 * every floor in the profile, which is where a real moving plate sits.
 */
async function makeClipFromKeyframe(
  keyframePath: string,
  target: string,
  seconds: number,
): Promise<void> {
  await ffmpeg([
    '-loop',
    '1',
    '-i',
    keyframePath,
    '-t',
    String(seconds),
    '-vf',
    `scale=1080:1920,zoompan=z='min(zoom+0.0045,1.6)':d=${Math.round(seconds * 24)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=24,format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-y',
    target,
  ]);
}

/** A landscape acquired plate, the shape real licensed footage actually arrives in. */
async function makeAcquiredPlate(target: string, seconds: number): Promise<void> {
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=2160x3840:rate=24:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-y',
    target,
  ]);
}

async function makeTone(target: string, frequency: number, seconds: number): Promise<void> {
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:duration=${seconds}:sample_rate=48000`,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-y',
    target,
  ]);
}

beforeAll(async () => {
  if (!available) return;
  workspace = await mkdtemp(join(tmpdir(), 'aamp-motion-acceptance-'));

  campaignDirectory = join(workspace, 'campaign');
  await cp(CAMPAIGN_SOURCE_DIRECTORY, campaignDirectory, { recursive: true });
  const fixtureManifestPath = join(campaignDirectory, 'scene-manifest.json');
  const fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8')) as {
    scenes: { cameraMotion: string }[];
  };
  for (const scene of fixtureManifest.scenes) {
    if (scene.cameraMotion === 'HANDHELD_DRIFT') scene.cameraMotion = 'STATIC';
  }
  await writeFile(
    fixtureManifestPath,
    `${JSON.stringify(fixtureManifest, null, 2)}
`,
    'utf8',
  );
  storyboardRoot = join(workspace, 'storyboard');
  framesDirectory = join(workspace, 'keyframes');
  manualClipsDirectory = join(framesDirectory, 'generated-clips');
  footagePackRoot = join(workspace, 'footage-pack');
  workPackRoot = join(workspace, 'work-pack');
  reviewDirectory = join(workspace, 'review');

  await mkdir(join(storyboardRoot, 'frames'), { recursive: true });
  await mkdir(manualClipsDirectory, { recursive: true });
  await mkdir(join(footagePackRoot, 'approved-free-originals'), { recursive: true });
  await mkdir(join(footagePackRoot, 'acquisition-evidence'), { recursive: true });
  await mkdir(join(footagePackRoot, 'candidates'), { recursive: true });
  await mkdir(join(workPackRoot, 'asset-root'), { recursive: true });

  // --- the ten authoritative keyframes, and the storyboard's own panels -----
  for (let sceneNumber = 1; sceneNumber <= 10; sceneNumber += 1) {
    // eslint-disable-next-line no-await-in-loop -- fixture construction, deterministic order
    await makeKeyframe(
      join(framesDirectory, `FRAME-${String(sceneNumber).padStart(2, '0')}.png`),
      sceneNumber,
    );
    // The panel is the same art at review resolution: small enough that the
    // 3x staging resample stays cheap, large enough to clear the delivery guard.
    // eslint-disable-next-line no-await-in-loop -- fixture construction
    await makeKeyframe(
      join(storyboardRoot, 'frames', `FRAME-${String(sceneNumber).padStart(2, '0')}.png`),
      sceneNumber,
      380,
      676,
    );
  }

  const sheet = Buffer.from('synthetic contact sheet', 'utf8');
  await writeFile(join(storyboardRoot, 'sheet.png'), sheet);

  const frames = [];
  for (const [index, sceneRole] of LOCKED_SCENE_ROLES.entries()) {
    const sequence = index + 1;
    const relativePath = `frames/FRAME-${String(sequence).padStart(2, '0')}.png`;
    // eslint-disable-next-line no-await-in-loop -- fixture construction
    const bytes = await readFile(join(storyboardRoot, relativePath));
    const slot = LOCKED_SCENE_SLOTS[index] as readonly [number, number];
    frames.push({
      frameId: `FRAME-${String(sequence).padStart(2, '0')}`,
      sequence,
      sceneRole,
      sourceFramePath: relativePath,
      startSeconds: slot[0],
      endSeconds: slot[1],
      durationSeconds: Number((slot[1] - slot[0]).toFixed(6)),
      purpose: `purpose ${sequence}`,
      visibleIntent: `intent ${sequence}`,
      viewerUnderstanding: `understanding ${sequence}`,
      requiredProductionRole: `role ${sequence}`,
      requiredAssetTypes: ['synthetic'],
      productFeature: `feature ${sequence}`,
      onScreenCopyIntent: [],
      factualClaimsRequiringValidation: [],
      prohibitedOutputElements: [],
      checksumSha256: sha(bytes),
      sizeBytes: bytes.byteLength,
      widthPx: 380,
      heightPx: 676,
      usageClass: 'STORYBOARD_INTERNAL_REVIEW_ONLY',
      outputEligibleForPublicRelease: false,
      internalReviewMotionProofAuthorised: true,
    });
  }

  await writeFile(
    join(storyboardRoot, 'storyboard-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: '2.0.0',
        storyboardId: 'combat-reviews-flagship-storyboard-02',
        campaign: 'combat-reviews-flagship-02',
        objective: 'synthetic acceptance fixture',
        durationSeconds: 15,
        creativeTerritory: 'Never miss fight night.',
        CTA: 'EXPLORE EVENTS',
        sourceImage: { packagedPath: 'sheet.png', originalPath: 'synthetic://sheet.png' },
        sourceChecksum: { algorithm: 'SHA256', original: sha(sheet), copy: sha(sheet) },
        usageClass: 'STORYBOARD_INTERNAL_REVIEW_ONLY',
        outputEligibleForPublicRelease: false,
        internalReviewMotionProofAuthorised: true,
        licensedForPublicProduction: false,
        isPublicReleaseReady: false,
        rightsStatement: 'internal review only',
        referenceRule: 'panels may be animated for internal review only',
        productAssetsRule: 'every phone screen is concept UI',
        frames,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // --- the hand-animated clips, and one preview that must never render ------
  for (const sceneNumber of MANUAL_SCENES) {
    // eslint-disable-next-line no-await-in-loop -- fixture construction
    await makeClipFromKeyframe(
      join(framesDirectory, `FRAME-${String(sceneNumber).padStart(2, '0')}.png`),
      join(manualClipsDirectory, `FRAME-${String(sceneNumber).padStart(2, '0')}.mp4`),
      6,
    );
  }

  // --- the acquired production plate ----------------------------------------
  const platePath = join(footagePackRoot, 'approved-free-originals', 'plate-boxing-01.mp4');
  await makeAcquiredPlate(platePath, 8);
  const plateBytes = await readFile(platePath);
  const plateProbe = JSON.parse(
    (
      await runner.run(
        binaries.ffprobe,
        [
          '-v',
          'error',
          '-show_entries',
          'stream=width,height,avg_frame_rate,codec_name:format=duration',
          '-of',
          'json',
          platePath,
        ],
        { timeoutMs: 60_000 },
      )
    ).stdout,
  ) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };

  await writeFile(
    join(footagePackRoot, 'acquisition-evidence', 'plate-boxing-01.json'),
    `${JSON.stringify(
      {
        asset_id: 'plate-boxing-01',
        role: 'BOXING_ACTION',
        provider: 'SYNTHETIC_FIXTURE',
        source_page: 'synthetic://fixture/plate-boxing-01',
        creator: 'AAMP acceptance fixture',
        licence: 'CC0',
        local_path: platePath,
        sha256: sha(plateBytes),
        size_bytes: plateBytes.byteLength,
        authorised_download_url_persisted: false,
        visual_review_score: 9,
        watermark_present: false,
        technical: {
          width: plateProbe.streams?.[0]?.width ?? 2160,
          height: plateProbe.streams?.[0]?.height ?? 3840,
          frame_rate: 24,
          video_codec: 'h264',
          duration_s: Number(plateProbe.format?.duration ?? 8),
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  // A contact sheet in a refused directory: it must never become production media.
  await copyFile(platePath, join(footagePackRoot, 'candidates', 'contact-sheet-preview.mp4'));

  // --- the work pack: the logo and the temporary audio the plan binds --------
  const logoPath = join(workPackRoot, 'asset-root', 'logo-primary.png');
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=white:size=600x600:duration=1',
    '-frames:v',
    '1',
    '-y',
    logoPath,
  ]);
  const audio: { id: string; file: string; frequency: number; seconds: number }[] = [
    { id: 'music-bed', file: 'music-bed.m4a', frequency: 220, seconds: 20 },
    { id: 'sfx-fight-bell', file: 'sfx-fight-bell.m4a', frequency: 880, seconds: 2 },
    { id: 'sfx-crowd', file: 'sfx-crowd.m4a', frequency: 320, seconds: 3 },
    { id: 'sfx-impact', file: 'sfx-impact.m4a', frequency: 110, seconds: 2 },
    { id: 'sfx-ui-click', file: 'sfx-ui-click.m4a', frequency: 1200, seconds: 1 },
    {
      id: 'sfx-confirmation-pulse',
      file: 'sfx-confirmation-pulse.m4a',
      frequency: 660,
      seconds: 2,
    },
    { id: 'sfx-cta-emphasis', file: 'sfx-cta-emphasis.m4a', frequency: 440, seconds: 3 },
  ];
  for (const cue of audio) {
    // eslint-disable-next-line no-await-in-loop -- fixture construction
    await makeTone(join(workPackRoot, 'asset-root', cue.file), cue.frequency, cue.seconds);
  }

  const rights = {
    classification: 'OWNED' as const,
    owner: 'Combat Reviews',
    permittedOutputUse: true,
    restrictions: ['TEMPORARY — synthetic acceptance fixture, never for publication'],
  };
  await writeFile(
    join(workPackRoot, 'asset-root', 'assets.json'),
    `${JSON.stringify(
      {
        manifestVersion: 1,
        library: 'Combat Reviews acceptance fixture library (temporary audio)',
        assets: [
          {
            id: 'logo-primary',
            path: './logo-primary.png',
            kind: 'IMAGE',
            role: 'LOGO',
            description: 'Synthetic brand mark for the acceptance fixture',
            rights,
            beats: [],
            tags: [],
          },
          ...audio.map((cue) => ({
            id: cue.id,
            path: `./${cue.file}`,
            kind: 'AUDIO' as const,
            role: 'MUSIC' as const,
            description: `Synthetic ${cue.id} tone — temporary, never for publication`,
            rights,
            beats: [],
            tags: [],
          })),
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // --- what the fake LTX server will serve for scenes 5, 8 and 9 ------------
  generatedClipBytes = new Map();
  for (const sceneNumber of GENERATED_SCENES) {
    const target = join(workspace, `generated-scene-${sceneNumber}.mp4`);
    // eslint-disable-next-line no-await-in-loop -- fixture construction
    await makeClipFromKeyframe(
      join(framesDirectory, `FRAME-${String(sceneNumber).padStart(2, '0')}.png`),
      target,
      6,
    );
    // eslint-disable-next-line no-await-in-loop -- fixture construction
    generatedClipBytes.set(sceneNumber, await readFile(target));
  }

  // The replacement for scene 8: a different clip, still honestly animated
  // from scene 8's own approved plate, so the only thing that changed is the
  // bytes — which is exactly what has to invalidate the earlier decision.
  const replacementPath = join(workspace, 'generated-scene-8-take-2.mp4');
  await makeClipFromKeyframe(join(framesDirectory, 'FRAME-08.png'), replacementPath, 7);
  replacementClipBytes = await readFile(replacementPath);
}, 600_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

function fakeProvider(server: FakeLtxServer, outputDirectory: string) {
  return new LtxHostedVideoGenerationProvider({
    apiKey: API_KEY,
    model: 'ltx-2-3-fast',
    baseUrl: 'https://api.ltx.io',
    outputTimeoutMs: 60_000,
    outputDirectory,
    fetchImpl: server.fetch,
    hostAllowance: { additionalTransferHostSuffixes: [server.transferHost] },
  });
}

/**
 * The bytes each generated scene receives, keyed by submission order.
 *
 * Scenes generate in ascending order, so job-1 is scene 5, job-2 scene 8 and
 * job-3 scene 9.
 */
function jobScripts(sceneEight: Uint8Array): Record<string, { videoBytes: Uint8Array }> {
  return {
    'job-1': { videoBytes: generatedClipBytes.get(5) as Uint8Array },
    'job-2': { videoBytes: sceneEight },
    'job-3': { videoBytes: generatedClipBytes.get(9) as Uint8Array },
  };
}

let runCounter = 0;
async function runOnce(
  options: { sceneEightBytes?: Uint8Array; regenerateScenes?: number[] } = {},
): Promise<StoryboardVideoResult & { server: FakeLtxServer }> {
  runCounter += 1;
  const outputDirectory = join(workspace, `run-${runCounter}`);
  const server = new FakeLtxServer({
    jobs: jobScripts(options.sceneEightBytes ?? (generatedClipBytes.get(8) as Uint8Array)),
  });
  const result = await runStoryboardVideo({
    storyboardRoot,
    framesDirectory,
    outputDirectory,
    workPackRoot,
    campaignDirectory,
    footagePackRoot,
    preGeneratedClipsDirectory: manualClipsDirectory,
    reviewDirectory,
    model: 'ltx-2-3-fast',
    maxCostCents: 500,
    dryRun: false,
    generateAudio: false,
    reuseGenerated: true,
    regenerateScenes: new Set(options.regenerateScenes ?? []),
    binaries,
    workflowRunId: `acceptance-${runCounter}`,
    now: new Date('2026-07-29T12:00:00.000Z'),
    runner,
    // The injection seam. No key is read and no third party is contacted.
    providerOverride: fakeProvider(server, join(outputDirectory, 'provider-out')),
    pollIntervalMs: 0,
    sleep: async () => undefined,
  });
  return { ...result, server };
}

async function review(
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runMotionReviewCli(
    [
      ...argv,
      '--storyboard',
      storyboardRoot,
      '--frames-dir',
      framesDirectory,
      '--work-pack',
      workPackRoot,
      '--footage-pack',
      footagePackRoot,
      '--pre-generated-clips-dir',
      manualClipsDirectory,
      '--campaign-dir',
      campaignDirectory,
      '--review-dir',
      reviewDirectory,
    ],
    {
      cwd: workspace,
      // Deliberately empty except for the FFmpeg locations: nothing on this
      // path may read a credential, and the environment does not carry one.
      env: {
        ...(process.env.FFMPEG_PATH ? { FFMPEG_PATH: process.env.FFMPEG_PATH } : {}),
        ...(process.env.FFPROBE_PATH ? { FFPROBE_PATH: process.env.FFPROBE_PATH } : {}),
      },
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      now: new Date('2026-07-29T13:00:00.000Z'),
    },
  );
  return { code, out, err };
}

async function approve(sceneNumber: number, feedback: string, findings: readonly string[] = []) {
  return review([
    'approve',
    '--scene',
    String(sceneNumber),
    '--reviewer',
    REVIEWER,
    '--feedback',
    feedback,
    ...findings.flatMap((finding) => ['--acknowledge', finding]),
  ]);
}

const GOOD = 'the clip opens on the approved plate and the move is the one the scene asks for';

suite('storyboard motion quality gate — the complete path, no paid call', () => {
  it('resolves a source for all ten scenes and classifies each one honestly', async () => {
    // A first run generates the three missing scenes and publishes them into
    // the review directory. It blocks at the gate, having composited nothing.
    const first = await runOnce();
    expect(first.failureKind).toBe('MOTION_REVIEW_BLOCKED');
    expect(first.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.MOTION_REVIEW_BLOCKED);
    expect(first.outputPath).toBeUndefined();

    const status = await review(['status', '--json']);
    expect(status.code).toBe(0);
    const report = JSON.parse(status.out) as {
      manualClipScenes: number[];
      acquiredFootageScenes: number[];
      deterministicGraphicsScenes: number[];
      scenesRequiringGeneration: number[];
      rows: { sceneNumber: number; sourceType: string }[];
      paidProviderCalls: number;
      readyToRender: boolean;
    };

    expect(report.rows).toHaveLength(10);
    expect(report.manualClipScenes).toEqual(MANUAL_SCENES);
    expect(report.acquiredFootageScenes).toEqual([ACQUIRED_SCENE]);
    expect(report.deterministicGraphicsScenes).toEqual(DETERMINISTIC_SCENES);
    expect(report.scenesRequiringGeneration).toEqual(GENERATED_SCENES);
    expect(report.paidProviderCalls).toBe(0);
    expect(report.readyToRender).toBe(false);
  }, 600_000);

  it('never contacts a provider from the review command, whatever the subcommand', async () => {
    const before = await review(['ledger', '--json']);
    expect(before.code).toBe(0);
    // The review command is handed an environment with no key at all, and it
    // completes: nothing on this path can want one.
    const inspect = await review(['inspect', '--json']);
    expect(inspect.code).toBe(0);
    const parsed = JSON.parse(inspect.out) as { scenes: { sceneNumber: number }[] };
    // The three manual/acquired scenes plus the three generated ones.
    expect(parsed.scenes.map((scene) => scene.sceneNumber)).toEqual([1, 2, 5, 7, 8, 9]);
  }, 300_000);

  it('writes a gallery holding the keyframe beside five frames from every moving clip', async () => {
    await review(['inspect']);
    const html = await readFile(join(reviewDirectory, MOTION_REVIEW_GALLERY_FILENAME), 'utf8');
    for (const label of [
      'FIRST',
      'QUARTER',
      'MIDPOINT',
      'THREE_QUARTER',
      'FINAL',
      'AUTHORITATIVE',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Prompt as submitted');
    // Nothing has been decided yet, and the page says so rather than leaving
    // the absence of a decision to be inferred from an empty space.
    expect(html).toContain('No decision has ever been recorded for this scene.');
    // No script and no network request: the page opens with nothing running.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    const frames = await readdir(join(reviewDirectory, 'frames'));
    expect(frames.filter((name) => name.endsWith('-first.png'))).toHaveLength(6);
    expect(frames.filter((name) => name.endsWith('-authoritative-keyframe.png'))).toHaveLength(6);
  }, 300_000);

  it('refuses an approval that does not name an open fidelity finding', async () => {
    // The acquired plate is a real 2160x3840 original but it was never
    // animated from a keyframe, so its keyframe check is not applicable and it
    // has no open finding — it approves cleanly.
    const clean = await approve(ACQUIRED_SCENE, GOOD);
    expect(clean.code).toBe(0);
  }, 300_000);

  it('blocks the render while any moving scene is unreviewed, before FFmpeg starts', async () => {
    const result = await runOnce();
    expect(result.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.MOTION_REVIEW_BLOCKED);
    expect(result.failureKind).toBe('MOTION_REVIEW_BLOCKED');
    expect(result.failure).toMatch(/No FFmpeg composition has started/);
    expect(result.motionGate?.clears).toBe(false);
    expect(result.outputPath).toBeUndefined();
    await expect(stat(join(result.runDirectory, 'render-manifest.json'))).rejects.toThrow();
  }, 600_000);

  it("blocks on exactly one rejected scene, naming it and the reviewer's own words", async () => {
    const rejection =
      'the push overshoots and the plate drifts off the protected right third by 0.6s; hold the move at 60% and re-seat the frame';
    for (const sceneNumber of [1, 5, 7, 9]) {
      // eslint-disable-next-line no-await-in-loop -- decisions are recorded in order
      const outcome = await approve(sceneNumber, GOOD);
      expect(outcome.code).toBe(0);
    }
    const rejected = await review([
      'reject',
      '--scene',
      '8',
      '--reviewer',
      REVIEWER,
      '--feedback',
      rejection,
    ]);
    expect(rejected.code).toBe(0);

    const result = await runOnce();
    expect(result.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.MOTION_REVIEW_BLOCKED);
    expect(result.motionGate?.blockingScenes).toEqual([8]);
    const row = result.motionGate?.rows.find((candidate) => candidate.sceneNumber === 8);
    expect(row?.status).toBe('REJECTED');
    expect(row?.remedy).toContain(rejection);
    expect(result.outputPath).toBeUndefined();
  }, 900_000);

  it('invalidates the old decision when the scene is replaced, and names what moved', async () => {
    // A regeneration that produces different bytes. Everything else about
    // scene 8 — its keyframe, its prompt, its contract — is unchanged.
    const replaced = await runOnce({
      sceneEightBytes: replacementClipBytes,
      regenerateScenes: [8],
    });
    expect(replaced.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.MOTION_REVIEW_BLOCKED);
    const row = replaced.motionGate?.rows.find((candidate) => candidate.sceneNumber === 8);
    // The rejection was about the old clip. It no longer applies to this one,
    // and the scene is unreviewed rather than silently still rejected.
    expect(row?.status).toBe('NOT_REVIEWED');

    // Every other scene's approval survived: a selective regeneration left
    // their bytes alone.
    for (const sceneNumber of [1, 2, 5, 7, 9]) {
      expect(
        replaced.motionGate?.rows.find((candidate) => candidate.sceneNumber === sceneNumber)
          ?.status,
      ).toBe('APPROVED');
    }
  }, 900_000);

  it('unblocks once the replacement is approved, and renders a real 15-second master', async () => {
    const approved = await approve(
      8,
      'the replacement holds the protected right third for the whole beat and settles before the cut',
    );
    expect(approved.code).toBe(0);

    const result = await runOnce({ sceneEightBytes: replacementClipBytes });
    expect(result.failure).toBeUndefined();
    expect(result.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.SUCCESS);
    expect(result.motionGate?.clears).toBe(true);
    expect(result.outputPath).toBeDefined();
    expect(result.qaVerdict).toBe('PASS');

    // Measured from the produced file, never from the manifest.
    const probe = JSON.parse(
      (
        await runner.run(
          binaries.ffprobe,
          [
            '-v',
            'error',
            '-show_entries',
            'stream=codec_type,codec_name,width,height,pix_fmt:format=duration',
            '-of',
            'json',
            result.outputPath as string,
          ],
          { timeoutMs: 60_000 },
        )
      ).stdout,
    ) as {
      streams?: {
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        pix_fmt?: string;
      }[];
      format?: { duration?: string };
    };
    const video = probe.streams?.find((stream) => stream.codec_type === 'video');
    const audioStream = probe.streams?.find((stream) => stream.codec_type === 'audio');
    expect(video?.width).toBe(1080);
    expect(video?.height).toBe(1920);
    expect(video?.codec_name).toBe('h264');
    expect(video?.pix_fmt).toBe('yuv420p');
    expect(audioStream?.codec_name).toBe('aac');
    expect(Number(probe.format?.duration)).toBeCloseTo(15, 2);

    // Provenance names every source and the decision that cleared it.
    const provenance = JSON.parse(
      await readFile(join(result.runDirectory, 'provenance.json'), 'utf8'),
    ) as {
      sceneProvenance: {
        sceneNumber: number;
        sourceType: string;
        motionReviewStatus: string;
        motionApprovedBy: string | null;
        sourceClipChecksumSha256: string | null;
      }[];
      motionGate: { clears: boolean };
      paidProviderCalls: number;
    };
    expect(provenance.sceneProvenance).toHaveLength(10);
    expect(provenance.motionGate.clears).toBe(true);
    for (const sceneNumber of [...MANUAL_SCENES, ACQUIRED_SCENE, ...GENERATED_SCENES]) {
      const scene = provenance.sceneProvenance.find(
        (candidate) => candidate.sceneNumber === sceneNumber,
      );
      expect(scene?.motionReviewStatus).toBe('APPROVED');
      expect(scene?.motionApprovedBy).toBe(REVIEWER);
      expect(scene?.sourceClipChecksumSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const sceneNumber of DETERMINISTIC_SCENES) {
      expect(
        provenance.sceneProvenance.find((candidate) => candidate.sceneNumber === sceneNumber)
          ?.motionReviewStatus,
      ).toBe('NOT_REVIEWABLE');
    }

    // Reference and preview material never reaches the thing that renders.
    // Asserted on the same run that produced the master rather than on a
    // second one, so it is a statement about this file.
    const manifest = await readFile(join(result.runDirectory, 'render-manifest.json'), 'utf8');
    expect(manifest).not.toContain('contact-sheet-preview');
    expect(manifest).not.toContain('candidates');
    expect(manifest).not.toContain(API_KEY);
  }, 900_000);

  it('puts no credential and no signed URL in any artefact it writes', async () => {
    const files = await readdir(reviewDirectory, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile()) continue;
      // eslint-disable-next-line no-await-in-loop -- a handful of files
      const text = await readFile(join(reviewDirectory, entry.name), 'utf8');
      expect(text).not.toContain(API_KEY);
      expect(text).not.toMatch(/[?&](?:signature|sig|token|key|credential)=/i);
      expect(text).not.toMatch(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/);
    }
  }, 120_000);

  it('keeps every decision ever recorded, including the one that was superseded', async () => {
    const ledger = await MotionReviewLedger.open(reviewDirectory);
    const sceneEight = ledger.forScene(8);
    expect(sceneEight.length).toBeGreaterThanOrEqual(2);
    expect(sceneEight[0]?.verdict).toBe('REJECTED');
    expect(sceneEight[sceneEight.length - 1]?.verdict).toBe('APPROVED');
    // The two judgements are about different clips, which is why both stand.
    expect(sceneEight[0]?.identity.clipChecksumSha256).not.toBe(
      sceneEight[sceneEight.length - 1]?.identity.clipChecksumSha256,
    );
    for (const decision of ledger.all) {
      expect(decision.reviewer).toBe(REVIEWER);
      expect(decision.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(decision.identitySha256).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 120_000);
});

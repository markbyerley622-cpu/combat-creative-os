import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NodeCommandRunner, probeMedia, resolveFfmpegBinaries } from '@combat/media';

import { runFlagshipCli } from './flagship-cli';
import { EXIT_CODES } from '../run-source-campaign';

/**
 * The flagship command, end to end, against fixtures this repository owns.
 *
 * The environment is deliberately hostile to the claim being tested:
 * `REASONING_PROVIDER=claude` is set with **no API key**, a configuration in
 * which a normal campaign run exits 3. This one must succeed, which is only
 * possible if no reasoning provider is constructed at all — a stronger proof
 * than counting calls on a spy, because there is nothing to call.
 *
 * Everything the test needs it builds: a storyboard package, an asset library
 * of `lavfi`-generated media, and a plan bound to both. It never reads the
 * operator's Desktop and never contacts a network. It needs a real FFmpeg and
 * skips loudly without one, which is the normal outcome under `pnpm test` on a
 * machine with no toolchain.
 */

const binaries = resolveFfmpegBinaries(process.env);
const runner = new NodeCommandRunner();

function ffmpegAvailable(): boolean {
  return (
    spawnSync(binaries.ffprobe, ['-version'], { timeout: 15_000 }).status === 0 &&
    spawnSync(binaries.ffmpeg, ['-version'], { timeout: 15_000 }).status === 0
  );
}

const suite = ffmpegAvailable() ? describe : describe.skip;

if (!ffmpegAvailable()) {
  // eslint-disable-next-line no-console -- a skipped acceptance test must say why
  console.warn(
    '[flagship-acceptance] SKIPPED: no FFmpeg/ffprobe on PATH (set FFMPEG_PATH / FFPROBE_PATH). This suite proves a real 1080x1920 master; it is not being proven here.',
  );
}

const SLOTS: readonly [number, number][] = [
  [0, 1.2],
  [1.2, 2.5],
  [2.5, 4.5],
  [4.5, 6],
  [6, 8.5],
  [8.5, 10.5],
  [10.5, 12.7],
  [12.7, 15],
];

const WORKSPACE_ID = '6f1d5f6c-6d3a-4a2e-9c5f-0f2a1b3c4d5e';
const CAMPAIGN_ID = 'c4a7e1d2-3b58-4f6a-9e21-7d05c8b3f419';

const PROMPT = [
  'Fixture flagship brief.',
  '',
  'Show the product, say nothing it cannot back, end on a call to action that is true.',
].join('\n');

const PROMPT_SHA256 = createHash('sha256').update(PROMPT.trim(), 'utf8').digest('hex');

let root: string;
let storyboardRoot: string;
let workPackRoot: string;
let campaignDirectory: string;
let outputDirectory: string;

async function ffmpeg(args: readonly string[]): Promise<void> {
  const result = await runner.run(binaries.ffmpeg, ['-nostdin', '-v', 'error', ...args], {
    timeoutMs: 180_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`fixture media generation failed: ${result.stderr.slice(-500)}`);
  }
}

/** Six seconds of moving, non-blank vertical footage with a distinct hue. */
async function makeClip(target: string, hue: number): Promise<void> {
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1080x1920:rate=30:duration=6,hue=h=${hue}`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=6:sample_rate=48000',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    target,
  ]);
}

async function makeStill(target: string, colour: string): Promise<void> {
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1080x1920:rate=1:duration=1,hue=h=${colour}`,
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
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
    '-ac',
    '2',
    '-y',
    target,
  ]);
}

suite('the flagship command, end to end', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'aamp-flagship-e2e-'));
    storyboardRoot = join(root, 'storyboard');
    workPackRoot = join(root, 'work-pack');
    campaignDirectory = join(root, 'campaign');
    outputDirectory = join(root, 'out');

    // ---- the storyboard package -------------------------------------------
    await mkdir(join(storyboardRoot, 'frames'), { recursive: true });
    const checksumLines = ['Fixture storyboard integrity record', ''];
    for (const [index] of SLOTS.entries()) {
      const bytes = Buffer.from(
        `FRAME-0${index + 1} fixture panel ${'y'.repeat(index * 5)}`,
        'utf8',
      );
      // eslint-disable-next-line no-await-in-loop -- deterministic fixture order
      await writeFile(join(storyboardRoot, 'frames', `FRAME-0${index + 1}.png`), bytes);
      checksumLines.push(
        `FRAME-0${index + 1}.png  ${bytes.byteLength}  ${createHash('sha256').update(bytes).digest('hex')}`,
      );
    }
    const sheet = Buffer.from('fixture contact sheet bytes', 'utf8');
    await writeFile(join(storyboardRoot, 'sheet.jpeg'), sheet);
    await writeFile(
      join(storyboardRoot, 'source-checksum.txt'),
      `${checksumLines.join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      join(storyboardRoot, 'storyboard-manifest.json'),
      `${JSON.stringify(
        {
          schemaVersion: '1.0.0',
          storyboardId: 'combat-reviews-flagship-storyboard-01',
          campaign: 'Fixture flagship advertisement',
          objective: 'Prove the flagship chain',
          durationSeconds: 15,
          creativeTerritory: 'Watching is only the beginning.',
          sourceImage: { packagedPath: 'sheet.jpeg' },
          sourceChecksum: {
            algorithm: 'SHA256',
            copy: createHash('sha256').update(sheet).digest('hex'),
          },
          usageClass: 'REFERENCE_ONLY',
          outputEligible: false,
          referenceRule: 'Every storyboard frame is REFERENCE_ONLY.',
          productAssetsRule: 'Production must use real captures.',
          frames: SLOTS.map(([startSeconds, endSeconds], index) => ({
            frameId: `FRAME-0${index + 1}`,
            sequence: index + 1,
            sourceFramePath: `frames/FRAME-0${index + 1}.png`,
            startSeconds,
            endSeconds,
            purpose: `Fixture purpose ${index + 1}`,
            visibleIntent: `Fixture intent ${index + 1}`,
            requiredProductionRole: `Fixture role ${index + 1}`,
            requiredAssetTypes: ['fixture asset'],
            productFeature: `Fixture feature ${index + 1}`,
            onScreenCopyIntent: [],
            factualClaimsRequiringValidation: [],
            prohibitedOutputElements: [],
            referenceOnly: true,
            outputEligible: false,
          })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    // ---- the asset library -------------------------------------------------
    const assetRoot = join(workPackRoot, 'asset-root');
    await mkdir(join(assetRoot, 'clips'), { recursive: true });
    await mkdir(join(assetRoot, 'ui'), { recursive: true });
    await mkdir(join(assetRoot, 'audio'), { recursive: true });

    await makeClip(join(assetRoot, 'clips', 'a.mp4'), 0);
    await makeClip(join(assetRoot, 'clips', 'b.mp4'), 90);
    await makeClip(join(assetRoot, 'clips', 'c.mp4'), 180);
    await makeStill(join(assetRoot, 'ui', 'events.png'), '30');
    await makeStill(join(assetRoot, 'ui', 'card.png'), '60');
    await makeStill(join(assetRoot, 'ui', 'board.png'), '120');
    await makeStill(join(assetRoot, 'ui', 'brand-card.png'), '200');
    await makeStill(join(assetRoot, 'ui', 'logo.png'), '260');
    await makeTone(join(assetRoot, 'audio', 'music.wav'), 180, 20);
    await makeTone(join(assetRoot, 'audio', 'cue.wav'), 900, 1);

    const owned = {
      classification: 'OWNED' as const,
      owner: 'Combat Reviews',
      permittedOutputUse: true,
      restrictions: ['Approved channel: INTERNAL_REVIEW only'],
    };
    const temporaryAudio = {
      classification: 'OWNED' as const,
      owner: 'Combat Reviews',
      permittedOutputUse: true,
      restrictions: ['TEMPORARY zero-cost synthetic audio generated from FFmpeg lavfi sources'],
    };

    await writeFile(
      join(assetRoot, 'assets.json'),
      `${JSON.stringify(
        {
          manifestVersion: 1,
          library: 'Flagship acceptance fixture library',
          assets: [
            {
              id: 'logo-primary',
              path: './ui/logo.png',
              kind: 'IMAGE',
              role: 'LOGO',
              description: 'the mark',
              rights: owned,
              beats: [],
              tags: [],
            },
            {
              id: 'brand-card',
              path: './ui/brand-card.png',
              kind: 'IMAGE',
              role: 'BRAND_CARD',
              description: 'end card',
              rights: owned,
              beats: ['CTA'],
              tags: [],
            },
            {
              id: 'screen-events',
              path: './ui/events.png',
              kind: 'IMAGE',
              role: 'APP_SCREENSHOT',
              description: 'events screen',
              rights: owned,
              beats: ['EVENT_DETAIL'],
              tags: [],
            },
            {
              id: 'screen-fight-card',
              path: './ui/card.png',
              kind: 'IMAGE',
              role: 'APP_SCREENSHOT',
              description: 'fight card',
              rights: owned,
              beats: ['PREDICTION'],
              tags: [],
            },
            {
              id: 'screen-predictions',
              path: './ui/board.png',
              kind: 'IMAGE',
              role: 'APP_SCREENSHOT',
              description: 'leaderboard',
              rights: owned,
              beats: ['DISCUSSION'],
              tags: [],
            },
            {
              id: 'clip-a',
              path: './clips/a.mp4',
              kind: 'VIDEO',
              role: 'SOURCE_CLIP',
              description: 'hook plate',
              rights: owned,
              beats: ['HOOK'],
              tags: [],
            },
            {
              id: 'clip-b',
              path: './clips/b.mp4',
              kind: 'VIDEO',
              role: 'SOURCE_CLIP',
              description: 'breadth plate',
              rights: owned,
              beats: ['INFORMATION'],
              tags: [],
            },
            {
              id: 'clip-c',
              path: './clips/c.mp4',
              kind: 'VIDEO',
              role: 'SOURCE_CLIP',
              description: 'impact plate',
              rights: owned,
              beats: ['PREDICTION'],
              tags: [],
            },
            {
              id: 'music-bed',
              path: './audio/music.wav',
              kind: 'AUDIO',
              role: 'MUSIC',
              description: 'TEMPORARY synthetic bed',
              rights: temporaryAudio,
              beats: [],
              tags: [],
            },
            {
              id: 'sfx-impact',
              path: './audio/cue.wav',
              kind: 'AUDIO',
              role: 'MUSIC',
              description: 'TEMPORARY synthetic cue',
              rights: temporaryAudio,
              beats: [],
              tags: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    // ---- the committed campaign source ------------------------------------
    await mkdir(campaignDirectory, { recursive: true });
    await writeFile(join(campaignDirectory, 'campaign-prompt.txt'), `${PROMPT}\n`, 'utf8');
    await writeFile(
      join(campaignDirectory, 'request.template.json'),
      `${JSON.stringify(
        {
          requestVersion: 1,
          name: 'flagship-acceptance',
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          brandName: 'Combat Reviews',
          promptFile: './campaign-prompt.txt',
          objective: 'Prove the flagship chain end to end',
          targetAudience: 'Combat sports fans',
          platform: 'TIKTOK',
          targetDurationSeconds: 15,
          productFacts: [{ id: 'coverage', label: 'Coverage', detail: 'Events in one place.' }],
          eventFacts: [],
          keyMessages: ['Every card that matters, in one place'],
          mandatories: ['End on the call to action'],
          cta: {
            headline: 'NEVER MISS FIGHT NIGHT.',
            subline: 'OPEN COMBAT REVIEWS · Every combat sport. One place.',
            durationSeconds: 2.3,
          },
          brandKit: {
            logoAssetId: 'logo-primary',
            primaryColorHex: '#08080C',
            accentColorHex: '#DA0318',
            captionFontFamily: 'Arial',
            safeAreaTopPx: 220,
            safeAreaBottomPx: 420,
          },
          generation: { source: 'SOURCE_ONLY', generatedShotCount: 0 },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const beatSpec = [
      { id: 'hook', role: 'HOOK', asset: 'clip-a', motion: 'PUSH_IN', grade: 'BRAND_NOIR' },
      {
        id: 'breadth',
        role: 'INFORMATION',
        asset: 'clip-b',
        motion: 'PUSH_IN',
        grade: 'BRAND_EMBER',
      },
      { id: 'product', role: 'EVENT_DETAIL', asset: 'screen-events', motion: 'FRAMED_PHONE_UI' },
      {
        id: 'impact',
        role: 'PREDICTION',
        asset: 'clip-c',
        motion: 'PUSH_IN',
        grade: 'BRAND_EMBER',
      },
      {
        id: 'prediction',
        role: 'PREDICTION',
        asset: 'screen-fight-card',
        motion: 'APP_SCREENSHOT_PARALLAX',
      },
      {
        id: 'rank',
        role: 'DISCUSSION',
        asset: 'screen-predictions',
        motion: 'APP_SCREENSHOT_PARALLAX',
      },
      {
        id: 'discussion',
        role: 'DISCUSSION',
        asset: 'product-mockup-discussion',
        motion: 'FRAMED_PHONE_UI',
      },
      { id: 'cta', role: 'CTA', asset: 'brand-card', motion: 'STATIC_HOLD' },
    ] as const;
    const transitions = [0, 0.2, 0.3, 0.2, 0.3, 0.3, 0.3, 0.4];

    await writeFile(
      join(campaignDirectory, 'creative-plan.json'),
      `${JSON.stringify(
        {
          planVersion: 1,
          workspaceId: WORKSPACE_ID,
          campaignId: CAMPAIGN_ID,
          authoredBy: 'Flagship acceptance fixture author',
          authoredAt: '2026-07-28T00:00:00.000Z',
          campaignPromptSha256: PROMPT_SHA256,
          targetDurationSeconds: 15,
          strategy: {
            audienceName: 'Combat sports fans',
            painPoints: ['Cards are scattered'],
            positioning: 'One place for the whole sport.',
            targetAudienceSummary: 'Combat sports fans',
            keyMessages: ['Every card that matters, in one place'],
            toneGuidelines: ['Certain, never shouty'],
          },
          creativeDirection: {
            logline: 'Tension, proof, resolve.',
            visualDirection:
              'Black base, one saturated red, product held still long enough to read.',
            narrativeArc: 'Tension, breadth, product, impact, prediction, rank, discussion, CTA.',
            referenceNotes: [],
          },
          hook: {
            strategy: 'Open on the tension rather than the product.',
            latencySeconds: 0.4,
            onScreenLine: 'YOU MISSED IT AGAIN.',
          },
          beats: beatSpec.map((beat, index) => ({
            id: beat.id,
            index,
            role: beat.role,
            description: `Fixture beat ${index + 1}.`,
            durationSeconds: Number(
              (
                (SLOTS[index] as [number, number])[1] -
                (SLOTS[index] as [number, number])[0] +
                (transitions[index] as number)
              ).toFixed(6),
            ),
            source: { assetId: beat.asset, requiredTags: [] },
            motion: { treatment: beat.motion, intensity: 0.4 },
            ...('grade' in beat && beat.grade
              ? { grade: { key: beat.grade, intensity: 0.5 } }
              : {}),
            ...(index === 0
              ? {}
              : { transitionIn: { kind: 'CROSSFADE', durationSeconds: transitions[index] } }),
            ...(index === beatSpec.length - 1
              ? {}
              : { caption: { text: `FIXTURE LINE ${index + 1}`, entrance: 'RISE' } }),
            decorations: [],
            audioCues:
              index === 0
                ? [{ role: 'IMPACT', atOffsetSeconds: 0, gainDb: -6, ducksMusic: true }]
                : [],
            useSourceAudio: false,
          })),
          cta: {
            headline: 'NEVER MISS FIGHT NIGHT.',
            subline: 'OPEN COMBAT REVIEWS · Every combat sport. One place.',
            durationSeconds: 2.3,
            holdSeconds: 1.7,
            entrance: 'RISE_AND_SCALE',
          },
          audio: {
            musicAssetId: 'music-bed',
            musicGainDb: -9,
            sourceAudioGainDb: -18,
            cueDuckingDb: 7,
            musicCrossfadeSeconds: 0.25,
            peakCeilingDbtp: -1.5,
            targetLufs: -14,
            cueAssetIds: { IMPACT: 'sfx-impact' },
          },
          factualConstraints: ['PRODUCT — Coverage: events in one place.'],
          brandConstraints: {
            logoAssetId: 'logo-primary',
            primaryColorHex: '#08080C',
            accentColorHex: '#DA0318',
            captionFontFamily: 'Arial',
            safeAreaTopPx: 220,
            safeAreaBottomPx: 420,
            logoWindows: [{ startSeconds: 0, endSeconds: 2.5 }],
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await writeFile(
      join(campaignDirectory, 'asset-substitutions.json'),
      `${JSON.stringify(
        {
          substitutions: [
            {
              beatId: 'discussion',
              requiredAsset: 'A real discussion capture',
              substitutionReason: 'The live discussion screen is unavailable to the capture path.',
              factualLimitations: ['The mockup is not a capture'],
              unresolvedGap: 'A real discussion capture does not exist',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const treatmentBeats = beatSpec.map((beat, index) => ({
      beatId: beat.id,
      storyboardFrameId: `FRAME-0${index + 1}`,
      requiredAsset: `Fixture requirement ${index + 1}`,
      feasibility: beat.asset === 'product-mockup-discussion' ? 'SUBSTITUTED' : 'AS_STORYBOARDED',
      note: `Fixture feasibility note for beat ${index + 1}, stated in full.`,
    }));

    await writeFile(
      join(campaignDirectory, 'production-treatment.json'),
      `${JSON.stringify(
        {
          treatmentVersion: 1,
          campaignId: CAMPAIGN_ID,
          storyboardId: 'combat-reviews-flagship-storyboard-01',
          approvedBy: 'Flagship acceptance fixture reviewer',
          approvedAt: '2026-07-28T00:00:00.000Z',
          strategicIdea: 'One place for the whole of combat sports.',
          audienceTension: 'Fans are permanently half-informed about what is on.',
          productMechanism: 'Four real screens in escalating order of commitment.',
          emotionalProgression: ['recognition', 'appetite', 'relief', 'resolve'],
          cameraGrammar: 'Footage moves; product is composited and held still.',
          lightingAndColourGrammar: 'Black base, one accent, product screens ungraded.',
          motionGrammar: 'Movement decelerates into every product beat.',
          transitionGrammar: beatSpec.slice(1).map((beat, index) => ({
            fromBeatId: (beatSpec[index] as (typeof beatSpec)[number]).id,
            toBeatId: beat.id,
            family: 'GRAPHIC_MATCH',
            motivation: `Fixture motivation for the cut into ${beat.id}, stated in full.`,
          })),
          typographyGrammar: 'One uppercase display voice inside the bottom safe area.',
          audioCueSheet: [
            'OPENING_NOTIFICATION',
            'BREADTH_ACCELERATION',
            'PRODUCT_REVEAL',
            'FIGHT_IMPACT',
            'PREDICTION_CONFIRMATION',
            'SOCIAL_REACTION_LIFT',
            'DISCUSSION_TRANSITION',
            'CTA_RESOLVE',
          ].map((moment, index) => ({
            moment,
            atSeconds: index,
            intent: `Fixture intent for ${moment}`,
            suppliedBy: 'TEMPORARY synthetic placeholder',
            isTemporary: true,
          })),
          productAttentionMap: beatSpec.map((beat) => ({
            beatId: beat.id,
            focus: `Fixture focus for ${beat.id}`,
            productVisible: beat.asset.startsWith('screen') || beat.asset.startsWith('product'),
            comprehensionGoal: `Fixture comprehension goal for ${beat.id}`,
          })),
          assetFeasibility: treatmentBeats,
          prohibitedImplications: ['That this fixture cut is agency-grade'],
          benchmarkEvidenceReferences: [],
          originalityStatement:
            'A fixture treatment. No agency, studio or existing campaign is named or imitated anywhere in this cut, and every structural move is general craft grammar.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }, 600_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('produces an ffprobe-verified 1080x1920 master at exactly 15.000s, with no reasoning provider available', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runFlagshipCli(
      [
        '--storyboard',
        storyboardRoot,
        '--work-pack',
        workPackRoot,
        '--campaign-dir',
        campaignDirectory,
        '--output-dir',
        outputDirectory,
        '--json',
      ],
      {
        cwd: root,
        // The hostile part: a campaign run exits 3 in this configuration.
        env: { ...process.env, REASONING_PROVIDER: 'claude', ANTHROPIC_API_KEY: '' },
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
        now: new Date('2026-07-28T12:00:00.000Z'),
        workflowRunId: 'flagship-acceptance-run',
      },
    );

    expect(code, stderr.join('')).toBe(EXIT_CODES.SUCCESS);

    const masterPath = stdout.join('').trim().split('\n').pop() as string;
    expect(masterPath.endsWith('.mp4')).toBe(true);

    const probe = await probeMedia(runner, masterPath, { ffprobePath: binaries.ffprobe });
    expect(probe.mediaType).toBe('VIDEO');
    if (probe.mediaType !== 'VIDEO') throw new Error('the master is not a video');
    expect(probe.widthPx).toBe(1080);
    expect(probe.heightPx).toBe(1920);
    expect(probe.durationSeconds).toBeCloseTo(15, 2);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');

    // Pixel format and faststart are read from the QA report, which is where
    // this repository's binding measurements live.
    const qa = JSON.parse(await readFile(`${masterPath}.qa.json`, 'utf8')) as {
      verdict: string;
      summary: { pixelFormat: string; faststart: boolean; durationSeconds: number };
    };
    expect(qa.verdict).toBe('PASS');
    expect(qa.summary.pixelFormat).toBe('yuv420p');
    expect(qa.summary.faststart).toBe(true);
    expect(qa.summary.durationSeconds).toBeCloseTo(15, 3);
  }, 900_000);

  it('labels the run HUMAN_ASSISTED_PREVIEW / INTERNAL_REVIEW with zero paid calls', async () => {
    const provenance = JSON.parse(
      await readFile(join(outputDirectory, 'flagship-provenance.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(provenance.executionMode).toBe('HUMAN_ASSISTED_PREVIEW');
    expect(provenance.outputUse).toBe('INTERNAL_REVIEW');
    expect(provenance.isRealCampaignRun).toBe(false);
    expect(provenance.paidProviderCalls).toBe(0);
    expect(provenance.reasoningProviderCalls).toBe(0);
    expect(provenance.videoGenerationProviderCalls).toBe(0);
    expect(provenance.requiresHumanApproval).toBe(true);
    expect(provenance.anyReferenceOutputEligible).toBe(false);
    expect(provenance.agencyGradeClaim).toBe('NOT_ASSESSED');
  });

  it('proves no storyboard byte reached the cut, before and after the render', async () => {
    const proof = JSON.parse(
      await readFile(join(outputDirectory, 'reference-exclusion-proof.json'), 'utf8'),
    ) as Record<string, any>;
    expect(proof.beforeRender.anyFileMatchesReference).toBe(false);
    expect(proof.beforeRender.filesChecked).toBeGreaterThan(0);
    expect(proof.afterRender.frames).toHaveLength(8);
    expect(proof.afterRender.frames.every((frame: any) => !frame.presentInOutput)).toBe(true);
    expect(proof.afterRender.verifiedSources.length).toBeGreaterThan(0);
    expect(proof.storyboardFramesUsedAsProductionMedia).toBe(0);
  });

  it('records the mockup as a mockup, with no fabricated identity anywhere in it', async () => {
    const provenance = JSON.parse(
      await readFile(join(outputDirectory, 'product-mockup-provenance.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(provenance.provenanceClass).toBe('PRODUCT_MOCKUP');
    expect(provenance.isLiveCapture).toBe(false);
    expect(provenance.isRealProductScreenshot).toBe(false);
    expect(provenance.containsUserGeneratedContent).toBe(false);
    expect(provenance.containsAnyText).toBe(false);
    expect(provenance.fabricatedIdentifiers).toEqual([]);
    expect(provenance.fabricatedCounts).toEqual([]);
  });

  it('blocks the scorecard on the temporary audio it actually rendered with', async () => {
    const scorecard = JSON.parse(
      await readFile(join(outputDirectory, 'agency-scorecard.json'), 'utf8'),
    ) as Record<string, any>;
    expect(scorecard.totalPointsAvailable).toBe(100);
    expect(scorecard.agencyGradeClaim).toBe('NOT_ASSESSED');
    expect(scorecard.status).toBe('BLOCKED_FROM_AGENCY_GRADE');
    expect(scorecard.blockingDefects.map((defect: any) => defect.code)).toContain(
      'TEMPORARY_AUDIO',
    );
    const craft = scorecard.dimensions.filter((d: any) => d.kind === 'CRAFT');
    expect(craft.every((d: any) => d.awardedPoints === null)).toBe(true);
  });

  it('writes a gallery, a contact sheet and a checksummed provenance sidecar', async () => {
    const entries = await readdir(outputDirectory);
    expect(entries).toContain('flagship-gallery.html');
    expect(entries).toContain('flagship-contact-sheet.png');
    expect(entries).toContain('flagship-provenance.checksum.json');
    expect(entries).toContain('asset-reconciliation.json');
    expect(entries).toContain('storyboard-verification.json');
    expect(entries).toContain('storyboard-conformance.json');

    const gallery = await readFile(join(outputDirectory, 'flagship-gallery.html'), 'utf8');
    expect(gallery).not.toContain('<script');
    expect(gallery).not.toContain('http://');
    expect(gallery).not.toContain('https://');
    expect(gallery).toContain('HUMAN_ASSISTED_PREVIEW');
    expect(gallery).toContain('NOT_ASSESSED');

    const sidecar = JSON.parse(
      await readFile(join(outputDirectory, 'flagship-provenance.checksum.json'), 'utf8'),
    ) as { checksum: string };
    const actual = createHash('sha256')
      .update(await readFile(join(outputDirectory, 'flagship-provenance.json'), 'utf8'), 'utf8')
      .digest('hex');
    expect(sidecar.checksum).toBe(actual);
  });

  it('leaks no credential, no absolute source path and no email into a public artefact', async () => {
    const publicArtefacts = [
      'flagship-provenance.checksum.json',
      'storyboard-conformance.json',
      'agency-scorecard.json',
      'product-mockup-provenance.json',
    ];
    for (const name of publicArtefacts) {
      // eslint-disable-next-line no-await-in-loop -- ordered so a failure names the file
      const text = await readFile(join(outputDirectory, name), 'utf8');
      expect(text, name).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
      expect(text, name).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
      expect(text, name).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/);
      expect(text, name).not.toContain('ANTHROPIC_API_KEY');
    }
  });

  it('renders the same master twice from the same inputs', async () => {
    const second = join(root, 'out-second');
    const stdout: string[] = [];
    const code = await runFlagshipCli(
      [
        '--storyboard',
        storyboardRoot,
        '--work-pack',
        workPackRoot,
        '--campaign-dir',
        campaignDirectory,
        '--output-dir',
        second,
      ],
      {
        cwd: root,
        env: { ...process.env, REASONING_PROVIDER: 'claude', ANTHROPIC_API_KEY: '' },
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
        now: new Date('2026-07-28T12:00:00.000Z'),
        workflowRunId: 'flagship-acceptance-run',
      },
    );
    expect(code).toBe(EXIT_CODES.SUCCESS);

    const first = JSON.parse(
      await readFile(join(outputDirectory, 'flagship-provenance.json'), 'utf8'),
    ) as { master: { checksumSha256: string } };
    const repeat = JSON.parse(await readFile(join(second, 'flagship-provenance.json'), 'utf8')) as {
      master: { checksumSha256: string };
    };
    expect(repeat.master.checksumSha256).toBe(first.master.checksumSha256);

    // And the render manifest that produced it is identical, checksum for
    // checksum, once the only run-local field — where the staged bytes happen
    // to sit on disk — is set aside. Compared as parsed JSON rather than by
    // string surgery, so nothing else can be normalised away by accident.
    const manifestOf = async (dir: string): Promise<string> => {
      const manifest = JSON.parse(await readFile(join(dir, 'render-manifest.json'), 'utf8')) as {
        sources: { path: string }[];
      };
      manifest.sources = manifest.sources.map((source) => ({ ...source, path: '<STAGED>' }));
      return JSON.stringify(manifest, null, 2);
    };
    expect(await manifestOf(second)).toBe(await manifestOf(outputDirectory));
  }, 900_000);

  it('refuses to run when the storyboard package has been edited to allow output', async () => {
    const tampered = join(root, 'tampered-storyboard');
    await mkdir(tampered, { recursive: true });
    for (const name of await readdir(storyboardRoot)) {
      // eslint-disable-next-line no-await-in-loop -- small fixed set
      const stats = await readFile(join(storyboardRoot, name)).catch(() => null);
      if (stats) {
        // eslint-disable-next-line no-await-in-loop -- as above
        await writeFile(join(tampered, name), stats);
      }
    }
    await mkdir(join(tampered, 'frames'), { recursive: true });
    for (const name of await readdir(join(storyboardRoot, 'frames'))) {
      // eslint-disable-next-line no-await-in-loop -- small fixed set
      await writeFile(
        join(tampered, 'frames', name),
        await readFile(join(storyboardRoot, 'frames', name)),
      );
    }
    const manifest = JSON.parse(
      await readFile(join(tampered, 'storyboard-manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    manifest.outputEligible = true;
    await writeFile(
      join(tampered, 'storyboard-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    const stderr: string[] = [];
    const code = await runFlagshipCli(
      [
        '--storyboard',
        tampered,
        '--work-pack',
        workPackRoot,
        '--campaign-dir',
        campaignDirectory,
        '--output-dir',
        join(root, 'out-tampered'),
      ],
      {
        cwd: root,
        env: process.env,
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
      },
    );
    expect(code).toBe(EXIT_CODES.INVALID_CAMPAIGN_REQUEST);
    expect(stderr.join('')).toContain('NOT_REFERENCE_ONLY');
  });
});

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { CommandOptions, CommandResult, CommandRunner } from '@combat/media';
import type {
  GeneratedCandidateRef,
  GenerationJobHandle,
  JobStatus,
  VideoGenerationCapabilities,
  VideoGenerationFailure,
  VideoGenerationProvider,
  VideoGenerationSubmitInput,
  VideoGenerationUsage,
} from '@combat/providers';
import { describe, expect, it } from 'vitest';

import { findArtefactSafetyProblems } from '../storyboard-video/artefact-safety';
import { STORYBOARD_VIDEO_EXIT_CODES } from '../storyboard-video/failures';
import { computeGenerationCacheKey } from '../storyboard-video/generation-cache';
import { assertPromptsAreSafe } from '../storyboard-video/prompt-safety';
import { parseAcceptanceBrief } from './acceptance-brief';
import { buildNotificationAss, resolveCardGeometry } from './notification-composite';
import { CountingFetch, OneRequestVideoGenerationProvider } from './one-request-guard';
import {
  assertNotPermanentlyRejected,
  findPermanentlyRejectedSegment,
  requirePlate,
  resolvePlateLibrary,
} from './plate-library';
import { recordSceneAcceptanceDecision } from './record-decision';
import { buildPendingReviewRecord } from './review-record';
import { assertRawClipUsable, runSceneAcceptance } from './run-scene-acceptance';
import { parseArguments } from './scene-acceptance-cli';

/**
 * Contracts that need no FFmpeg, no network and no API key.
 *
 * The expensive part of this command is one paid request, and everything that
 * can refuse it is cheap. These are the cheap checks, and they are the reason
 * the paid one is safe to make.
 */

const BINARIES = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };

class FakeRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  constructor(
    private readonly probe: (path: string) => CommandResult = () => probeJson(941, 1672),
  ) {}
  async run(
    command: string,
    args: readonly string[],
    _options?: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args });
    if (command === 'ffprobe') return this.probe(args[args.length - 1] as string);
    // A successful ffmpeg invocation leaves a file behind; a fake that reports
    // success without one would let a missing-output bug pass here.
    const output = args[args.length - 1];
    if (typeof output === 'string' && args.includes('-y')) {
      await writeFile(output, Buffer.from(`fake-output-${basename(output)}`));
    }
    return { stdout: '', stderr: '', exitCode: 0, stderrTruncated: false };
  }
}

function probeJson(width: number, height: number): CommandResult {
  return {
    stdout: JSON.stringify({ streams: [{ width, height }] }),
    stderr: '',
    exitCode: 0,
    stderrTruncated: false,
  };
}

async function platesDirectoryWith(names: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aamp-plates-'));
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop -- ordered so failures are stable
    await writeFile(join(directory, name), Buffer.from(`png-bytes-${name}`));
  }
  return directory;
}

const TEN = Array.from({ length: 10 }, (_, index) => `FRAME${index + 1}PLATE.png`);

function readBrief(): Promise<string> {
  return readFile(
    join(
      __dirname,
      '..',
      '..',
      'campaigns',
      'combat-reviews-flagship-02',
      'scene-01-ltx-acceptance.json',
    ),
    'utf8',
  );
}

async function loadCommittedBrief(): Promise<ReturnType<typeof parseAcceptanceBrief>> {
  return parseAcceptanceBrief(JSON.parse(await readBrief()));
}

describe('plate discovery', () => {
  it('maps FRAMEnPLATE to the canonical FRAME-NN, case-insensitively', async () => {
    const directory = await platesDirectoryWith([
      'frame1plate.PNG',
      ...TEN.slice(1),
      'Storyboard2.png.png',
      'notes.txt',
    ]);
    const library = await resolvePlateLibrary({
      platesDirectory: directory,
      runner: new FakeRunner(),
      binaries: BINARIES,
    });

    expect(library.plates).toHaveLength(10);
    expect(library.plates.map((plate) => plate.frameId)).toEqual([
      'FRAME-01',
      'FRAME-02',
      'FRAME-03',
      'FRAME-04',
      'FRAME-05',
      'FRAME-06',
      'FRAME-07',
      'FRAME-08',
      'FRAME-09',
      'FRAME-10',
    ]);
    const first = requirePlate(library, 'FRAME-01');
    expect(first.fileName).toBe('frame1plate.PNG');
    expect(first.orientation).toBe('PORTRAIT');
    expect(first.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(library.ignoredFiles).toContain('notes.txt');
    expect(library.ignoredFiles).toContain('Storyboard2.png.png');
  });

  it('refuses two files that resolve to the same frame rather than choosing one', async () => {
    const directory = await platesDirectoryWith([...TEN, 'FRAME01PLATE.jpg']);
    await expect(
      resolvePlateLibrary({
        platesDirectory: directory,
        runner: new FakeRunner(),
        binaries: BINARIES,
      }),
    ).rejects.toThrow(/FRAME-01 is ambiguous/i);
  });

  it('refuses a plate-shaped name carrying an unusable extension rather than calling it missing', async () => {
    const directory = await platesDirectoryWith([...TEN.slice(1), 'FRAME1PLATE.psd']);
    await expect(
      resolvePlateLibrary({
        platesDirectory: directory,
        runner: new FakeRunner(),
        binaries: BINARIES,
      }),
    ).rejects.toThrow(/FRAME1PLATE\.psd is plate-shaped but carries "\.psd"/i);
  });

  it('refuses a landscape plate by measurement', async () => {
    const directory = await platesDirectoryWith(TEN);
    const runner = new FakeRunner((path) =>
      basename(path).toUpperCase().startsWith('FRAME3PLATE')
        ? probeJson(1920, 1080)
        : probeJson(941, 1672),
    );
    await expect(
      resolvePlateLibrary({ platesDirectory: directory, runner, binaries: BINARIES }),
    ).rejects.toThrow(/not portrait/i);
  });

  it('reports every missing frame at once', async () => {
    const directory = await platesDirectoryWith(TEN.slice(0, 8));
    await expect(
      resolvePlateLibrary({
        platesDirectory: directory,
        runner: new FakeRunner(),
        binaries: BINARIES,
      }),
    ).rejects.toThrow(/FRAME-09 has no plate[\s\S]*FRAME-10 has no plate/i);
  });

  it('refuses an undecodable file rather than uploading it', async () => {
    const directory = await platesDirectoryWith(TEN);
    const runner = new FakeRunner(() => ({
      stdout: '',
      stderr: 'Invalid data found',
      exitCode: 1,
      stderrTruncated: false,
    }));
    await expect(
      resolvePlateLibrary({ platesDirectory: directory, runner, binaries: BINARIES }),
    ).rejects.toThrow(/could not be decoded as an image/i);
  });
});

describe('permanently rejected legacy clips', () => {
  it('refuses anything under a generated-clips directory, by location', () => {
    expect(findPermanentlyRejectedSegment('/x/MARKETING/generated-clips/FRAME-01.mp4')).toBe(
      'generated-clips',
    );
    expect(findPermanentlyRejectedSegment('C:\\x\\generated-clips\\FRAME-07.mp4')).toBe(
      'generated-clips',
    );
    expect(findPermanentlyRejectedSegment('/x/high quality/FRAME1PLATE.png')).toBeNull();
    expect(() =>
      assertNotPermanentlyRejected('/x/generated-clips/renamed.mp4', 'the source'),
    ).toThrow(/permanently rejected/i);
  });
});

describe('the committed Scene-1 brief', () => {
  it('passes the existing prompt gate unchanged', async () => {
    const brief = await loadCommittedBrief();
    const checked = assertPromptsAreSafe([brief.scene], () => true);
    expect(checked).toHaveLength(1);
    expect(checked[0]?.wordCount).toBeLessThanOrEqual(200);
    expect(checked[0]?.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('asks for no display, no interface and no audio, and states its prohibitions', async () => {
    const brief = await loadCommittedBrief();
    expect(brief.scene.motionPrompt).toContain('Do not alter');
    expect(brief.scene.motionPrompt).toMatch(/rear surface/i);
    expect(brief.scene.motionPrompt).toMatch(/Do not generate audio/i);
    expect(brief.generateAudio).toBe(false);
    expect(brief.generationDurationSeconds).toBe(6);
    expect(brief.model).toBe('ltx-2-3-fast');
    expect(brief.notification.treatment).toBe('SCREEN_SPACE_MOTION_GRAPHICS');
    // The headline carries no count: an unverified number of events is a claim
    // nobody made.
    expect(brief.notification.headline).not.toMatch(/\d/);
  });

  it('refuses a preservation flag on a generated scene', async () => {
    const raw = JSON.parse(await readBrief()) as Record<string, unknown>;
    const scene = { ...(raw.scene as object), preserveExactProductUi: true };
    expect(() => parseAcceptanceBrief({ ...raw, scene })).toThrow(/can never be regenerated/i);
  });

  it('refuses a pulse that fires before its card or runs past the clip', async () => {
    const raw = JSON.parse(await readBrief()) as Record<string, unknown>;
    const notification = raw.notification as Record<string, unknown>;
    expect(() =>
      parseAcceptanceBrief({
        ...raw,
        notification: { ...notification, pulseStartSeconds: 0.1 },
      }),
    ).toThrow(/before the card it belongs to/i);
    expect(() =>
      parseAcceptanceBrief({
        ...raw,
        notification: { ...notification, pulseStartSeconds: 5.95 },
      }),
    ).toThrow(/past the end of the clip/i);
  });

  it('refuses a brief with no named author', async () => {
    const raw = JSON.parse(await readBrief()) as Record<string, unknown>;
    expect(() => parseAcceptanceBrief({ ...raw, authoredBy: '' })).toThrow(/authoredBy/i);
  });
});

describe('one-request enforcement', () => {
  const handle: GenerationJobHandle = { jobId: 'job-1', shotId: 'scene-01' };

  class StubProvider implements VideoGenerationProvider {
    readonly name = 'stub';
    submissions = 0;
    getCapabilities(): VideoGenerationCapabilities {
      return {
        supportedModes: ['IMAGE_TO_VIDEO'],
        supportsReferenceImages: true,
        maxReferenceImages: 1,
        supportsReferenceVideo: false,
        supportedAspectRatios: ['9:16'],
        supportedResolutions: ['1080x1920'],
        minDurationSeconds: 6,
        maxDurationSeconds: 10,
        supportedFrameRates: [24],
        supportsSeed: false,
        supportsNegativePrompt: false,
        maxCandidateCount: 1,
      };
    }
    async submit(_input: VideoGenerationSubmitInput): Promise<GenerationJobHandle> {
      this.submissions += 1;
      return handle;
    }
    async getStatus(): Promise<JobStatus> {
      return 'SUCCEEDED';
    }
    async getFailure(): Promise<VideoGenerationFailure | null> {
      return null;
    }
    async fetchResult(): Promise<GeneratedCandidateRef[]> {
      return [];
    }
    async getUsage(): Promise<VideoGenerationUsage> {
      return { costCents: 36, currency: 'USD' };
    }
    async cancel(): Promise<void> {}
  }

  const submitInput = (idempotencyKey: string): VideoGenerationSubmitInput => ({
    idempotencyKey,
    shotId: 'scene-01',
    mode: 'IMAGE_TO_VIDEO',
    promptText: 'x',
    candidateCount: 1,
    params: { durationSeconds: 6, aspectRatio: '9:16', resolution: '1080x1920', frameRate: 24 },
  });

  it('permits exactly one billable submission and refuses a second', async () => {
    const inner = new StubProvider();
    const guarded = new OneRequestVideoGenerationProvider(inner);

    await guarded.submit(submitInput('key-a'));
    expect(guarded.billableSubmissionCount).toBe(1);

    await expect(guarded.submit(submitInput('key-b'))).rejects.toThrow(
      /authorised for exactly one paid generation/i,
    );
    expect(inner.submissions).toBe(1);
  });

  it('answers a repeat of the same key from the first handle without resubmitting', async () => {
    const inner = new StubProvider();
    const guarded = new OneRequestVideoGenerationProvider(inner);
    const first = await guarded.submit(submitInput('key-a'));
    const second = await guarded.submit(submitInput('key-a'));
    expect(second).toEqual(first);
    expect(inner.submissions).toBe(1);
    expect(guarded.billableSubmissionCount).toBe(1);
  });

  it('counts transport requests so a dry run can prove it made none', async () => {
    const counting = new CountingFetch(async () => new Response('{}'));
    expect(counting.requestCount).toBe(0);
    await counting.fetch('https://example.invalid/x');
    expect(counting.requestCount).toBe(1);
  });
});

describe('the cost ceiling', () => {
  it('refuses before anything is uploaded, and contacts nothing', async () => {
    const directory = await platesDirectoryWith(TEN);
    const out = await mkdtemp(join(tmpdir(), 'aamp-scene01-'));
    let fetched = 0;

    const result = await runSceneAcceptance({
      platesDirectory: directory,
      briefPath: join(
        __dirname,
        '..',
        '..',
        'campaigns',
        'combat-reviews-flagship-02',
        'scene-01-ltx-acceptance.json',
      ),
      outputDirectory: out,
      logoPath: join(out, 'logo.png'),
      // One 6s ltx-2-3-fast generation costs 36¢; 20¢ cannot cover it.
      maxCostCents: 20,
      dryRun: true,
      binaries: BINARIES,
      workflowRunId: 'test-run',
      now: new Date('2026-07-30T00:00:00.000Z'),
      runner: new FakeRunner(),
      fetchImpl: async () => {
        fetched += 1;
        return new Response('{}');
      },
    });

    expect(result.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.COST_CEILING_EXCEEDED);
    expect(result.failureKind).toBe('COST_CEILING_EXCEEDED');
    expect(result.failure).toMatch(/over the 20¢ ceiling/);
    expect(result.failure).toMatch(/nothing has been spent/i);
    expect(result.ltxRequestCount).toBe(0);
    expect(fetched).toBe(0);
  });
});

describe('the dry run', () => {
  it('resolves, prices and reports without a key, a request or a cent', async () => {
    const directory = await platesDirectoryWith(TEN);
    const out = await mkdtemp(join(tmpdir(), 'aamp-scene01-'));
    let fetched = 0;

    const result = await runSceneAcceptance({
      platesDirectory: directory,
      briefPath: join(
        __dirname,
        '..',
        '..',
        'campaigns',
        'combat-reviews-flagship-02',
        'scene-01-ltx-acceptance.json',
      ),
      outputDirectory: out,
      logoPath: join(out, 'logo.png'),
      maxCostCents: 40,
      dryRun: true,
      binaries: BINARIES,
      workflowRunId: 'test-run',
      now: new Date('2026-07-30T00:00:00.000Z'),
      runner: new FakeRunner(),
      fetchImpl: async () => {
        fetched += 1;
        return new Response('{}');
      },
      // Deliberately absent: apiKey. A dry run must never need one.
    });

    expect(result.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.SUCCESS);
    expect(result.dryRun).toBe(true);
    expect(result.ltxRequestCount).toBe(0);
    expect(result.networkRequestCount).toBe(0);
    expect(fetched).toBe(0);
    expect(result.costChargedCents).toBe(0);
    expect(result.maximumCostCents).toBe(36);
    expect(result.ceilingCents).toBe(40);
    expect(result.plateFrameId).toBe('FRAME-01');
    expect(result.plateChecksumSha256).toMatch(/^[0-9a-f]{64}$/);

    const plan = JSON.parse(await readFile(join(out, 'scene-01-run-plan.json'), 'utf8'));
    expect(plan.scope.scenesGenerated).toEqual([1]);
    expect(plan.scope.scenesDeliberatelyNotGenerated).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plan.scope.rendersFinalAdvertisement).toBe(false);
    expect(plan.request.authorisedRequestCount).toBe(1);
    expect(plan.plates).toHaveLength(10);
    expect(plan.staging.externalInputsAreReadOnly).toBe(true);
    expect(plan.generationCacheKey).toMatch(/^[0-9a-f]{64}$/);

    const prompt = await readFile(join(out, 'generation-prompt.txt'), 'utf8');
    expect(prompt).toContain('Do not alter');
    expect(findArtefactSafetyProblems(plan)).toEqual([]);
  });
});

describe('the generation cache key', () => {
  it('changes when any priced input changes', () => {
    const base = {
      inputFrameChecksumSha256: 'a'.repeat(64),
      motionPromptSha256: 'b'.repeat(64),
      model: 'ltx-2-3-fast',
      durationSeconds: 6,
      resolution: '1080x1920',
      fps: 24,
      generateAudio: false,
      cameraMotion: 'SLOW_PUSH_IN',
    };
    const key = computeGenerationCacheKey(base);
    for (const mutation of [
      { inputFrameChecksumSha256: 'c'.repeat(64) },
      { motionPromptSha256: 'd'.repeat(64) },
      { model: 'ltx-2-3-pro' },
      { durationSeconds: 8 },
      { fps: 30 },
      { generateAudio: true },
      { cameraMotion: 'STATIC' },
    ]) {
      expect(computeGenerationCacheKey({ ...base, ...mutation })).not.toBe(key);
    }
  });
});

describe('raw clip acceptance', () => {
  it('refuses a landscape result by name', () => {
    expect(() =>
      assertRawClipUsable(
        { widthPx: 1920, heightPx: 1080, durationSeconds: 6, videoCodec: 'h264' },
        6,
      ),
    ).toThrow(/landscape[\s\S]*permanently rejected/i);
  });

  it('refuses a short result rather than stretching it', () => {
    expect(() =>
      assertRawClipUsable(
        { widthPx: 1080, heightPx: 1920, durationSeconds: 2, videoCodec: 'h264' },
        6,
      ),
    ).toThrow(/never stretched to fit/i);
  });

  it('accepts the requested geometry and duration', () => {
    expect(() =>
      assertRawClipUsable(
        { widthPx: 1080, heightPx: 1920, durationSeconds: 6, videoCodec: 'h264' },
        6,
      ),
    ).not.toThrow();
  });
});

describe('the notification card', () => {
  it('stays inside the mobile-safe margin and clears the subject', async () => {
    const brief = await loadCommittedBrief();
    const geometry = resolveCardGeometry(brief.notification);
    expect(geometry.withinSafeBounds).toBe(true);
    expect(geometry.xPx).toBeGreaterThanOrEqual(brief.notification.safeMarginPx);
    // The subject's eyeline sits around 0.33 of frame height. The card is a
    // banner at the top and must end well above it.
    expect(geometry.yPx + geometry.heightPx).toBeLessThan(1920 * 0.3);
  });

  it('refuses a card that would leave the safe area', async () => {
    const brief = await loadCommittedBrief();
    const geometry = resolveCardGeometry({ ...brief.notification, cardTopPx: 1900 });
    expect(geometry.withinSafeBounds).toBe(false);
  });

  it('carries the headline in an ASS file rather than in filter grammar', async () => {
    const brief = await loadCommittedBrief();
    const ass = buildNotificationAss({
      brief: brief.notification,
      geometry: resolveCardGeometry(brief.notification),
      fromSeconds: 1,
      toSeconds: 6,
    });
    expect(ass).toContain(brief.notification.headline);
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass.split('\r\n').filter((line) => line.startsWith('Dialogue:'))).toHaveLength(1);
  });
});

describe('the pending review record', () => {
  it('is PENDING, names no reviewer and carries no verdict', async () => {
    const brief = await loadCommittedBrief();
    const record = buildPendingReviewRecord({
      scene: brief.scene,
      sceneRole: 'NOTIFICATION_HOOK',
      clipChecksumSha256: 'a'.repeat(64),
      plateChecksumSha256: 'b'.repeat(64),
      motionPromptSha256: 'c'.repeat(64),
      inspectionSha256: 'd'.repeat(64),
      openHumanJudgementQuestions: ['SUBJECT_IDENTITY_UNCHANGED: …'],
    });

    expect(record.status).toBe('PENDING');
    expect(record.reviewer).toBeNull();
    expect(record.verdict).toBeNull();
    expect(record.decidedAt).toBeNull();
    expect(record.identity.sourceType).toBe('LTX_GENERATED');
    expect(record.identitySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(findArtefactSafetyProblems(record)).toEqual([]);
  });

  it('changes identity when the clip bytes change', async () => {
    const brief = await loadCommittedBrief();
    const build = (clip: string) =>
      buildPendingReviewRecord({
        scene: brief.scene,
        sceneRole: 'NOTIFICATION_HOOK',
        clipChecksumSha256: clip,
        plateChecksumSha256: 'b'.repeat(64),
        motionPromptSha256: 'c'.repeat(64),
        inspectionSha256: 'd'.repeat(64),
        openHumanJudgementQuestions: [],
      }).identitySha256;
    expect(build('a'.repeat(64))).not.toBe(build('e'.repeat(64)));
  });
});

describe('the command line', () => {
  it('requires a plate directory and an explicit ceiling', () => {
    expect(() => parseArguments(['--max-cost-cents', '40'])).toThrow(/--plates-dir is required/);
    expect(() => parseArguments(['--plates-dir', 'x', '--dry-run'])).toThrow(
      /--max-cost-cents is required/,
    );
  });

  it('requires the owned mark for a live run', () => {
    expect(() => parseArguments(['--plates-dir', 'x', '--max-cost-cents', '40'])).toThrow(
      /--logo is required/,
    );
    expect(() =>
      parseArguments(['--plates-dir', 'x', '--max-cost-cents', '40', '--dry-run']),
    ).not.toThrow();
  });

  it('refuses an unrecognised option by name', () => {
    expect(() =>
      parseArguments(['--plates-dir', 'x', '--max-cost-cents', '40', '--force']),
    ).toThrow(/unrecognised option "--force"/);
  });

  it('refuses a non-positive ceiling', () => {
    expect(() => parseArguments(['--plates-dir', 'x', '--max-cost-cents', '0'])).toThrow(
      /positive whole number/,
    );
  });
});

describe('recording a human decision', () => {
  async function runDirectoryWithRecord(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'aamp-decide-'));
    const brief = await loadCommittedBrief();
    const record = buildPendingReviewRecord({
      scene: brief.scene,
      sceneRole: 'NOTIFICATION_HOOK',
      clipChecksumSha256: 'a'.repeat(64),
      plateChecksumSha256: 'b'.repeat(64),
      motionPromptSha256: 'c'.repeat(64),
      inspectionSha256: 'd'.repeat(64),
      openHumanJudgementQuestions: [],
    });
    await writeFile(
      join(directory, 'human-review-record.json'),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
    return directory;
  }

  it('records a named rejection against the run’s own identity', async () => {
    const directory = await runDirectoryWithRecord();
    const recorded = await recordSceneAcceptanceDecision({
      runDirectory: directory,
      reviewer: 'Riki Taylor',
      verdict: 'REJECTED',
      feedback:
        'The push is far larger than the brief asked for and the eyes leave frame. Regenerate with a materially smaller push held to the approved framing.',
      now: new Date('2026-07-30T15:00:00.000Z'),
    });

    expect(recorded.verdict).toBe('REJECTED');
    expect(recorded.reviewer).toBe('Riki Taylor');
    expect(recorded.sceneNumber).toBe(1);
    expect(recorded.decisionId).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded.supersedesDecisionId).toBeNull();

    const line = await readFile(recorded.ledgerPath, 'utf8');
    expect(line).toContain('REJECTED');
    expect(line).toContain('Riki Taylor');
  });

  it('refuses a decision with no named person', async () => {
    expect(() =>
      parseArguments(['decide', '--verdict', 'REJECTED', '--feedback', 'x'.repeat(40)]),
    ).toThrow(/--reviewer/);
  });

  it('refuses a rejection that says nothing actionable', async () => {
    const directory = await runDirectoryWithRecord();
    await expect(
      recordSceneAcceptanceDecision({
        runDirectory: directory,
        reviewer: 'Riki Taylor',
        verdict: 'REJECTED',
        feedback: 'bad',
        now: new Date('2026-07-30T15:00:00.000Z'),
      }),
    ).rejects.toThrow(/mood, not a direction/i);
  });

  it('refuses a review record that was edited after it was written', async () => {
    const directory = await runDirectoryWithRecord();
    const path = join(directory, 'human-review-record.json');
    const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    (record.identity as Record<string, unknown>).clipChecksumSha256 = 'e'.repeat(64);
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    await expect(
      recordSceneAcceptanceDecision({
        runDirectory: directory,
        reviewer: 'Riki Taylor',
        verdict: 'REJECTED',
        feedback:
          'The push is far larger than the brief asked for and the eyes leave frame. Regenerate smaller.',
        now: new Date('2026-07-30T15:00:00.000Z'),
      }),
    ).rejects.toThrow(/edited after it was written/i);
  });

  it('has nothing to decide about before a run has produced bytes', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'aamp-decide-empty-'));
    await expect(
      recordSceneAcceptanceDecision({
        runDirectory: empty,
        reviewer: 'Riki Taylor',
        verdict: 'APPROVED',
        feedback: 'looks right',
        now: new Date('2026-07-30T15:00:00.000Z'),
      }),
    ).rejects.toThrow(/nothing to decide about/i);
  });
});

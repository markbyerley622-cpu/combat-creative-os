import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { NodeCommandRunner } from '@combat/media';
import { FakeLtxServer } from '@combat/providers/testing';
import { describe, expect, it } from 'vitest';

import { STORYBOARD_VIDEO_EXIT_CODES } from '../storyboard-video/failures';
import { runSceneAcceptance } from './run-scene-acceptance';

/**
 * The whole Scene-1 path, end to end, against the in-process fake LTX server.
 *
 * It exercises the real client — the real upload ticket, the real signed PUT,
 * the real poll loop, the real download, the real failure mapping — and the
 * real inspection, composite and gallery, while contacting no third party and
 * spending nothing. It is **not** evidence about api.ltx.io; the response
 * contract stays `DOCUMENTED_NOT_EXECUTED` until an opt-in live test says
 * otherwise.
 *
 * It needs a real FFmpeg, because the thing being proven is that a real file
 * is measured, composited and reported on. Without one it skips **loudly**
 * rather than passing quietly.
 */

const run = promisify(execFile);
const BRIEF_PATH = join(
  __dirname,
  '..',
  '..',
  'campaigns',
  'combat-reviews-flagship-02',
  'scene-01-ltx-acceptance.json',
);
const BINARIES = {
  ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH ?? 'ffprobe',
};

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(BINARIES.ffmpeg, ['-version']);
    await run(BINARIES.ffprobe, ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** Ten portrait plates, structured enough for layout correlation to mean something. */
async function buildPlates(directory: string): Promise<void> {
  for (let index = 1; index <= 10; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- ordered, and cheap
    await run(BINARIES.ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=941x1672:rate=1:duration=1`,
      '-frames:v',
      '1',
      '-y',
      join(directory, `FRAME${index}PLATE.png`),
    ]);
  }
}

/** A believable "generated" clip: a slow push-in of the plate itself. */
async function buildGeneratedClip(platePath: string, target: string): Promise<Uint8Array> {
  await run(BINARIES.ffmpeg, [
    '-v',
    'error',
    '-loop',
    '1',
    '-i',
    platePath,
    '-vf',
    "scale=1080:1920:flags=lanczos,zoompan=z='min(1.25,1+0.25*on/143)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=144:s=1080x1920:fps=24",
    '-t',
    '6',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-an',
    '-y',
    target,
  ]);
  return new Uint8Array(await readFile(target));
}

async function buildLogo(target: string): Promise<void> {
  await run(BINARIES.ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=0xDA0318:size=507x350',
    '-frames:v',
    '1',
    '-y',
    target,
  ]);
}

describe('Scene-1 acceptance lifecycle', () => {
  it('makes exactly one request, inspects, composites and leaves the review pending', async () => {
    if (!(await ffmpegAvailable())) {
      // eslint-disable-next-line no-console -- a silent skip would read as a pass
      console.warn(
        'SKIPPED: the Scene-1 lifecycle test needs a real FFmpeg and ffprobe on PATH (or FFMPEG_PATH/FFPROBE_PATH).',
      );
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), 'aamp-scene01-live-'));
    const plates = join(workspace, 'plates');
    await run('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(plates)})`]);
    await buildPlates(plates);
    const logo = join(workspace, 'logo.png');
    await buildLogo(logo);
    const videoBytes = await buildGeneratedClip(
      join(plates, 'FRAME1PLATE.png'),
      join(workspace, 'generated.mp4'),
    );

    const server = new FakeLtxServer({
      defaultJob: { pendingPolls: 1, processingPolls: 1, videoBytes },
    });

    const result = await runSceneAcceptance({
      platesDirectory: plates,
      briefPath: BRIEF_PATH,
      outputDirectory: join(workspace, 'out'),
      logoPath: logo,
      maxCostCents: 40,
      dryRun: false,
      binaries: BINARIES,
      workflowRunId: 'lifecycle-test',
      now: new Date('2026-07-30T00:00:00.000Z'),
      apiKey: 'fake-test-credential',
      runner: new NodeCommandRunner(),
      fetchImpl: server.fetch,
      sleep: async () => {},
      pollIntervalMs: 0,
    });

    expect(result.failure).toBeUndefined();
    expect(result.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.SUCCESS);

    // --- exactly one billable request ---------------------------------------
    expect(server.submissions).toBe(1);
    expect(result.ltxRequestCount).toBe(1);
    expect(result.maximumCostCents).toBe(36);
    expect(result.ceilingCents).toBe(40);
    expect(result.costChargedCents).toBe(36);

    // --- the request said what the brief said --------------------------------
    const submit = server.requests.find((request) => request.path === '/v2/image-to-video');
    const body = submit?.body as Record<string, unknown>;
    expect(body.model).toBe('ltx-2-3-fast');
    expect(body.duration).toBe(6);
    expect(body.resolution).toBe('1080x1920');
    expect(body.fps).toBe(24);
    expect(body.generate_audio).toBe(false);
    expect(String(body.prompt)).toContain('Do not alter');
    expect(submit?.hasAuthorization).toBe(true);

    // --- the file was measured, not taken on the provider's word -------------
    expect(result.technicalVerdict).toBe('TECHNICALLY_VALID');
    expect(result.measured?.widthPx).toBe(1080);
    expect(result.measured?.heightPx).toBe(1920);
    expect(result.measured?.hasAudio).toBe(false);
    expect(result.rawClipChecksumSha256).toMatch(/^[0-9a-f]{64}$/);

    // --- the artefacts a reviewer needs --------------------------------------
    for (const artefact of [
      'scene-01-run-plan.json',
      'technical-inspection.json',
      'visual-defects.json',
      'provider-provenance.json',
      'cost-report.json',
      'human-review-record.json',
      'generation-prompt.txt',
      'scene-01-comparison.html',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- ordered so a failure names the file
      const stats = await stat(join(workspace, 'out', artefact));
      expect(stats.size).toBeGreaterThan(0);
    }
    expect((await stat(result.contactSheetPath as string)).size).toBeGreaterThan(0);
    expect((await stat(result.compositedClipPath as string)).size).toBeGreaterThan(0);

    // --- nothing was approved ------------------------------------------------
    const review = JSON.parse(
      await readFile(join(workspace, 'out', 'human-review-record.json'), 'utf8'),
    );
    expect(review.status).toBe('PENDING');
    expect(review.reviewer).toBeNull();
    expect(review.verdict).toBeNull();
    expect(result.reviewStatus).toBe('VISUAL_REVIEW_PENDING');
    expect(result.safeAsProductionSource).toBe(false);

    // --- no signed URL and no credential reached any artefact -----------------
    const gallery = await readFile(join(workspace, 'out', 'scene-01-comparison.html'), 'utf8');
    expect(gallery).not.toContain('signature=');
    expect(gallery).not.toContain('fake-test-credential');
    for (const artefact of [
      'scene-01-run-plan.json',
      'provider-provenance.json',
      'cost-report.json',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- ordered
      const text = await readFile(join(workspace, 'out', artefact), 'utf8');
      expect(text).not.toContain('fake-test-credential');
      expect(text).not.toContain('signature=');
      expect(text).not.toContain('upload_url');
      expect(text).not.toContain('video_url');
    }

    // --- the provenance says what it is and is not ---------------------------
    const provenance = JSON.parse(
      await readFile(join(workspace, 'out', 'provider-provenance.json'), 'utf8'),
    );
    expect(provenance.paidProviderCalls).toBe(1);
    expect(provenance.scenesGenerated).toEqual([1]);
    expect(provenance.scenesNotGenerated).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(provenance.finalAdvertisementRendered).toBe(false);
    expect(provenance.requiresHumanApproval).toBe(true);
    expect(provenance.composite.treatment).toBe('SCREEN_SPACE_MOTION_GRAPHICS');

    // --- the display checks are not applicable to this composition -----------
    const defects = JSON.parse(
      await readFile(join(workspace, 'out', 'visual-defects.json'), 'utf8'),
    );
    const byId = new Map<string, { status: string }>(
      (defects.observations as { id: string; status: string }[]).map((row) => [row.id, row]),
    );
    expect(byId.get('ACTIVE_DISPLAY_BLANK_AND_NEAR_BLACK')?.status).toBe('NOT_APPLICABLE');
    expect(byId.get('FOUR_ACTIVE_DISPLAY_CORNERS_TRACKABLE')?.status).toBe('NOT_APPLICABLE');
    expect(byId.get('PORTRAIT_ORIENTATION')?.status).toBe('OBSERVED');
    expect(byId.get('OPENS_ON_APPROVED_COMPOSITION')?.status).toBe('OBSERVED');
    expect(byId.get('NO_AUDIO_STREAM')?.status).toBe('OBSERVED');
    expect(byId.get('SUBJECT_IDENTITY_UNCHANGED')?.status).toBe('HUMAN_JUDGEMENT_REQUIRED');
    expect(defects.measuredDefectCount).toBe(0);
    expect(defects.openHumanJudgementCount).toBeGreaterThan(0);

    // --- a second run over the same inputs contacts nothing ------------------
    const second = await runSceneAcceptance({
      platesDirectory: plates,
      briefPath: BRIEF_PATH,
      outputDirectory: join(workspace, 'out'),
      logoPath: logo,
      maxCostCents: 40,
      dryRun: false,
      binaries: BINARIES,
      workflowRunId: 'lifecycle-test-2',
      now: new Date('2026-07-30T00:00:00.000Z'),
      apiKey: 'fake-test-credential',
      runner: new NodeCommandRunner(),
      fetchImpl: server.fetch,
      sleep: async () => {},
      pollIntervalMs: 0,
    });
    expect(second.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.SUCCESS);
    expect(second.cacheHit).toBe(true);
    expect(second.ltxRequestCount).toBe(0);
    expect(second.costChargedCents).toBe(0);
    expect(server.submissions).toBe(1);
  }, 300_000);

  it('maps a billing refusal onto its own exit code and submits nothing further', async () => {
    if (!(await ffmpegAvailable())) {
      // eslint-disable-next-line no-console -- a silent skip would read as a pass
      console.warn('SKIPPED: needs a real FFmpeg.');
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), 'aamp-scene01-402-'));
    const plates = join(workspace, 'plates');
    await run('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(plates)})`]);
    await buildPlates(plates);
    await writeFile(join(workspace, 'logo.png'), Buffer.from('x'));

    const server = new FakeLtxServer({ submitStatus: 402 });
    const result = await runSceneAcceptance({
      platesDirectory: plates,
      briefPath: BRIEF_PATH,
      outputDirectory: join(workspace, 'out'),
      logoPath: join(workspace, 'logo.png'),
      maxCostCents: 40,
      dryRun: false,
      binaries: BINARIES,
      workflowRunId: 'payment-test',
      now: new Date('2026-07-30T00:00:00.000Z'),
      apiKey: 'fake-test-credential',
      runner: new NodeCommandRunner(),
      fetchImpl: server.fetch,
      sleep: async () => {},
      pollIntervalMs: 0,
    });

    expect(result.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.PAYMENT_REQUIRED);
    expect(result.failureKind).toBe('PAYMENT_REQUIRED');
    expect(server.submissions).toBe(0);
    expect(result.compositedClipPath).toBeUndefined();
  }, 300_000);

  it('refuses without a key rather than degrading to anything', async () => {
    if (!(await ffmpegAvailable())) {
      // eslint-disable-next-line no-console -- a silent skip would read as a pass
      console.warn('SKIPPED: needs a real FFmpeg.');
      return;
    }
    const workspace = await mkdtemp(join(tmpdir(), 'aamp-scene01-nokey-'));
    const plates = join(workspace, 'plates');
    await run('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(plates)})`]);
    await buildPlates(plates);
    await writeFile(join(workspace, 'logo.png'), Buffer.from('x'));

    let fetched = 0;
    const result = await runSceneAcceptance({
      platesDirectory: plates,
      briefPath: BRIEF_PATH,
      outputDirectory: join(workspace, 'out'),
      logoPath: join(workspace, 'logo.png'),
      maxCostCents: 40,
      dryRun: false,
      binaries: BINARIES,
      workflowRunId: 'nokey-test',
      now: new Date('2026-07-30T00:00:00.000Z'),
      apiKey: '',
      runner: new NodeCommandRunner(),
      fetchImpl: async () => {
        fetched += 1;
        return new Response('{}');
      },
      sleep: async () => {},
      pollIntervalMs: 0,
    });

    expect(result.exitCode).toBe(STORYBOARD_VIDEO_EXIT_CODES.MISSING_API_KEY);
    expect(result.failure).toMatch(/nothing has been spent/i);
    expect(fetched).toBe(0);
  }, 300_000);
});

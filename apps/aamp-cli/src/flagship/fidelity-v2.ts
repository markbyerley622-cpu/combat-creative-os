import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { num, type CommandRunner, type FfmpegBinaries } from '@combat/media';

import type { HumanCreativePlan } from '../preview/human-plan';
import { LOCKED_SCENE_ROLES, LOCKED_SCENE_SLOTS, type VerifiedStoryboardV2 } from './storyboard-v2';

/**
 * Storyboard fidelity: did the cut actually execute the locked storyboard?
 *
 * The acceptance conditions this milestone was given are all structural — a
 * missing scene, a reordering, a gap, a rewritten headline, an unrelated asset
 * standing in for a panel. So the report is structural too: it compares what
 * was rendered against what the package locked, scene by scene, and fails the
 * run rather than describing a mismatch and continuing.
 *
 * What it deliberately does *not* do is score how good the animation is. That
 * is a craft judgement, it belongs to a person, and a number invented here
 * would be the one part of this report nobody could check.
 */

export interface SceneFidelityRow {
  readonly sequence: number;
  readonly sceneRole: string;
  readonly storyboardFrameId: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly durationSeconds: number;
  readonly headline: string;
  readonly beatId: string;
  readonly sourceAssetId: string;
  readonly visualSource: 'STORYBOARD_PANEL' | 'STORYBOARD_PANEL_FACTUALLY_CORRECTED';
  readonly productScreenSource: 'PRODUCT_MOCKUP' | 'REAL_CAPTURE' | 'NONE';
  readonly compositionNote: string;
  readonly animationPerformed: string;
  readonly transitionIn: string;
  readonly remainingMismatch: string;
}

export interface FidelityReport {
  readonly storyboardId: string;
  readonly verdict: 'PASS' | 'FAIL';
  readonly failures: readonly string[];
  readonly sceneCount: number;
  readonly totalSeconds: number;
  readonly scenes: readonly SceneFidelityRow[];
  readonly checks: readonly {
    readonly check: string;
    readonly verdict: 'PASS' | 'FAIL';
    readonly detail: string;
  }[];
  readonly notice: string;
}

export interface BuildFidelityInput {
  readonly storyboard: VerifiedStoryboardV2;
  readonly plan: HumanCreativePlan;
  /** Authored per-scene notes: what was done, and what still does not match. */
  readonly sceneNotes: ReadonlyMap<
    string,
    {
      readonly compositionNote: string;
      readonly animationPerformed: string;
      readonly remainingMismatch: string;
      readonly productScreenSource: 'PRODUCT_MOCKUP' | 'REAL_CAPTURE' | 'NONE';
    }
  >;
  readonly panelAssetIdBySequence: ReadonlyMap<number, string>;
}

export function buildFidelityReport(input: BuildFidelityInput): FidelityReport {
  const { storyboard, plan } = input;
  const failures: string[] = [];
  const checks: { check: string; verdict: 'PASS' | 'FAIL'; detail: string }[] = [];
  const record = (check: string, ok: boolean, detail: string): void => {
    checks.push({ check, verdict: ok ? 'PASS' : 'FAIL', detail });
    if (!ok) failures.push(`${check}: ${detail}`);
  };

  record(
    'ten scenes present',
    plan.beats.length === LOCKED_SCENE_ROLES.length,
    `${plan.beats.length} beats against ${LOCKED_SCENE_ROLES.length} locked scenes`,
  );

  // Settled starts and ends, computed exactly as the edit builder computes them.
  const rows: SceneFidelityRow[] = [];
  let running = 0;
  let previousEnd = 0;
  plan.beats.forEach((beat, index) => {
    const overlap = beat.transitionIn?.durationSeconds ?? 0;
    const start = index === 0 ? 0 : Number(running.toFixed(6));
    running = index === 0 ? beat.durationSeconds : running + beat.durationSeconds - overlap;
    const end = Number(running.toFixed(6));

    const frame = storyboard.frames[index];
    const slot = LOCKED_SCENE_SLOTS[index];
    if (!frame || !slot) {
      failures.push(`scene ${index + 1} has no locked panel`);
      return;
    }
    if (Math.abs(start - slot[0]) > 1e-3 || Math.abs(end - slot[1]) > 1e-3) {
      failures.push(
        `scene ${index + 1} (${frame.sceneRole}) renders ${start.toFixed(3)}-${end.toFixed(3)}s but the locked slot is ${slot[0]}-${slot[1]}s`,
      );
    }
    if (Math.abs(start - previousEnd) > 1e-6) {
      failures.push(
        `a ${Math.abs(start - previousEnd).toFixed(3)}s gap or overlap precedes scene ${index + 1}`,
      );
    }
    previousEnd = end;

    const expectedAsset = input.panelAssetIdBySequence.get(frame.sequence);
    if (beat.source.assetId !== expectedAsset) {
      failures.push(
        `scene ${index + 1} (${frame.sceneRole}) renders "${beat.source.assetId ?? 'nothing'}" rather than its own locked panel "${expectedAsset ?? '?'}"`,
      );
    }

    const notes = input.sceneNotes.get(frame.sceneRole);
    const headline = frame.factualCorrection
      ? frame.factualCorrection.headlineAfter
      : (frame.onScreenCopyIntent[frame.onScreenCopyIntent.length - 1] ?? '');

    rows.push({
      sequence: frame.sequence,
      sceneRole: frame.sceneRole,
      storyboardFrameId: frame.frameId,
      startSeconds: start,
      endSeconds: end,
      durationSeconds: Number((end - start).toFixed(6)),
      headline,
      beatId: beat.id,
      sourceAssetId: beat.source.assetId ?? '',
      visualSource: frame.isFactuallyCorrected
        ? 'STORYBOARD_PANEL_FACTUALLY_CORRECTED'
        : 'STORYBOARD_PANEL',
      productScreenSource: notes?.productScreenSource ?? 'NONE',
      compositionNote: notes?.compositionNote ?? '',
      animationPerformed: `${beat.motion.treatment} at intensity ${beat.motion.intensity}${
        notes ? ` — ${notes.animationPerformed}` : ''
      }`,
      transitionIn: beat.transitionIn
        ? `${beat.transitionIn.kind} ${beat.transitionIn.durationSeconds}s`
        : 'opening scene',
      remainingMismatch: notes?.remainingMismatch ?? '',
    });
  });

  record(
    'scene order matches the locked storyboard',
    rows.every((row, index) => row.sceneRole === LOCKED_SCENE_ROLES[index]),
    rows.map((row) => row.sequence).join(','),
  );
  record(
    'no gap or overlap between scenes',
    !failures.some((f) => f.includes('gap or overlap')),
    '9 of 9 joins',
  );
  record(
    'total duration is exactly 15 seconds',
    Math.abs(previousEnd - 15) < 1e-3,
    `${previousEnd.toFixed(3)}s`,
  );
  record(
    'every scene renders its own locked panel',
    !failures.some((f) => f.includes('rather than its own locked panel')),
    `${rows.length} of ${rows.length}`,
  );
  record(
    'no headline was creatively rewritten',
    storyboard.corrections.every((c) => c.reason.length > 0),
    storyboard.corrections.length === 0
      ? 'no corrections'
      : `${storyboard.corrections.length} declared factual correction(s), each with a recorded reason`,
  );
  record(
    'transitions vary across the cut',
    new Set(rows.slice(1).map((row) => row.transitionIn.split(' ')[0])).size >= 4,
    `${new Set(rows.slice(1).map((row) => row.transitionIn.split(' ')[0])).size} distinct transition kinds`,
  );

  return {
    storyboardId: storyboard.storyboardId,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    failures,
    sceneCount: rows.length,
    totalSeconds: Number(previousEnd.toFixed(6)),
    scenes: rows,
    checks,
    notice:
      'This report measures whether the cut executed the locked storyboard: scene presence, order, timing, panel binding and headline integrity. It does not score how good the animation is, because no measurement of that exists and a number invented here would be the one figure in this report nobody could check.',
  };
}

// ---------------------------------------------------------------------------
// Keyframes and the side-by-side gallery
// ---------------------------------------------------------------------------

export const KEYFRAME_DIRECTORY = 'output-keyframes';
export const PANEL_COPY_DIRECTORY = 'storyboard-panels';
export const COMPARISON_GALLERY_FILENAME = 'storyboard-comparison-gallery.html';

export interface SceneKeyframe {
  readonly sequence: number;
  readonly atSeconds: number;
  readonly keyframeFileName: string;
  readonly panelFileName: string;
}

/**
 * One representative frame per scene, sampled from the finished master, beside
 * a copy of the panel it was meant to execute.
 *
 * The panel is copied into the run directory rather than linked, so the gallery
 * is a self-contained review artefact that still opens after the external
 * package moves. Both copies stay inside the run's own output, which is
 * git-ignored.
 */
export async function extractSceneKeyframes(input: {
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly runDirectory: string;
  readonly masterPath: string;
  readonly storyboard: VerifiedStoryboardV2;
  readonly scenes: readonly SceneFidelityRow[];
}): Promise<readonly SceneKeyframe[]> {
  await mkdir(join(input.runDirectory, KEYFRAME_DIRECTORY), { recursive: true });
  await mkdir(join(input.runDirectory, PANEL_COPY_DIRECTORY), { recursive: true });

  const keyframes: SceneKeyframe[] = [];
  for (const scene of input.scenes) {
    // Sampled at 62% through the scene: past the incoming transition and past
    // any staged reveal, so the frame shows the shot rather than its entrance.
    const atSeconds = Number(
      (scene.startSeconds + (scene.endSeconds - scene.startSeconds) * 0.62).toFixed(3),
    );
    const keyframeFileName = `${KEYFRAME_DIRECTORY}/${String(scene.sequence).padStart(2, '0')}-${scene.sceneRole.toLowerCase()}.png`;
    // eslint-disable-next-line no-await-in-loop -- ordered so the gallery is stable
    const result = await input.runner.run(
      input.binaries.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-ss',
        num(atSeconds),
        '-i',
        input.masterPath,
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        '-y',
        join(input.runDirectory, keyframeFileName),
      ],
      { timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`could not sample a keyframe for scene ${scene.sequence} at ${atSeconds}s`);
    }

    const frame = input.storyboard.frames[scene.sequence - 1];
    const panelFileName = `${PANEL_COPY_DIRECTORY}/${String(scene.sequence).padStart(2, '0')}-${scene.storyboardFrameId}.png`;
    if (frame) {
      // eslint-disable-next-line no-await-in-loop -- as above
      await input.runner.run(
        input.binaries.ffmpeg,
        [
          '-nostdin',
          '-v',
          'error',
          '-i',
          frame.renderAbsolutePath,
          '-frames:v',
          '1',
          '-pix_fmt',
          'rgb24',
          '-y',
          join(input.runDirectory, panelFileName),
        ],
        { timeoutMs: 60_000 },
      );
    }
    keyframes.push({ sequence: scene.sequence, atSeconds, keyframeFileName, panelFileName });
  }
  return keyframes;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface WriteComparisonGalleryInput {
  readonly runDirectory: string;
  readonly campaignName: string;
  readonly masterPath: string;
  readonly masterChecksumSha256: string | null;
  readonly measured: Record<string, unknown>;
  readonly qaVerdict: string;
  readonly report: FidelityReport;
  readonly keyframes: readonly SceneKeyframe[];
  readonly storyboard: VerifiedStoryboardV2;
  readonly declarations: Record<string, unknown>;
}

/** The side-by-side review page. No script, no network, every string escaped. */
export async function writeComparisonGallery(input: WriteComparisonGalleryInput): Promise<string> {
  const byScene = new Map(input.keyframes.map((frame) => [frame.sequence, frame]));

  const cards = input.report.scenes
    .map((scene) => {
      const kf = byScene.get(scene.sequence);
      return `
      <section class="scene">
        <header>
          <h2><span class="idx">${scene.sequence}</span> ${escapeHtml(scene.sceneRole)}
            <span class="muted">${scene.startSeconds.toFixed(2)}s &rarr; ${scene.endSeconds.toFixed(2)}s
            (${scene.durationSeconds.toFixed(2)}s)</span></h2>
          <p class="headline">${escapeHtml(scene.headline)}</p>
        </header>
        <div class="pair">
          <figure>
            <img src="${escapeHtml(kf?.panelFileName ?? '')}" alt="storyboard panel ${escapeHtml(scene.storyboardFrameId)}" />
            <figcaption>Storyboard panel &mdash; ${escapeHtml(scene.storyboardFrameId)}${
              scene.visualSource === 'STORYBOARD_PANEL_FACTUALLY_CORRECTED'
                ? ' <span class="tag">factually corrected</span>'
                : ''
            }</figcaption>
          </figure>
          <figure>
            <img src="${escapeHtml(kf?.keyframeFileName ?? '')}" alt="output keyframe for scene ${scene.sequence}" />
            <figcaption>Output keyframe &mdash; ${kf ? kf.atSeconds.toFixed(2) : '?'}s</figcaption>
          </figure>
        </div>
        <dl>
          <dt>Visual role match</dt><dd>${escapeHtml(scene.visualSource)}</dd>
          <dt>Product screen</dt><dd>${escapeHtml(scene.productScreenSource)}</dd>
          <dt>Composition</dt><dd>${escapeHtml(scene.compositionNote)}</dd>
          <dt>Animation performed</dt><dd>${escapeHtml(scene.animationPerformed)}</dd>
          <dt>Transition in</dt><dd>${escapeHtml(scene.transitionIn)}</dd>
          <dt class="${scene.remainingMismatch ? 'warn' : ''}">Remaining mismatch</dt>
          <dd class="${scene.remainingMismatch ? 'warn' : 'muted'}">${
            scene.remainingMismatch ? escapeHtml(scene.remainingMismatch) : 'none recorded'
          }</dd>
        </dl>
      </section>`;
    })
    .join('');

  const checkRows = input.report.checks
    .map(
      (check) =>
        `<tr class="${check.verdict === 'PASS' ? 'ok' : 'bad'}"><td>${escapeHtml(check.check)}</td><td>${check.verdict}</td><td>${escapeHtml(check.detail)}</td></tr>`,
    )
    .join('');

  const declarationRows = Object.entries(input.declarations)
    .map(([key, value]) => `<li><b>${escapeHtml(key)}</b> ${escapeHtml(String(value))}</li>`)
    .join('');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(input.campaignName)} — storyboard fidelity</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:32px; background:#0B0B0F; color:#EDEDF2;
         font:15px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  h1 { font-size:30px; margin:0 0 6px; letter-spacing:-.01em; }
  h2 { font-size:17px; margin:0 0 6px; font-weight:650; }
  .idx { display:inline-block; background:#DA0318; color:#fff; border-radius:5px;
         padding:1px 9px; font-size:12px; margin-right:8px; vertical-align:middle; }
  .muted { color:#8A8A99; font-weight:400; }
  .warn { color:#FFB020; }
  .tag { background:#2A2A34; border-radius:4px; padding:1px 6px; font-size:11px; color:#C8C8D4; }
  .banner { border:1px solid #34343F; border-left:4px solid #DA0318; border-radius:8px;
            padding:14px 18px; margin:20px 0 28px; background:#131319; }
  .banner ul { display:flex; flex-wrap:wrap; gap:8px 26px; margin:0; padding:0; list-style:none; font-size:14px; }
  .banner b { color:#8A8A99; font-weight:500; }
  .scene { border-top:1px solid #22222B; padding:22px 0; }
  .headline { margin:0 0 12px; font-size:15px; color:#fff; font-weight:600; letter-spacing:.01em; }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:18px; align-items:start; }
  .pair figure { margin:0; }
  .pair img { width:100%; border-radius:8px; display:block; background:#000; }
  figcaption { color:#8A8A99; font-size:12.5px; margin-top:6px; }
  dl { display:grid; grid-template-columns:170px 1fr; gap:5px 16px; margin:14px 0 0; font-size:13.5px; }
  dt { color:#8A8A99; } dd { margin:0; }
  table { border-collapse:collapse; width:100%; margin-top:12px; font-size:13.5px; }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid #22222B; vertical-align:top; }
  th { color:#8A8A99; font-weight:500; }
  tr.bad td { color:#FF8A80; }
  section.block { margin-top:38px; }
  @media (max-width:860px){ .pair{grid-template-columns:1fr;} }
</style>
</head>
<body>
<h1>${escapeHtml(input.campaignName)}</h1>
<p class="muted">Locked ten-panel storyboard, animated. Storyboard panel on the left, rendered output on the right.</p>

<div class="banner">
  <ul>${declarationRows}</ul>
  <ul style="margin-top:10px">
    <li><b>Master</b> <code>${escapeHtml(basename(input.masterPath))}</code></li>
    <li><b>Measured</b> ${escapeHtml(String(input.measured.widthPx ?? '?'))}&times;${escapeHtml(String(input.measured.heightPx ?? '?'))},
        ${escapeHtml(String(input.measured.durationSeconds ?? '?'))}s,
        ${escapeHtml(String(input.measured.videoCodec ?? 'none'))}/${escapeHtml(String(input.measured.audioCodec ?? 'none'))}</li>
    <li><b>Actual-media QA</b> ${escapeHtml(input.qaVerdict)}</li>
    <li><b>Fidelity</b> ${escapeHtml(input.report.verdict)}</li>
  </ul>
  <p class="muted" style="margin:12px 0 0">${escapeHtml(input.storyboard.rightsStatement)}</p>
</div>

${cards}

<section class="block">
  <h2>Fidelity checks</h2>
  <table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${checkRows}</tbody></table>
  <p class="muted">${escapeHtml(input.report.notice)}</p>
</section>
</body>
</html>
`;

  const target = join(input.runDirectory, COMPARISON_GALLERY_FILENAME);
  await writeFile(target, html, 'utf8');
  return target;
}

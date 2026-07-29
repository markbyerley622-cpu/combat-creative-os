import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MotionCheck, SceneMotionInspection } from './motion-inspection';
import type { MotionGateReport, SceneGateRow } from './motion-review-gate';
import type { MotionReviewDecision } from './motion-review-contracts';

/**
 * The page a reviewer actually looks at before deciding.
 *
 * One row per scene: the authoritative keyframe beside five frames taken from
 * the clip across the interval the cut will use, every measurement that was
 * taken, the prompt and the constraints it carries, the checksum, the current
 * approval state and whatever the last reviewer wrote.
 *
 * Putting the keyframe and the clip's own first frame next to each other is
 * the whole point. The layout-agreement number says the two compositions
 * disagree; only the two pictures say *how*, and a reviewer approving despite
 * a finding should be looking at the thing they are accepting.
 *
 * No script, no network request, no external stylesheet — the page opens from
 * the filesystem with nothing running. Every string that came from a manifest,
 * a prompt or a person is escaped.
 */

export const MOTION_REVIEW_GALLERY_FILENAME = 'motion-review-gallery.html';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATUS_TONE: Readonly<Record<string, string>> = {
  APPROVED: 'ok',
  REJECTED: 'bad',
  NOT_REVIEWED: 'wait',
  APPROVAL_SUPERSEDED_BY_CHANGE: 'wait',
  TECHNICALLY_INVALID: 'bad',
  MISSING_SOURCE: 'bad',
};

export interface WriteMotionReviewGalleryInput {
  readonly reviewDirectory: string;
  /** Where the inspection frames sit, relative to the review directory. */
  readonly framesSubdirectory: string;
  readonly storyboardId: string;
  readonly inspections: readonly SceneMotionInspection[];
  readonly gate: MotionGateReport;
  readonly decisionsByScene: ReadonlyMap<number, readonly MotionReviewDecision[]>;
  readonly generatedAt: string;
}

export async function writeMotionReviewGallery(
  input: WriteMotionReviewGalleryInput,
): Promise<string> {
  const rowsByScene = new Map(input.gate.rows.map((row) => [row.sceneNumber, row]));
  const sections = [...input.inspections]
    .sort((a, b) => a.sceneNumber - b.sceneNumber)
    .map((inspection) =>
      renderScene(
        inspection,
        rowsByScene.get(inspection.sceneNumber),
        input.decisionsByScene.get(inspection.sceneNumber) ?? [],
        input.framesSubdirectory,
      ),
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Motion review — ${escapeHtml(input.storyboardId)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0c0e; color: #e8e8ea;
         font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { padding: 28px 32px 20px; border-bottom: 1px solid #22242a; }
  h1 { margin: 0 0 6px; font-size: 20px; letter-spacing: .2px; }
  .sub { color: #9aa0aa; font-size: 13px; max-width: 90ch; }
  .notice { margin: 14px 0 0; padding: 12px 14px; border-left: 3px solid #6b5cff;
            background: #14151a; color: #c9ccd4; max-width: 100ch; font-size: 13px; }
  section { padding: 26px 32px; border-bottom: 1px solid #1a1c21; }
  h2 { margin: 0 0 4px; font-size: 16px; }
  .role { color: #8b919b; font-size: 12px; text-transform: uppercase; letter-spacing: .8px; }
  .pill { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11px;
          font-weight: 600; letter-spacing: .4px; margin-left: 8px; vertical-align: 2px; }
  .ok   { background: #10331f; color: #6ee7a0; }
  .bad  { background: #3a1418; color: #ff8c9b; }
  .wait { background: #33290f; color: #ffcf70; }
  .strip { display: flex; gap: 10px; margin: 16px 0; flex-wrap: wrap; overflow-x: auto; }
  figure { margin: 0; }
  figure img { display: block; width: 132px; height: auto; border: 1px solid #26282f; border-radius: 4px; background: #000; }
  figcaption { margin-top: 5px; font-size: 11px; color: #8b919b; letter-spacing: .3px; }
  .authoritative img { border-color: #6b5cff; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  td, th { text-align: left; padding: 5px 8px; border-bottom: 1px solid #1c1e24; vertical-align: top; }
  th { color: #8b919b; font-weight: 500; width: 40%; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #b9c0cc; }
  .checks td:first-child { width: 46%; }
  .s-PASS { color: #6ee7a0; } .s-FAIL { color: #ff8c9b; }
  .s-NOT_MEASURED { color: #ffcf70; } .s-NOT_APPLICABLE { color: #7b818b; }
  .prompt { white-space: pre-wrap; background: #101116; border: 1px solid #1e2027; border-radius: 5px;
            padding: 11px 13px; color: #c2c7d0; font-size: 12.5px; max-height: 230px; overflow: auto; }
  .constraint { margin: 6px 0 0; padding: 8px 11px; background: #1a1410; border-left: 3px solid #b8791f;
                color: #e3c898; font-size: 12.5px; }
  .remedy { margin-top: 10px; padding: 10px 12px; background: #16171d; border-left: 3px solid #ff8c9b;
            color: #d8b6bc; font-size: 12.5px; }
  .decision { margin-top: 8px; padding: 8px 11px; background: #101116; border: 1px solid #1e2027;
              border-radius: 5px; font-size: 12.5px; color: #b9c0cc; }
  footer { padding: 22px 32px 40px; color: #6f757f; font-size: 12px; max-width: 100ch; }
</style>
</head>
<body>
<header>
  <h1>Motion review — ${escapeHtml(input.storyboardId)}</h1>
  <div class="sub">Generated ${escapeHtml(input.generatedAt)}. ${input.inspections.length} moving scene(s) inspected locally. No provider was constructed, no API key was read and nothing was spent producing this page.</div>
  <p class="notice">${escapeHtml(input.gate.notice)}</p>
</header>
${sections}
<footer>
  Every frame on this page was decoded from the clip on this machine. The authoritative keyframe is shown at delivery framing — scaled to cover 1080&times;1920 and centre-cropped — because that is the picture the cut will actually carry, and a comparison against the uncropped container would agree with a composition that never reaches the screen.
</footer>
</body>
</html>
`;

  const path = join(input.reviewDirectory, MOTION_REVIEW_GALLERY_FILENAME);
  await writeFile(path, html, 'utf8');
  return path;
}

function renderScene(
  inspection: SceneMotionInspection,
  row: SceneGateRow | undefined,
  decisions: readonly MotionReviewDecision[],
  framesSubdirectory: string,
): string {
  const status = row?.status ?? 'NOT_REVIEWED';
  const tone = STATUS_TONE[status] ?? 'wait';
  const frameSrc = (fileName: string): string =>
    escapeHtml(`${framesSubdirectory}/${fileName}`.replace(/\\/g, '/'));

  const keyframeFigure = inspection.keyframePreviewFileName
    ? `<figure class="authoritative"><img src="${frameSrc(inspection.keyframePreviewFileName)}" alt="authoritative keyframe"><figcaption>AUTHORITATIVE<br>${escapeHtml(inspection.keyframeAgreement?.keyframeId ?? 'keyframe')}</figcaption></figure>`
    : '';

  const clipFigures = inspection.frames
    .map(
      (frame) =>
        `<figure><img src="${frameSrc(frame.fileName)}" alt="${escapeHtml(frame.label)} frame"><figcaption>${escapeHtml(frame.label)}<br>${frame.atSeconds.toFixed(2)}s</figcaption></figure>`,
    )
    .join('');

  const measurementRows = [
    ['Source', `${inspection.sourceType} — ${escapeHtml(inspection.sourceIdentifier)}`],
    ['Provider identity', escapeHtml(inspection.generationProvenance ?? 'not a generated source')],
    ['Clip', `<code>${escapeHtml(inspection.clipFileName)}</code>`],
    ['Checksum (sha256)', `<code>${escapeHtml(inspection.clipChecksumSha256 || 'none')}</code>`],
    [
      'Resolution',
      inspection.measured.widthPx
        ? `${inspection.measured.widthPx}&times;${inspection.measured.heightPx}`
        : 'not measured',
    ],
    [
      'Frame rate',
      inspection.measured.frameRate
        ? `${inspection.measured.frameRate.toFixed(3)} fps`
        : 'not measured',
    ],
    [
      'Duration',
      inspection.measured.durationSeconds
        ? `${inspection.measured.durationSeconds.toFixed(3)}s`
        : 'not measured',
    ],
    [
      'Codec / pixel format',
      `${escapeHtml(inspection.measured.videoCodec ?? '—')} / ${escapeHtml(inspection.measured.pixelFormat ?? '—')}`,
    ],
    [
      'Interval the cut takes',
      `${inspection.editInterval.outputStartSeconds.toFixed(2)}–${inspection.editInterval.outputEndSeconds.toFixed(2)}s of the master; ${inspection.editInterval.requiredSourceSeconds.toFixed(3)}s of source`,
    ],
    [
      'Motion energy',
      inspection.motion.measuredEnergy === null
        ? 'not measured'
        : `${inspection.motion.measuredEnergy.toFixed(4)} against a floor of ${inspection.motion.floor} for ${escapeHtml(inspection.motion.declaredCameraMotion)}`,
    ],
    [
      'Keyframe layout agreement',
      inspection.keyframeAgreement
        ? inspection.keyframeAgreement.measuredAgreement === null
          ? 'not measured'
          : `${inspection.keyframeAgreement.measuredAgreement.toFixed(4)} against a floor of ${inspection.keyframeAgreement.floor}`
        : 'not applicable — this source was never animated from a keyframe',
    ],
    [
      'Black / freeze regions',
      `${inspection.blackRegions.length} black, ${inspection.freezeRegions.length} frozen`,
    ],
  ]
    .map(([label, value]) => `<tr><th>${escapeHtml(String(label))}</th><td>${value}</td></tr>`)
    .join('');

  const checkRows = inspection.checks
    .map(
      (check: MotionCheck) =>
        `<tr><td><code>${escapeHtml(check.id)}</code><br><span class="role">${escapeHtml(check.tier)}</span></td>` +
        `<td class="s-${escapeHtml(check.status)}">${escapeHtml(check.status)}</td>` +
        `<td>${escapeHtml(check.observed ?? check.notMeasuredReason ?? '—')}<br><span class="role">expected: ${escapeHtml(check.expected)}</span></td></tr>`,
    )
    .join('');

  const constraints = inspection.negativeConstraints
    .map((constraint) => `<p class="constraint">${escapeHtml(constraint)}</p>`)
    .join('');

  const history = decisions
    .map(
      (decision) =>
        `<div class="decision"><strong>${escapeHtml(decision.verdict)}</strong> — ${escapeHtml(decision.reviewer)}, ${escapeHtml(decision.recordedAt)}<br>${escapeHtml(decision.feedback)}` +
        (decision.acknowledgedFindings.length > 0
          ? `<br><span class="role">acknowledged: ${escapeHtml(decision.acknowledgedFindings.join(', '))}</span>`
          : '') +
        (decision.supersedesDecisionId
          ? `<br><span class="role">supersedes ${escapeHtml(decision.supersedesDecisionId.slice(0, 12))}… — ${escapeHtml(decision.supersedesReason ?? '')}</span>`
          : '') +
        `</div>`,
    )
    .join('');

  return `<section>
  <div class="role">Scene ${inspection.sceneNumber} · ${escapeHtml(inspection.sceneRole)}</div>
  <h2>${escapeHtml(inspection.sourceType)}<span class="pill ${tone}">${escapeHtml(status)}</span></h2>
  <div class="strip">${keyframeFigure}${clipFigures}</div>
  <div class="cols">
    <div>
      <table>${measurementRows}</table>
    </div>
    <div>
      <table class="checks"><tr><th>Check</th><th>Status</th><th>Observed</th></tr>${checkRows}</table>
    </div>
  </div>
  <h3 style="font-size:13px;margin:18px 0 6px;color:#8b919b;">Prompt as submitted</h3>
  <div class="prompt">${escapeHtml(inspection.motionPrompt)}</div>
  ${constraints}
  ${row && row.remedy ? `<div class="remedy">${escapeHtml(row.remedy)}</div>` : ''}
  ${history ? `<h3 style="font-size:13px;margin:18px 0 6px;color:#8b919b;">Recorded human decisions</h3>${history}` : '<div class="decision">No decision has ever been recorded for this scene.</div>'}
</section>`;
}

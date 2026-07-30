import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MotionCheck } from '../storyboard-video/motion-inspection';
import type { RawClipSurvey } from './raw-clip-inspection';
import type { VisualDefectReport } from './visual-defects';

/**
 * The page a reviewer looks at before deciding anything.
 *
 * Three columns, in the order the question is actually asked: the approved
 * plate, the raw generated clip, and the composited review cut. Putting them
 * side by side is the point — a layout-agreement number says two compositions
 * disagree, only the two pictures say how, and a reviewer ruling on whether
 * the model changed a face should be looking at both faces.
 *
 * No script, no network request, no external stylesheet: the page opens from
 * the filesystem with nothing running. Every string that came from a brief, a
 * prompt or a person is escaped. Media is referenced by relative path so the
 * whole run directory can be moved or zipped and still open.
 */

export const COMPARISON_GALLERY_FILENAME = 'scene-01-comparison.html';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ComparisonGalleryInput {
  readonly runDirectory: string;
  readonly plateRelativePath: string;
  readonly rawClipRelativePath: string;
  readonly compositedClipRelativePath: string | null;
  readonly framesRelativeDirectory: string;
  readonly survey: RawClipSurvey;
  readonly checks: readonly MotionCheck[];
  readonly defects: VisualDefectReport;
  readonly headline: string;
  readonly motionPrompt: string;
  readonly reviewStatus: string;
  readonly generatedAt: string;
  readonly costNote: string;
}

export async function writeComparisonGallery(input: ComparisonGalleryInput): Promise<string> {
  const frames = input.survey.frames
    .map(
      (frame) =>
        `<figure><img src="${escapeHtml(`${input.framesRelativeDirectory}/${frame.fileName}`)}" alt="raw frame ${frame.index}"><figcaption>${frame.atSeconds.toFixed(3)}s</figcaption></figure>`,
    )
    .join('\n');

  const checkRows = input.checks
    .map(
      (check) => `<tr class="${escapeHtml(check.status.toLowerCase())}">
  <td>${escapeHtml(check.id)}</td>
  <td>${escapeHtml(check.tier)}</td>
  <td>${escapeHtml(check.status)}</td>
  <td>${escapeHtml(check.expected)}</td>
  <td>${escapeHtml(check.observed ?? check.notMeasuredReason ?? '—')}</td>
</tr>`,
    )
    .join('\n');

  const observationRows = input.defects.observations
    .map(
      (observation) => `<tr class="${escapeHtml(observation.status.toLowerCase())}">
  <td>${escapeHtml(observation.id)}</td>
  <td>${escapeHtml(observation.status)}</td>
  <td>${escapeHtml(observation.what)}</td>
  <td>${escapeHtml(observation.finding)}</td>
</tr>`,
    )
    .join('\n');

  const composited = input.compositedClipRelativePath
    ? `<video controls preload="metadata" src="${escapeHtml(input.compositedClipRelativePath)}"></video>
       <p class="cap">Notification composited <strong>after</strong> generation. LTX never saw a card, a mark or lettering.</p>`
    : `<p class="cap warn">No composited cut was produced — the raw clip did not reach the compositing stage.</p>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scene 1 — LTX acceptance comparison</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #0b0b0c; color: #ececec;
         font: 15px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .01em; }
  h2 { font-size: 16px; margin: 36px 0 12px; color: #cfcfd2; }
  .sub { color: #8d8d93; margin: 0 0 28px; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
  .col { background: #141416; border: 1px solid #232327; border-radius: 10px; padding: 14px; }
  .col h3 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase;
            letter-spacing: .08em; color: #9a9aa1; }
  img, video { width: 100%; height: auto; display: block; border-radius: 6px; background: #000; }
  .cap { color: #8d8d93; font-size: 13px; margin: 10px 0 0; }
  .warn { color: #e8a33d; }
  .strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  figure { margin: 0; }
  figcaption { color: #8d8d93; font-size: 12px; margin-top: 4px; text-align: center; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; min-width: 720px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #232327; vertical-align: top; }
  th { color: #9a9aa1; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: .06em; }
  tr.pass td:nth-child(3), tr.observed td:nth-child(2) { color: #5fbf7f; }
  tr.fail td:nth-child(3), tr.defect td:nth-child(2) { color: #e8695f; }
  tr.not_measured td:nth-child(3), tr.not_measured td:nth-child(2),
  tr.human_judgement_required td:nth-child(2) { color: #e8a33d; }
  tr.not_applicable td:nth-child(3), tr.not_applicable td:nth-child(2) { color: #8d8d93; }
  .notice { margin-top: 36px; padding: 14px 16px; border: 1px solid #3a2f14;
            background: #191408; border-radius: 8px; color: #e8c98a; font-size: 13px; }
  pre { white-space: pre-wrap; background: #141416; border: 1px solid #232327;
        border-radius: 8px; padding: 14px; font-size: 13px; color: #cfcfd2; }
</style>
</head>
<body>
<h1>Scene 1 — LTX acceptance comparison</h1>
<p class="sub">Generated ${escapeHtml(input.generatedAt)} · review status <strong>${escapeHtml(input.reviewStatus)}</strong> · ${escapeHtml(input.costNote)}</p>

<div class="cols">
  <div class="col">
    <h3>1 · Authoritative plate</h3>
    <img src="${escapeHtml(input.plateRelativePath)}" alt="the approved Scene-1 plate">
    <p class="cap">The operator's high-quality FRAME-01 plate, staged read-only and verified by checksum.</p>
  </div>
  <div class="col">
    <h3>2 · Raw LTX output</h3>
    <video controls preload="metadata" src="${escapeHtml(input.rawClipRelativePath)}"></video>
    <p class="cap">Exactly as it arrived from the provider. Nothing trimmed, graded or overlaid.</p>
  </div>
  <div class="col">
    <h3>3 · Composited review cut</h3>
    ${composited}
  </div>
</div>

<h2>Raw clip — six evenly spaced frames</h2>
<div class="strip">
${frames}
</div>
<p class="cap">Contact sheet: <code>${escapeHtml(`${input.framesRelativeDirectory}/${input.survey.contactSheetFileName}`)}</code></p>

<h2>Technical inspection</h2>
<div class="scroll">
<table>
<thead><tr><th>Check</th><th>Tier</th><th>Status</th><th>Expected</th><th>Observed</th></tr></thead>
<tbody>
${checkRows}
</tbody>
</table>
</div>

<h2>Visual observations</h2>
<div class="scroll">
<table>
<thead><tr><th>Observation</th><th>Status</th><th>What was asked</th><th>Finding</th></tr></thead>
<tbody>
${observationRows}
</tbody>
</table>
</div>

<h2>Submitted prompt</h2>
<pre>${escapeHtml(input.motionPrompt)}</pre>

<div class="notice">
  ${escapeHtml(input.defects.notice)}
</div>
</body>
</html>
`;

  const target = join(input.runDirectory, COMPARISON_GALLERY_FILENAME);
  await writeFile(target, html, 'utf8');
  return target;
}

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NotificationBrief } from './acceptance-brief';
import type { NotificationDefectReport } from './notification-defects';
import type { PlacementReport } from './notification-placement';
import { escapeHtml } from './notification-surface';
import type { NotificationTimeline } from './notification-timeline';

/**
 * The page a reviewer looks at before deciding whether the new treatment is
 * better than the one it replaces.
 *
 * The comparison is deliberately the first thing on it. A proof shown on its
 * own is judged against whatever the reader was imagining; shown beside the cut
 * it replaces, it is judged against the thing that actually existed, which is
 * the only comparison that decides anything. When the previous cut cannot be
 * read the column says so rather than disappearing — a missing column reads as
 * "there was nothing before", which would be untrue.
 *
 * No script, no network request, no external stylesheet: the page opens from
 * the filesystem with nothing running. Every string that came from the brief is
 * escaped. Media is referenced by relative path so the whole run directory can
 * be moved or zipped and still open.
 */

export const NOTIFICATION_COMPARISON_GALLERY_FILENAME = 'notification-comparison.html';

export interface NotificationGalleryFrame {
  readonly atSeconds: number;
  readonly relativePath: string;
}

export interface NotificationComparisonGalleryInput {
  readonly runDirectory: string;
  readonly proofRelativePath: string;
  readonly surfaceAssetRelativePath: string;
  readonly previousRelativePath: string | null;
  readonly frames: readonly NotificationGalleryFrame[];
  readonly brief: NotificationBrief;
  readonly timeline: NotificationTimeline;
  readonly placement: PlacementReport;
  readonly defects: NotificationDefectReport;
  readonly generatedAt: string;
}

export async function writeNotificationComparisonGallery(
  input: NotificationComparisonGalleryInput,
): Promise<string> {
  const frames = input.frames
    .map(
      (frame) =>
        `<figure><img src="${escapeHtml(frame.relativePath)}" alt="proof frame at ${frame.atSeconds.toFixed(2)} seconds"><figcaption>${frame.atSeconds.toFixed(2)}s</figcaption></figure>`,
    )
    .join('\n');

  const stateRows = input.timeline.states
    .map(
      (state) => `<tr>
  <td>${escapeHtml(state.id)}</td>
  <td>${escapeHtml(state.kind)}</td>
  <td>${state.fromSeconds.toFixed(3)}–${state.toSeconds.toFixed(3)}s</td>
  <td>${state.scale.toFixed(4)}</td>
  <td>${state.riseRemainingPx.toFixed(2)}px</td>
  <td>${state.accentOpacity.toFixed(3)}</td>
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

  const previous = input.previousRelativePath
    ? `<video controls preload="metadata" src="${escapeHtml(input.previousRelativePath)}"></video>
       <p class="cap">The prototype: a filled rectangle drawn by <code>drawbox</code> with one line of subtitle type over it. No corner radius, no translucency, no shadow, no mark beside the type, no supporting line.</p>`
    : `<p class="cap warn">The previous treatment's cut could not be read, so it is not shown. It existed; this column is missing evidence, not evidence of absence.</p>`;

  const placementSummary =
    input.placement.notMeasuredReason !== null
      ? `<p class="cap warn">Placement could not be measured: ${escapeHtml(input.placement.notMeasuredReason)}</p>`
      : `<table>
<tbody>
<tr><th>Frames measured</th><td>${input.placement.frameCount}</td></tr>
<tr><th>Frames overlapping subject content</th><td>${input.placement.framesOverlappingSubjectContent}</td></tr>
<tr><th>Treatment occupies</th><td>${input.placement.treatmentOccupiedRect.xPx},${input.placement.treatmentOccupiedRect.yPx} ${input.placement.treatmentOccupiedRect.widthPx}×${input.placement.treatmentOccupiedRect.heightPx}px</td></tr>
<tr><th>Worst clearance above</th><td>${input.placement.worstClearanceAbovePx}px</td></tr>
<tr><th>Worst clearance below</th><td>${input.placement.worstClearanceBelowPx}px</td></tr>
<tr><th>Brightest pixel under the treatment</th><td>${input.placement.maxLumaUnderTreatmentPx} (subject-content threshold ${input.placement.subjectContentLumaThreshold})</td></tr>
</tbody>
</table>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scene 1 — notification treatment comparison</title>
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
  .checker { background-color: #202024;
             background-image: linear-gradient(45deg, #2c2c31 25%, transparent 25%),
                               linear-gradient(-45deg, #2c2c31 25%, transparent 25%),
                               linear-gradient(45deg, transparent 75%, #2c2c31 75%),
                               linear-gradient(-45deg, transparent 75%, #2c2c31 75%);
             background-size: 16px 16px;
             background-position: 0 0, 0 8px, 8px -8px, -8px 0; padding: 10px; border-radius: 6px; }
  .checker img { background: transparent; border-radius: 0; }
  .cap { color: #8d8d93; font-size: 13px; margin: 10px 0 0; }
  .warn { color: #e8a33d; }
  .strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  figure { margin: 0; }
  figcaption { color: #8d8d93; font-size: 12px; margin-top: 4px; text-align: center; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  .scroll table { min-width: 720px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #232327; vertical-align: top; }
  th { color: #9a9aa1; font-weight: 600; }
  thead th { text-transform: uppercase; font-size: 11px; letter-spacing: .06em; }
  tr.observed td:nth-child(2) { color: #5fbf7f; }
  tr.defect td:nth-child(2) { color: #e8695f; }
  tr.not_measured td:nth-child(2), tr.human_judgement_required td:nth-child(2) { color: #e8a33d; }
  tr.not_applicable td:nth-child(2) { color: #8d8d93; }
  .notice { margin-top: 36px; padding: 14px 16px; border: 1px solid #3a2f14;
            background: #191408; border-radius: 8px; color: #e8c98a; font-size: 13px; }
</style>
</head>
<body>
<h1>Scene 1 — notification treatment comparison</h1>
<p class="sub">Generated ${escapeHtml(input.generatedAt)} · zero cost, no provider constructed, no request made · ${input.defects.measuredDefectCount} measured defect(s), ${input.defects.notMeasuredCount} unmeasurable row(s), ${input.defects.openHumanJudgementCount} question(s) open for a person</p>

<div class="cols">
  <div class="col">
    <h3>1 · New treatment</h3>
    <video controls preload="metadata" src="${escapeHtml(input.proofRelativePath)}"></video>
    <p class="cap">A laid-out surface — mark, header, timestamp, headline, supporting line, accent edge — rasterised to transparent pixels and composited as one assembled unit.</p>
  </div>
  <div class="col">
    <h3>2 · Previous treatment</h3>
    ${previous}
  </div>
  <div class="col">
    <h3>3 · The transparent asset</h3>
    <div class="checker"><img src="${escapeHtml(input.surfaceAssetRelativePath)}" alt="the notification surface on a transparency checkerboard"></div>
    <p class="cap">The resting card and its shadow, cropped out of the same document the proof plays. The checkerboard is the page's, not the asset's.</p>
  </div>
</div>

<h2>The moments the specification asks for</h2>
<div class="strip">
${frames}
</div>

<h2>Placement, measured against the picture underneath</h2>
${placementSummary}
<p class="cap">${escapeHtml(input.placement.notice)}</p>

<h2>The animation, state by state</h2>
<div class="scroll">
<table>
<thead><tr><th>State</th><th>Kind</th><th>Window</th><th>Scale</th><th>Rise remaining</th><th>Accent opacity</th></tr></thead>
<tbody>
${stateRows}
</tbody>
</table>
</div>
<p class="cap">Easing ${escapeHtml(input.brief.entranceEasing)}, rising ${input.brief.entranceRisePx}px from ${input.brief.entranceStartScale}× scale. Every state is a complete card; the entrance transforms a finished surface rather than assembling one.</p>

<h2>Visible defects</h2>
<div class="scroll">
<table>
<thead><tr><th>Observation</th><th>Status</th><th>What was asked</th><th>Finding</th></tr></thead>
<tbody>
${observationRows}
</tbody>
</table>
</div>

<div class="notice">
  ${escapeHtml(input.defects.notice)}
</div>
</body>
</html>
`;

  const target = join(input.runDirectory, NOTIFICATION_COMPARISON_GALLERY_FILENAME);
  await writeFile(target, html, 'utf8');
  return target;
}

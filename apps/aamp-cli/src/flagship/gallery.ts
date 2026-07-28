import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { num, type CommandRunner, type FfmpegBinaries } from '@combat/media';

import type { BeatReconciliationRow } from './asset-reconciliation';
import type { AgencyScorecard } from './agency-scorecard';

/**
 * The review gallery: frames pulled from the finished master, beside the
 * reconciliation that decided what each beat would carry.
 *
 * Deliberately *not* a storyboard-versus-render comparison sheet. Putting a
 * storyboard frame next to a rendered frame would mean copying reference
 * pixels into an artefact this run produced, and the whole milestone rests on
 * those pixels never leaving the package. The comparison is expressed the only
 * honest way available: the storyboard's frame id, its stated intent and what
 * was actually built, in words, beside the frame the render produced.
 *
 * The page makes no network request, runs no script, and escapes every string
 * that came from a manifest, a licence or a person.
 */

export const GALLERY_FILENAME = 'flagship-gallery.html';
export const GALLERY_FRAME_DIRECTORY = 'gallery-frames';
export const GALLERY_CONTACT_SHEET = 'flagship-contact-sheet.png';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface GalleryFrame {
  readonly beatId: string;
  readonly label: string;
  readonly atSeconds: number;
  readonly fileName: string;
}

/**
 * Samples one frame per beat from the finished master, at the midpoint of each
 * beat so a transition never stands in for the shot it transitions into.
 */
export async function extractGalleryFrames(input: {
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly runDirectory: string;
  readonly masterPath: string;
  readonly beats: readonly {
    readonly beatId: string;
    readonly label: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
  }[];
}): Promise<{ frames: readonly GalleryFrame[]; contactSheet: string | null; problem?: string }> {
  const frameDirectory = join(input.runDirectory, GALLERY_FRAME_DIRECTORY);
  await mkdir(frameDirectory, { recursive: true });

  const frames: GalleryFrame[] = [];
  for (const [index, beat] of input.beats.entries()) {
    const atSeconds = Number(((beat.startSeconds + beat.endSeconds) / 2).toFixed(3));
    const fileName = `${GALLERY_FRAME_DIRECTORY}/${String(index + 1).padStart(2, '0')}-${beat.beatId}.png`;
    const target = join(input.runDirectory, fileName);
    // eslint-disable-next-line no-await-in-loop -- sequential keeps the frame list ordered and the disk quiet
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
        target,
      ],
      { timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) {
      return { frames, contactSheet: null, problem: `frame at ${atSeconds}s could not be sampled` };
    }
    frames.push({ beatId: beat.beatId, label: beat.label, atSeconds, fileName });
  }

  // One tiled sheet of the whole cut. Built from uniformly-sized intermediates
  // because FFmpeg's image sequence reader refuses a run whose frames differ.
  const tileInputs = join(frameDirectory, 'tile-%03d.png');
  for (const [index, frame] of frames.entries()) {
    // eslint-disable-next-line no-await-in-loop -- as above
    await input.runner.run(
      input.binaries.ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        join(input.runDirectory, frame.fileName),
        '-vf',
        'scale=270:480,format=rgb24',
        '-pix_fmt',
        'rgb24',
        '-y',
        join(frameDirectory, `tile-${String(index + 1).padStart(3, '0')}.png`),
      ],
      { timeoutMs: 60_000 },
    );
  }

  const sheet = await input.runner.run(
    input.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      tileInputs,
      '-filter_complex',
      `tile=4x2:padding=8:color=${'0x1A1A20'}`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-y',
      join(input.runDirectory, GALLERY_CONTACT_SHEET),
    ],
    { timeoutMs: 120_000 },
  );

  return {
    frames,
    contactSheet: sheet.exitCode === 0 ? GALLERY_CONTACT_SHEET : null,
    ...(sheet.exitCode === 0 ? {} : { problem: 'the contact sheet could not be tiled' }),
  };
}

export interface WriteGalleryInput {
  readonly runDirectory: string;
  readonly campaignName: string;
  readonly masterPath: string;
  readonly masterChecksumSha256: string | null;
  readonly measured: {
    readonly widthPx: number | null;
    readonly heightPx: number | null;
    readonly durationSeconds: number | null;
    readonly videoCodec: string | null;
    readonly audioCodec: string | null;
    readonly pixelFormat: string | null;
  };
  readonly qaVerdict: string;
  readonly frames: readonly GalleryFrame[];
  readonly contactSheet: string | null;
  readonly rows: readonly BeatReconciliationRow[];
  readonly scorecard: AgencyScorecard;
  readonly executionMode: string;
  readonly outputUse: string;
}

/** Writes the review page. No script, no network, every third-party string escaped. */
export async function writeGallery(input: WriteGalleryInput): Promise<string> {
  const framesByBeat = new Map(input.frames.map((frame) => [frame.beatId, frame]));

  const beatCards = input.rows
    .map((row) => {
      const frame = framesByBeat.get(row.beatId);
      const image = frame
        ? `<img src="${escapeHtml(frame.fileName)}" alt="rendered frame for beat ${escapeHtml(row.beatId)}" />`
        : '<div class="noframe">no frame sampled</div>';
      const limitations =
        row.factualLimitations.length > 0
          ? `<dt>Factual limits</dt><dd><ul>${row.factualLimitations
              .map((limitation) => `<li>${escapeHtml(limitation)}</li>`)
              .join('')}</ul></dd>`
          : '';
      const substitution = row.substitutionReason
        ? `<dt>Substitution</dt><dd>${escapeHtml(row.substitutionReason)}</dd>`
        : '<dt>Substitution</dt><dd class="muted">none — built as storyboarded</dd>';
      const gap = row.unresolvedGap
        ? `<dt class="warn">Unresolved gap</dt><dd class="warn">${escapeHtml(row.unresolvedGap)}</dd>`
        : '';
      return `
      <section class="beat">
        <div class="shot">${image}</div>
        <div class="meta">
          <h2><span class="idx">${escapeHtml(row.storyboardFrameId)}</span> ${escapeHtml(row.beatId)}
            <span class="muted">${row.slotStartSeconds.toFixed(2)}s &rarr; ${row.slotEndSeconds.toFixed(2)}s</span></h2>
          <p class="role">${escapeHtml(row.productionRole)}</p>
          <dl>
            <dt>Storyboard asked for</dt><dd>${escapeHtml(row.requiredAsset)}</dd>
            <dt>Selected</dt><dd><code>${escapeHtml(row.selectedAssetId)}</code> &mdash; ${escapeHtml(row.selectedRelativePath)}</dd>
            <dt>Source root</dt><dd>${escapeHtml(row.sourceRootLabel)}</dd>
            <dt>Checksum</dt><dd><code>${escapeHtml(row.checksumSha256.slice(0, 16))}&hellip;</code></dd>
            <dt>Rights</dt><dd>${escapeHtml(row.rightsState)} &mdash; output eligible: ${row.outputEligible}</dd>
            <dt>Provenance</dt><dd>${escapeHtml(row.provenanceState)}</dd>
            ${substitution}
            ${limitations}
            ${gap}
            <dt>Also considered</dt><dd class="muted">${
              row.discoveredCandidateIds.length > 0
                ? escapeHtml(row.discoveredCandidateIds.join(', '))
                : 'nothing else of this kind was discovered in any declared pack'
            }</dd>
          </dl>
        </div>
      </section>`;
    })
    .join('');

  const scoreRows = input.scorecard.dimensions
    .map(
      (dimension) => `
      <tr class="${dimension.verdict === 'MEASURED' ? 'measured' : 'human'}">
        <td>${escapeHtml(dimension.label)}</td>
        <td class="num">${dimension.maxPoints}</td>
        <td class="num">${
          dimension.awardedPoints === null
            ? '<span class="muted">—</span>'
            : String(dimension.awardedPoints)
        }</td>
        <td>${escapeHtml(dimension.verdict)}</td>
        <td class="basis">${escapeHtml(dimension.basis)}</td>
      </tr>`,
    )
    .join('');

  const defects = input.scorecard.blockingDefects
    .map(
      (defect) =>
        `<li><strong>${escapeHtml(defect.code)}</strong> — ${escapeHtml(defect.summary)} <em>Remedy: ${escapeHtml(defect.remedy)}</em></li>`,
    )
    .join('');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(input.campaignName)} — flagship review</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #0B0B0F; color: #EDEDF2;
         font: 15px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -0.01em; }
  h2 { font-size: 18px; margin: 0 0 8px; font-weight: 650; }
  .idx { display: inline-block; background: #FF3B30; color: #fff; border-radius: 5px;
         padding: 1px 8px; font-size: 12px; letter-spacing: .06em; margin-right: 8px; vertical-align: middle; }
  .muted { color: #8A8A99; font-weight: 400; }
  .warn { color: #FFB020; }
  .banner { border: 1px solid #34343F; border-left: 4px solid #FF3B30; border-radius: 8px;
            padding: 14px 18px; margin: 20px 0 28px; background: #131319; }
  .facts { display: flex; flex-wrap: wrap; gap: 10px 28px; margin: 0; padding: 0; list-style: none; }
  .facts li { font-size: 14px; }
  .facts b { color: #8A8A99; font-weight: 500; }
  .beat { display: grid; grid-template-columns: 300px 1fr; gap: 24px; align-items: start;
          border-top: 1px solid #22222B; padding: 24px 0; }
  .shot img { width: 100%; border-radius: 10px; display: block; background: #000; }
  .noframe { aspect-ratio: 9/16; display: grid; place-items: center; border-radius: 10px;
             background: #16161C; color: #6A6A78; font-size: 13px; }
  .role { color: #B9B9C6; margin: 0 0 12px; font-size: 14px; }
  dl { display: grid; grid-template-columns: 150px 1fr; gap: 5px 16px; margin: 0; font-size: 13.5px; }
  dt { color: #8A8A99; }
  dd { margin: 0; }
  dd ul { margin: 0; padding-left: 18px; }
  code { background: #17171E; padding: 1px 6px; border-radius: 4px; font-size: 12.5px; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; font-size: 13.5px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #22222B; vertical-align: top; }
  th { color: #8A8A99; font-weight: 500; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; width: 64px; }
  tr.human td { color: #9A9AA8; }
  .basis { color: #8A8A99; font-size: 12.5px; }
  .sheet img { width: 100%; border-radius: 10px; display: block; margin-top: 12px; }
  section.block { margin-top: 40px; }
  ul.defects { padding-left: 18px; }
  ul.defects li { margin-bottom: 8px; }
  ul.defects em { color: #8A8A99; font-style: normal; }
  @media (max-width: 820px) { .beat { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>${escapeHtml(input.campaignName)}</h1>
<p class="muted">Flagship review — storyboard-driven, footage-first, zero paid provider calls.</p>

<div class="banner">
  <ul class="facts">
    <li><b>Execution mode</b> ${escapeHtml(input.executionMode)}</li>
    <li><b>Output use</b> ${escapeHtml(input.outputUse)}</li>
    <li><b>Real campaign run</b> false</li>
    <li><b>Paid provider calls</b> 0</li>
    <li><b>Actual-media QA</b> ${escapeHtml(input.qaVerdict)}</li>
    <li><b>Agency grade</b> ${escapeHtml(input.scorecard.agencyGradeClaim)}</li>
  </ul>
  <ul class="facts" style="margin-top:10px">
    <li><b>Master</b> <code>${escapeHtml(basename(input.masterPath))}</code></li>
    <li><b>Measured</b> ${input.measured.widthPx ?? '?'}&times;${input.measured.heightPx ?? '?'},
        ${input.measured.durationSeconds?.toFixed(3) ?? '?'}s,
        ${escapeHtml(input.measured.videoCodec ?? 'none')}/${escapeHtml(input.measured.audioCodec ?? 'none')},
        ${escapeHtml(input.measured.pixelFormat ?? '?')}</li>
    <li><b>Checksum</b> <code>${escapeHtml((input.masterChecksumSha256 ?? 'unknown').slice(0, 16))}&hellip;</code></li>
  </ul>
  <p class="muted" style="margin:12px 0 0">No storyboard frame appears on this page or in the master. The
  storyboard is REFERENCE_ONLY: its intent is quoted in words, never in pixels.</p>
</div>

${
  input.contactSheet
    ? `<section class="sheet"><h2>The cut</h2><img src="${escapeHtml(input.contactSheet)}" alt="contact sheet of the finished cut" /></section>`
    : ''
}

<section class="block"><h2>Beat by beat</h2>${beatCards}</section>

<section class="block">
  <h2>Agency benchmark scorecard</h2>
  <p class="muted">${escapeHtml(input.scorecard.notice)}</p>
  <table>
    <thead><tr><th>Dimension</th><th class="num">Max</th><th class="num">Awarded</th><th>Verdict</th><th>Basis</th></tr></thead>
    <tbody>${scoreRows}</tbody>
  </table>
  <p><strong>Status: ${escapeHtml(input.scorecard.status)}</strong></p>
  ${defects ? `<h2 style="margin-top:24px">Blocking defects</h2><ul class="defects">${defects}</ul>` : ''}
</section>
</body>
</html>
`;

  const target = join(input.runDirectory, GALLERY_FILENAME);
  await writeFile(target, html, 'utf8');
  return target;
}

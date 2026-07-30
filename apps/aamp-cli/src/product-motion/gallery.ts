import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  perspectiveCornerExpressions,
  type CameraMove,
  type CommandRunner,
  type FfmpegBinaries,
  type NormalisedQuad,
} from '@combat/media';

import type { CalibratedScreen } from './calibration';
import {
  PRODUCT_MOTION_LABEL,
  ProductMotionError,
  type ProductMotionPlan,
} from './product-motion-contracts';

/**
 * The comparison gallery: source plate, the calibrated screen area, and the
 * composited result, side by side.
 *
 * It exists because the calibration check can only prove the region is a dark
 * uniform rectangle — it cannot prove the rectangle is the *right* rectangle.
 * A person looking at the overlay beside the finished frame settles that in a
 * second, which is why the overlay is generated on every run rather than only
 * when something looks wrong.
 *
 * No script, no network, no external stylesheet. Images are embedded as data
 * URIs and every string that came from the plan is escaped, so the file can be
 * opened from disk with nothing running.
 */

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

async function dataUri(path: string): Promise<string> {
  const bytes = await readFile(path);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

export interface GalleryRequest {
  readonly plan: ProductMotionPlan;
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly calibration: readonly CalibratedScreen[];
  readonly normalisedQuads: ReadonlyMap<string, NormalisedQuad>;
  readonly cameraMoves: ReadonlyMap<string, CameraMove>;
  readonly platePathFor: (plateId: string) => string;
  readonly uiLayerPath: string;
  readonly outputPath: string;
  readonly galleryDirectory: string;
}

async function run(request: GalleryRequest, args: readonly string[], what: string): Promise<void> {
  const result = await request.runner.run(request.binaries.ffmpeg, args, { timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new ProductMotionError(
      'RENDER_FAILED',
      `could not build gallery asset (${what}): ${result.stderr.slice(-1500)}`,
    );
  }
}

/** A still frame from the finished file. */
async function extractFrame(
  request: GalleryRequest,
  source: string,
  atSeconds: number,
  target: string,
  scaleWidth: number,
): Promise<void> {
  await run(
    request,
    [
      '-y',
      '-ss',
      atSeconds.toFixed(4),
      '-i',
      source,
      '-frames:v',
      '1',
      '-vf',
      `scale=${scaleWidth}:-2:flags=lanczos`,
      target,
    ],
    `frame at ${atSeconds}s`,
  );
}

/**
 * The plate with its declared screen filled and framed.
 *
 * The overlay is produced by the *same* `perspective` call the composite uses,
 * evaluated at the shot's opening zoom, so what a reviewer inspects here is the
 * mapping that actually ran rather than a second drawing of it that could
 * agree today and drift tomorrow.
 */
async function renderScreenOverlay(
  request: GalleryRequest,
  plateId: string,
  target: string,
): Promise<void> {
  const quad = request.normalisedQuads.get(plateId);
  const shot = request.plan.shots.find((candidate) => candidate.plateId === plateId);
  const move = shot ? request.cameraMoves.get(shot.id) : undefined;
  if (!quad || !move) {
    throw new ProductMotionError('INVALID_PLAN', `no resolved camera move for plate "${plateId}"`);
  }

  const { widthPx, heightPx } = request.plan.output;
  // A locked-off reading of the same expressions: the gallery shows the screen
  // where the shot opens, not where it happens to be on some arbitrary frame.
  const still: CameraMove = { ...move, endZoom: move.startZoom, frames: 1 };
  const corners = perspectiveCornerExpressions(quad, still, widthPx, heightPx);
  const warp =
    `perspective=x0='${corners.x0}':y0='${corners.y0}':x1='${corners.x1}':y1='${corners.y1}':` +
    `x2='${corners.x2}':y2='${corners.y2}':x3='${corners.x3}':y3='${corners.y3}':` +
    'sense=destination:eval=init';

  const graph = [
    `[0:v]scale=${widthPx}:${heightPx}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${widthPx}:${heightPx},format=gbrp[plate]`,
    `[1:v]format=gbrp,split=2[card][mask]`,
    `[card]${warp}:interpolation=cubic[cardw]`,
    `[mask]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill,` +
      `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=3,${warp},format=gray[maskw]`,
    `[cardw][maskw]alphamerge[card2]`,
    `[plate][card2]overlay=0:0:format=auto,scale=420:-2,format=yuv420p[out]`,
  ].join(';');

  await run(
    request,
    [
      '-y',
      '-loop',
      '1',
      '-i',
      request.platePathFor(plateId),
      '-f',
      'lavfi',
      '-i',
      `color=c=0xFF00AA:s=${widthPx}x${heightPx}`,
      '-filter_complex',
      graph,
      '-map',
      '[out]',
      '-frames:v',
      '1',
      target,
    ],
    `screen overlay for ${plateId}`,
  );
}

export async function buildComparisonGallery(request: GalleryRequest): Promise<string> {
  const { plan, galleryDirectory } = request;
  const rows: string[] = [];

  // ---- per-plate: source, calibrated screen -------------------------------
  const plateCards: string[] = [];
  for (const plate of plan.plates) {
    const platePng = join(galleryDirectory, `plate-${plate.id}.png`);
    const overlayPng = join(galleryDirectory, `screen-${plate.id}.png`);
    await run(
      request,
      ['-y', '-i', request.platePathFor(plate.id), '-vf', 'scale=420:-2:flags=lanczos', platePng],
      `plate ${plate.id}`,
    );
    await renderScreenOverlay(request, plate.id, overlayPng);

    const calibrated = request.calibration.find((entry) => entry.plateId === plate.id);
    plateCards.push(`
      <section class="card">
        <h3>${escapeHtml(plate.id)}</h3>
        <p class="muted">${escapeHtml(plate.description)}</p>
        <div class="pair">
          <figure><img alt="source plate ${escapeHtml(plate.id)}" src="${await dataUri(platePng)}"><figcaption>source plate</figcaption></figure>
          <figure><img alt="calibrated screen area on ${escapeHtml(plate.id)}" src="${await dataUri(overlayPng)}"><figcaption>calibrated screen area</figcaption></figure>
        </div>
        ${
          calibrated
            ? `<dl class="stats">
                 <dt>interior luma</dt><dd>${calibrated.report.interiorMeanLuma.toFixed(1)}</dd>
                 <dt>interior spread</dt><dd>${calibrated.report.interiorStdDev.toFixed(1)}</dd>
                 <dt>rim contrast</dt><dd>${calibrated.report.rimContrast.toFixed(1)}</dd>
                 <dt>aspect</dt><dd>${calibrated.report.geometry.aspectRatio.toFixed(3)}</dd>
                 <dt>verdict</dt><dd>${escapeHtml(calibrated.report.verdict)}</dd>
               </dl>`
            : ''
        }
      </section>`);
  }
  rows.push(`<h2>Plates and calibrated screens</h2><div class="grid">${plateCards.join('')}</div>`);

  // ---- per-state: the composited output ------------------------------------
  const stateCards: string[] = [];
  for (const state of plan.states) {
    const at = Math.min(
      plan.output.durationSeconds - 1 / plan.output.frameRate,
      state.scroll.endSeconds + (state.endSeconds - state.scroll.endSeconds) / 2,
    );
    const uiPng = join(galleryDirectory, `ui-${state.id}.png`);
    const outPng = join(galleryDirectory, `state-${state.id}.png`);
    await extractFrame(request, request.uiLayerPath, at, uiPng, 240);
    await extractFrame(request, request.outputPath, at, outPng, 300);
    stateCards.push(`
      <section class="card">
        <h3>${escapeHtml(state.state)}</h3>
        <p class="muted">${escapeHtml(state.id)} &middot; ${state.startSeconds.toFixed(2)}s–${state.endSeconds.toFixed(2)}s &middot; frame at ${at.toFixed(2)}s</p>
        <div class="pair">
          <figure><img alt="interface layer at ${escapeHtml(state.id)}" src="${await dataUri(uiPng)}"><figcaption>interface layer</figcaption></figure>
          <figure><img alt="composited output at ${escapeHtml(state.id)}" src="${await dataUri(outPng)}"><figcaption>composited output</figcaption></figure>
        </div>
        <p>${escapeHtml(state.intent)}</p>
      </section>`);
  }
  rows.push(`<h2>Product states</h2><div class="grid">${stateCards.join('')}</div>`);

  // ---- per-cut: the frames either side -------------------------------------
  const cutCards: string[] = [];
  const frameSeconds = 1 / plan.output.frameRate;
  for (const shot of plan.shots.slice(1)) {
    const beforePng = join(galleryDirectory, `cut-${shot.id}-before.png`);
    const afterPng = join(galleryDirectory, `cut-${shot.id}-after.png`);
    await extractFrame(
      request,
      request.outputPath,
      shot.startSeconds - frameSeconds,
      beforePng,
      300,
    );
    await extractFrame(
      request,
      request.outputPath,
      shot.startSeconds + frameSeconds / 2,
      afterPng,
      300,
    );
    cutCards.push(`
      <section class="card">
        <h3>${escapeHtml(shot.transitionIn)}</h3>
        <p class="muted">at ${shot.startSeconds.toFixed(2)}s &middot; into ${escapeHtml(shot.id)}</p>
        <div class="pair">
          <figure><img alt="frame before the cut into ${escapeHtml(shot.id)}" src="${await dataUri(beforePng)}"><figcaption>last frame out</figcaption></figure>
          <figure><img alt="frame after the cut into ${escapeHtml(shot.id)}" src="${await dataUri(afterPng)}"><figcaption>first frame in</figcaption></figure>
        </div>
        <p>${escapeHtml(shot.transitionNote)}</p>
      </section>`);
  }
  rows.push(`<h2>Cuts</h2><div class="grid">${cutCards.join('')}</div>`);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(plan.id)} — ${PRODUCT_MOTION_LABEL}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:32px; background:#0B0B0F; color:#F2F2F5;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size:22px; margin:0 0 6px; letter-spacing:.02em; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.14em; color:#DA0318;
       margin:40px 0 14px; }
  h3 { font-size:14px; margin:0 0 4px; }
  .banner { border:1px solid #DA0318; border-radius:8px; padding:12px 16px; margin:16px 0 8px;
            background:rgba(218,3,24,.08); font-size:13px; line-height:1.55; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:18px; }
  .card { background:#141419; border:1px solid #24242C; border-radius:10px; padding:14px; }
  .pair { display:flex; gap:10px; align-items:flex-start; }
  figure { margin:0; flex:1; }
  img { width:100%; height:auto; display:block; border-radius:6px; background:#000; }
  figcaption { font-size:11px; color:#8A8A96; margin-top:5px; text-transform:uppercase;
               letter-spacing:.08em; }
  p { font-size:12.5px; line-height:1.6; color:#C9C9D2; }
  .muted { color:#8A8A96; font-size:11.5px; }
  .stats { display:grid; grid-template-columns:auto auto; gap:2px 12px; font-size:11.5px;
           margin:10px 0 0; }
  dt { color:#8A8A96; } dd { margin:0; }
</style>
</head>
<body>
<h1>${escapeHtml(plan.id)}</h1>
<p class="muted">${escapeHtml(PRODUCT_MOTION_LABEL)} &middot; authored by ${escapeHtml(plan.authoredBy)}
 &middot; ${plan.output.durationSeconds.toFixed(2)}s &middot; ${plan.output.widthPx}×${plan.output.heightPx} @ ${plan.output.frameRate}fps</p>
<div class="banner">
  <strong>${escapeHtml(PRODUCT_MOTION_LABEL)}.</strong> Not an approved master, not a campaign result,
  not public-release ready. <code>isRealCampaignRun: false</code>, <code>paidProviderCalls: 0</code>.
  Calibration proves each mapped region is a blank, dark, uniform screen — it does not prove the
  placement is creatively right. That is what the overlays below are for.
</div>
${rows.join('\n')}
</body>
</html>
`;

  const galleryPath = join(galleryDirectory, 'comparison-gallery.html');
  await writeFile(galleryPath, html, 'utf8');
  return galleryPath;
}

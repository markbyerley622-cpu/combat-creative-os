import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import type { SceneExposureRecord } from './story-exposure';
import { PRODUCT_STORY_LABEL, type ProductStoryPlan } from './story-contracts';

/**
 * The old-versus-new gallery: ten scenes, both cuts, side by side.
 *
 * A reviewer asked to judge a correction needs the thing it corrected next to
 * it. Every frame is embedded as a data URI so the page is one self-contained
 * file with no server, no script and no local path in it — the same rule the
 * storyboard gallery already follows.
 *
 * Calibration overlays are *deliberately absent*. They belong to a diagnostic
 * view of the plates, and putting a corner marker beside a delivery frame is
 * how a marker ends up in a delivery frame.
 */

export const STORY_GALLERY_FILENAME = 'old-versus-new-gallery.html';

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function frameDataUri(input: {
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly moviePath: string;
  readonly atSeconds: number;
  readonly scratchPath: string;
}): Promise<string | null> {
  const result = await input.runner.run(
    input.binaries.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-ss',
      input.atSeconds.toFixed(3),
      '-i',
      input.moviePath,
      '-vf',
      'scale=270:-2',
      '-frames:v',
      '1',
      '-y',
      input.scratchPath,
    ],
    { timeoutMs: 60_000 },
  );
  if (result.exitCode !== 0) return null;
  try {
    return `data:image/jpeg;base64,${(await readFile(input.scratchPath)).toString('base64')}`;
  } catch {
    return null;
  }
}

export interface StorySceneSpan {
  readonly sceneNumber: number;
  readonly sceneRole: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export async function writeOldVersusNewGallery(input: {
  readonly runDirectory: string;
  readonly plan: ProductStoryPlan;
  readonly previousMasterPath: string | null;
  readonly newMasterPath: string;
  readonly spans: readonly StorySceneSpan[];
  readonly exposure: readonly SceneExposureRecord[];
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
}): Promise<string> {
  const scratch = join(input.runDirectory, '.gallery-frame.jpg');
  const exposureByScene = new Map(input.exposure.map((record) => [record.sceneNumber, record]));

  const rows: string[] = [];
  for (const span of input.spans) {
    const midpoint = (span.startSeconds + span.endSeconds) / 2;
    // eslint-disable-next-line no-await-in-loop -- scenes render in order
    const before = input.previousMasterPath
      ? await frameDataUri({
          runner: input.runner,
          binaries: input.binaries,
          moviePath: input.previousMasterPath,
          atSeconds: midpoint,
          scratchPath: scratch,
        })
      : null;
    // eslint-disable-next-line no-await-in-loop -- see above
    const after = await frameDataUri({
      runner: input.runner,
      binaries: input.binaries,
      moviePath: input.newMasterPath,
      atSeconds: midpoint,
      scratchPath: scratch,
    });

    const scene = input.plan.scenes.find((candidate) => candidate.sceneNumber === span.sceneNumber);
    const record = exposureByScene.get(span.sceneNumber);
    rows.push(`
      <section class="row">
        <h2>${span.sceneNumber}. ${escapeHtml(span.sceneRole)}
          <span class="slot">${span.startSeconds.toFixed(2)}s – ${span.endSeconds.toFixed(2)}s</span></h2>
        <div class="pair">
          <figure>
            <figcaption>Rejected cut</figcaption>
            ${before ? `<img src="${before}" alt="">` : '<div class="missing">no earlier master supplied</div>'}
          </figure>
          <figure>
            <figcaption>Corrected cut</figcaption>
            ${after ? `<img src="${after}" alt="">` : '<div class="missing">frame could not be read</div>'}
          </figure>
        </div>
        <dl>
          <dt>Composited as</dt><dd>${escapeHtml(scene?.kind ?? 'unchanged')}</dd>
          <dt>Screen treatment</dt><dd>${escapeHtml(scene?.treatment?.key ?? 'none')}</dd>
          <dt>Exposure</dt><dd>${
            record
              ? `${record.profile} — ${record.verdict.status}` +
                (record.verdict.subject
                  ? ` (subject median ${record.verdict.subject.medianLuma}, p90 ` +
                    `${record.verdict.subject.percentile90Luma}, ` +
                    `${record.verdict.subject.percentAtOrAboveReadableLevel}% readable, ` +
                    `${record.verdict.subject.percentBelowCrushedLevel}% below luma 16)`
                  : '')
              : 'not measured'
          }</dd>
          <dt>Intent</dt><dd>${escapeHtml(scene?.intent ?? '—')}</dd>
        </dl>
      </section>`);
  }

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Combat Reviews — corrected cut, scene by scene</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:32px; background:#0b0b0e; color:#ececf1;
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  h1 { font-size:26px; margin:0 0 6px; }
  p.notice { color:#9b9baa; max-width:70ch; margin:0 0 28px; }
  .row { border-top:1px solid #26262f; padding:22px 0; }
  h2 { font-size:16px; margin:0 0 12px; letter-spacing:.04em; text-transform:uppercase; }
  h2 .slot { color:#8b8b98; font-weight:400; letter-spacing:0; text-transform:none; margin-left:10px; }
  .pair { display:flex; gap:18px; flex-wrap:wrap; }
  figure { margin:0; }
  figcaption { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:#8b8b98; margin-bottom:6px; }
  img { display:block; width:270px; height:auto; border-radius:8px; border:1px solid #26262f; }
  .missing { width:270px; height:480px; border:1px dashed #3a3a46; border-radius:8px;
             display:flex; align-items:center; justify-content:center; color:#6a6a78; font-size:12px; text-align:center; padding:12px; }
  dl { display:grid; grid-template-columns:190px 1fr; gap:4px 16px; margin:16px 0 0; max-width:90ch; }
  dt { color:#8b8b98; font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
  dd { margin:0; font-size:13.5px; }
</style></head><body>
<h1>${escapeHtml(PRODUCT_STORY_LABEL)}</h1>
<p class="notice">Ten scenes, the rejected cut beside the corrected one, sampled at each scene's own
midpoint. Every measurement on this page is technical. <strong>Creative quality is not assessed
anywhere in it</strong>, no screen shown is a capture, and nothing here is public-release ready.
Authored by ${escapeHtml(input.plan.authoredBy)}; the interfaces are PRODUCT_MOCKUPs authorised for
internal review by ${escapeHtml(input.plan.authorisation.reviewer)}.</p>
${rows.join('\n')}
</body></html>
`;
  const target = join(input.runDirectory, STORY_GALLERY_FILENAME);
  await writeFile(target, html, 'utf8');
  return target;
}

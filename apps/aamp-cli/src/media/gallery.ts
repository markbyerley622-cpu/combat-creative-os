import { isAbsolute, relative, sep } from 'node:path';

import type { MediaAcquisitionRun, MediaCandidate } from '@combat/providers';

import { rankBySourceQuality } from './source-quality';

/**
 * The reviewer's screen.
 *
 * One HTML file, opened with a double-click. No server, no script, no webfont,
 * and — the part that matters — **no automatic network request**. A gallery
 * that embedded remote provider thumbnails would fetch a hundred images from
 * five companies every time somebody opened it, which is a request an operator
 * did not make and a signal about what they are reviewing. Remote previews are
 * therefore *links* a person clicks deliberately; only media already on this
 * machine is embedded.
 *
 * It is a review tool, not a decision. Nothing here approves anything, and the
 * banner says so: every card shows the rights outcome, the reasons behind it,
 * the risk flags, and the human checks no measurement can settle.
 */

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#07090d; color:#e9edf2; font-family: -apple-system, "Segoe UI", Arial, sans-serif; font-size:14px; }
  header { padding:18px 22px; border-bottom:1px solid #1b2029; background:#0b0f16; position:sticky; top:0; }
  h1 { margin:0 0 6px; font-size:19px; letter-spacing:.02em; }
  .sub { color:#9aa5b4; font-size:12px; }
  .banner { margin:12px 0 0; padding:10px 12px; border-left:3px solid #ff3b30; background:#150a0a; color:#ffd9d6; font-size:12px; }
  main { padding:18px 22px; display:grid; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:14px; }
  article { border:1px solid #1b2029; border-radius:10px; background:#0b0f16; overflow:hidden; display:flex; flex-direction:column; }
  .thumb { background:#05070a; aspect-ratio:16/9; display:flex; align-items:center; justify-content:center; color:#5c6675; font-size:11px; text-align:center; padding:8px; }
  .thumb img { max-width:100%; max-height:100%; object-fit:contain; }
  .body { padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
  .title { font-weight:600; font-size:14px; line-height:1.3; }
  .id { font-family: Consolas, "SF Mono", monospace; font-size:11px; color:#9aa5b4; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  td { padding:2px 0; vertical-align:top; }
  td:first-child { color:#9aa5b4; width:42%; padding-right:8px; }
  .pill { display:inline-block; font-size:10px; letter-spacing:.08em; text-transform:uppercase; padding:3px 8px; border-radius:99px; }
  .ok { background:#0d2a16; color:#7ee2a8; }
  .review { background:#2b230a; color:#f0d178; }
  .bad { background:#2c0f0d; color:#ff8b82; }
  .neutral { background:#161c26; color:#9aa5b4; }
  .scores { display:flex; gap:6px; flex-wrap:wrap; }
  .score { background:#111722; border:1px solid #1b2029; border-radius:6px; padding:4px 7px; font-size:11px; }
  .score b { display:block; font-size:14px; color:#e9edf2; }
  ul { margin:4px 0 0; padding-left:16px; font-size:12px; color:#c6ced9; }
  li { margin-bottom:3px; }
  h3 { margin:6px 0 0; font-size:11px; text-transform:uppercase; letter-spacing:.14em; color:#9aa5b4; }
  a { color:#7fb2ff; }
  footer { padding:16px 22px; color:#5c6675; font-size:11px; border-top:1px solid #1b2029; }
`;

/**
 * Escapes text for HTML.
 *
 * Everything on a card is third-party prose — a provider's title, a
 * contributor's name, a licence restriction paragraph. None of it is trusted,
 * and a title containing a `<script>` tag is a perfectly ordinary thing for a
 * stock catalogue to hold.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links are rendered as anchors; anything else becomes plain text. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function link(url: string, label: string): string {
  const href = safeHref(url);
  if (!href) return escapeHtml(label);
  return `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${escapeHtml(label)}</a>`;
}

function pill(text: string, tone: 'ok' | 'review' | 'bad' | 'neutral'): string {
  return `<span class="pill ${tone}">${escapeHtml(text)}</span>`;
}

function rightsTone(outcome: string | undefined): 'ok' | 'review' | 'bad' | 'neutral' {
  if (outcome === 'AUTOMATICALLY_ELIGIBLE' || outcome === 'MEETS_PROFILE') return 'ok';
  if (outcome === 'REVIEW_REQUIRED') return 'review';
  if (outcome === 'REJECTED' || outcome === 'BELOW_PROFILE') return 'bad';
  return 'neutral';
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'not measured';
  return `${seconds.toFixed(2)} s`;
}

function formatResolution(candidate: MediaCandidate): string {
  if (!candidate.widthPx || !candidate.heightPx) return 'not measured';
  const measured = candidate.measurements ? ' (measured)' : ' (declared)';
  return `${candidate.widthPx}×${candidate.heightPx}${measured}`;
}

export interface GalleryOptions {
  readonly run: MediaAcquisitionRun;
  /** Directory the gallery file lands in; local thumbnails are relative to it. */
  readonly galleryDirectory: string;
  /** Absolute paths to already-downloaded media, by candidate id. */
  readonly localMedia?: ReadonlyMap<string, string>;
  readonly now: Date;
}

function relativeFrom(directory: string, target: string): string | null {
  if (!isAbsolute(target)) return target;
  const rel = relative(directory, target).split(sep).join('/');
  // A path that climbs out of the gallery's own directory is not embedded: the
  // gallery has to remain movable, and `../../../Users/...` in an `img src`
  // would leak a local path into a file an operator might send to somebody.
  if (rel.startsWith('..')) return null;
  return `./${rel}`;
}

function renderCard(candidate: MediaCandidate, options: GalleryOptions): string {
  const rights = candidate.rightsDecision;
  const quality = candidate.qualityDecision;
  const measurements = candidate.measurements;
  const localPath = options.localMedia?.get(candidate.candidateId);
  const embeddable =
    candidate.mediaKind === 'IMAGE' && localPath
      ? relativeFrom(options.galleryDirectory, localPath)
      : null;

  const riskFlags: string[] = [];
  if (candidate.rights.recognizablePersonRisk !== 'NONE_APPARENT') {
    riskFlags.push(`people: ${candidate.rights.recognizablePersonRisk}`);
  }
  if (candidate.rights.trademarkOrLogoRisk !== 'NONE_APPARENT') {
    riskFlags.push(`marks: ${candidate.rights.trademarkOrLogoRisk}`);
  }
  if (candidate.rights.endorsementRisk !== 'LOW') {
    riskFlags.push(`endorsement: ${candidate.rights.endorsementRisk}`);
  }
  if (
    candidate.rights.modelReleaseStatus !== 'ON_FILE' &&
    candidate.rights.modelReleaseStatus !== 'NOT_APPLICABLE'
  ) {
    riskFlags.push(`model release: ${candidate.rights.modelReleaseStatus}`);
  }

  const scores = quality?.scores;

  return `<article>
  <div class="thumb">${
    embeddable
      ? `<img src="${escapeHtml(embeddable)}" alt="">`
      : candidate.previewUrl
        ? `preview not embedded — ${link(candidate.previewUrl, 'open it deliberately')}<br>(this page makes no network request on its own)`
        : 'no preview'
  }</div>
  <div class="body">
    <div class="title">${escapeHtml(candidate.title)}</div>
    <div class="id">${escapeHtml(candidate.candidateId)} · ${escapeHtml(candidate.provider)} · ${escapeHtml(candidate.mediaKind)} · ${escapeHtml(candidate.state)}</div>
    <div>${pill(rights?.outcome ?? 'NOT EVALUATED', rightsTone(rights?.outcome))} ${pill(
      quality?.outcome ?? 'NOT MEASURED',
      rightsTone(quality?.outcome),
    )}</div>
    ${
      scores
        ? `<div class="scores">
      <div class="score">technical<b>${scores.technicalQualityScore}</b></div>
      <div class="score">edit<b>${scores.editUtilityScore}</b></div>
      <div class="score">vertical<b>${scores.verticalSuitabilityScore}</b></div>
      <div class="score">rights<b>${scores.rightsConfidenceScore}</b></div>
      <div class="score">overall<b>${scores.overallSourceScore}</b></div>
    </div>`
        : ''
    }
    <table>
      <tr><td>creator</td><td>${escapeHtml(candidate.rights.creator)}</td></tr>
      <tr><td>licence</td><td>${escapeHtml(candidate.rights.declaredLicence)}${
        candidate.rights.licenceUrl ? ` — ${link(candidate.rights.licenceUrl, 'terms')}` : ''
      }</td></tr>
      <tr><td>attribution</td><td>${escapeHtml(rights?.requiredAttribution ?? candidate.rights.attributionText ?? 'not required')}</td></tr>
      <tr><td>resolution</td><td>${escapeHtml(formatResolution(candidate))}</td></tr>
      <tr><td>duration</td><td>${escapeHtml(formatDuration(candidate.durationSeconds))}</td></tr>
      <tr><td>frame rate</td><td>${escapeHtml(candidate.frameRate === null ? 'not measured' : `${candidate.frameRate.toFixed(2)} fps`)}</td></tr>
      ${
        measurements
          ? `<tr><td>codec / container</td><td>${escapeHtml(`${measurements.videoCodec ?? measurements.audioCodec ?? 'unknown'} / ${measurements.container}`)}</td></tr>
      <tr><td>black / freeze</td><td>${escapeHtml(
        measurements.blackRatio === null
          ? 'not measured'
          : `${(measurements.blackRatio * 100).toFixed(1)}% / ${((measurements.freezeRatio ?? 0) * 100).toFixed(1)}%`,
      )}</td></tr>
      <tr><td>scenes / longest run</td><td>${escapeHtml(
        `${measurements.sceneCount ?? 'not measured'} / ${measurements.longestUsableRunSeconds === null ? 'not measured' : `${measurements.longestUsableRunSeconds.toFixed(2)} s`}`,
      )}</td></tr>
      <tr><td>9:16 crop</td><td>${escapeHtml(`${measurements.verticalCropWidthPx}px wide — ${measurements.verticalCropFeasible ? 'no upscale needed' : 'would need upscaling'}`)}</td></tr>`
          : ''
      }
      <tr><td>suggested role</td><td>${escapeHtml(candidate.suggestedRole ?? 'none')}</td></tr>
      <tr><td>source</td><td>${link(candidate.landingPageUrl, 'landing page')}</td></tr>
    </table>
    ${riskFlags.length > 0 ? `<div>${riskFlags.map((flag) => pill(flag, 'review')).join(' ')}</div>` : ''}
    ${
      rights && rights.reasons.length > 0
        ? `<h3>rights reasons</h3><ul>${rights.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
        : ''
    }
    ${
      quality && quality.reasons.length > 0
        ? `<h3>quality reasons</h3><ul>${quality.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
        : ''
    }
    ${
      quality && quality.humanChecksRequired.length > 0
        ? `<h3>a person must check</h3><ul>${quality.humanChecksRequired.map((check) => `<li>${escapeHtml(check)}</li>`).join('')}</ul>`
        : ''
    }
  </div>
</article>`;
}

export function renderGallery(options: GalleryOptions): string {
  const ranked = rankBySourceQuality(options.run.candidates);
  const counts = {
    total: ranked.length,
    eligible: ranked.filter((c) => c.rightsDecision?.outcome === 'AUTOMATICALLY_ELIGIBLE').length,
    review: ranked.filter((c) => c.rightsDecision?.outcome === 'REVIEW_REQUIRED').length,
    rejected: ranked.filter((c) => c.rightsDecision?.outcome === 'REJECTED').length,
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Media candidates — ${escapeHtml(options.run.runId)}</title>
<style>${STYLE}</style></head>
<body>
<header>
  <h1>Media candidates — ${escapeHtml(options.run.runId)}</h1>
  <div class="sub">${escapeHtml(options.run.origin)} · ${counts.total} candidates · ${counts.eligible} policy-clear · ${counts.review} need review · ${counts.rejected} refused · generated ${escapeHtml(options.now.toISOString())}</div>
  <div class="banner">
    NOTHING HERE IS APPROVED. A policy outcome of AUTOMATICALLY_ELIGIBLE means the licence rules raised no objection — it is not permission.
    Acquisition begins only after a named person records an approval against a specific candidate for specific usages.
    This page makes no network request on its own: remote previews are links you click, not images it fetches.
  </div>
</header>
<main>
${ranked.map((candidate) => renderCard(candidate, options)).join('\n')}
</main>
<footer>
  Ranked by overall source score (${escapeHtml(String(counts.total))} shown). Scores are deterministic functions of measurements and rights outcomes.
  No score on this page is a judgement of creative quality — no reliable machine measurement of that exists, and none is reported.
</footer>
</body></html>`;
}

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildContactSheet,
  CONTACT_SHEET_FILENAME,
  extractStoryboardFrames,
  MOTION_TREATMENT_CATALOGUE_VERSION,
  sceneTreatmentSummary,
  STORYBOARD_FRAME_DIRECTORY,
  type CommandRunner,
  type ExtractedFrame,
  type FfmpegBinaries,
  type RenderManifest,
  type SceneTreatmentKey,
} from '@combat/media';

import type { ResolvedAsset } from '../asset-resolution';
import type { AudioPlan } from './audio-plan';
import { beatStartTimes } from './build-preview-edit';
import type { HumanCreativePlan } from './human-plan';
import type { SelectedSegment } from './segment-selection';

/**
 * The storyboard: what this cut will be, written down before it is rendered.
 *
 * A reviewer approving a preview needs to answer "is that the right shot, in
 * the right order, saying the right thing, from material we are allowed to
 * use?" — and a render answers none of those until it exists. So every beat is
 * described here first, in JSON for machines and in a self-contained HTML page
 * for a person, alongside a contact sheet of the actual frames the cut will
 * open each beat on.
 *
 * Two rules govern what may appear:
 *
 * - **Nothing outside the allowed asset root.** Paths are recorded relative to
 *   the root, never absolutely, so a storyboard mailed to a reviewer carries no
 *   detail about the machine that made it.
 * - **No credentials, no environment, no reference material.** The artefacts
 *   are built from the plan, the manifest and the measured selections, none of
 *   which hold any of those. `assertStoryboardSafe` walks the result and fails
 *   closed rather than trusting that.
 */

export const STORYBOARD_JSON_FILENAME = 'storyboard.json';
export const STORYBOARD_HTML_FILENAME = 'storyboard.html';
export const SOURCE_SELECTION_REPORT_FILENAME = 'source-selection-report.json';
export const AUDIO_PLAN_FILENAME = 'audio-plan.json';
export const RENDER_SUMMARY_FILENAME = 'render-summary.json';

export interface StoryboardBeat {
  readonly beatId: string;
  readonly index: number;
  readonly timestampSeconds: number;
  readonly durationSeconds: number;
  readonly narrativeRole: string;
  readonly description: string;
  readonly sourceAssetId: string;
  readonly sourceRelativePath: string;
  readonly sourceChecksumSha256: string;
  readonly rightsClassification: string;
  readonly inSeconds: number | null;
  readonly outSeconds: number | null;
  readonly caption: string | null;
  readonly transition: string | null;
  readonly motionTreatment: string;
  readonly motionIntensity: number;
  readonly motionDescription: string;
  readonly ctaState: 'BEFORE_CTA' | 'CTA_CARD';
  readonly audioEvents: readonly string[];
  readonly selectionReasoning: readonly string[];
  readonly frameFileName: string | null;
}

export interface Storyboard {
  readonly storyboardVersion: 1;
  readonly campaignId: string;
  readonly workspaceId: string;
  readonly campaignName: string;
  readonly authoredBy: string;
  readonly executionMode: string;
  readonly planningSource: string;
  readonly motionCatalogueVersion: number;
  readonly totalDurationSeconds: number;
  readonly beats: readonly StoryboardBeat[];
  readonly contactSheetFileName: string | null;
  readonly notice: string;
}

const STORYBOARD_NOTICE =
  'This storyboard describes what the run intends to render. It is not an approval, not a quality judgement, and not evidence that the finished file matches it — the QA report compares the two and is the binding record.' as const;

/** Keys a storyboard must never contain, at any depth. */
export const STORYBOARD_FORBIDDEN_KEYS: readonly string[] = [
  'apiKey',
  'api_key',
  'ANTHROPIC_API_KEY',
  'QDRANT_API_KEY',
  'COMFYUI_API_KEY',
  'DATABASE_URL',
  'databaseUrl',
  'connectionString',
  'secret',
  'secretKey',
  'password',
  'token',
  'authorization',
  'signedUrl',
  'transcript',
  'transcriptText',
  'referenceMediaPath',
  'localPath',
  'absolutePath',
];

const FORBIDDEN_VALUE_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /postgres(?:ql)?:\/\//i, why: 'a PostgreSQL connection string' },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]+/, why: 'an Anthropic API key' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'a private key' },
  { pattern: /\.aamp-reference-analysis[\\/]/i, why: 'a path into derived reference analysis' },
  // An absolute path is a leak of the machine, not of a secret, but it is
  // still something a storyboard shared with a reviewer has no use for.
  { pattern: /^[A-Za-z]:[\\/]/, why: 'an absolute Windows path' },
  { pattern: /^\/(?:home|Users|root|var|etc)\//, why: 'an absolute POSIX path' },
];

export class UnsafeStoryboardError extends Error {
  constructor(public readonly violations: readonly string[]) {
    super(
      `The storyboard carries material that must not be shared:\n  - ${violations.join('\n  - ')}`,
    );
    this.name = 'UnsafeStoryboardError';
  }
}

/** Walks a storyboard and refuses anything that must not leave this machine. */
export function assertStoryboardSafe(record: unknown, where = 'storyboard'): void {
  const violations: string[] = [];

  const walk = (value: unknown, path: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      for (const { pattern, why } of FORBIDDEN_VALUE_PATTERNS) {
        if (pattern.test(value)) violations.push(`${path || '<root>'} looks like ${why}`);
      }
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (STORYBOARD_FORBIDDEN_KEYS.includes(key)) {
        violations.push(`${path ? `${path}.` : ''}${key} is a forbidden field`);
        continue;
      }
      walk(member, path ? `${path}.${key}` : key);
    }
  };

  walk(record, '');
  if (violations.length > 0)
    throw new UnsafeStoryboardError(violations.map((v) => `${where}: ${v}`));
}

export interface BuildStoryboardOptions {
  readonly plan: HumanCreativePlan;
  readonly campaignName: string;
  readonly manifest: RenderManifest;
  readonly assetByBeatId: ReadonlyMap<string, ResolvedAsset>;
  readonly segmentByBeatId: ReadonlyMap<string, SelectedSegment>;
  /** Relative path per asset id, so nothing absolute reaches the artefact. */
  readonly relativePathByAssetId: ReadonlyMap<string, string>;
  readonly audioPlan: AudioPlan;
  readonly executionMode: string;
  readonly frames: readonly ExtractedFrame[];
  readonly contactSheetFileName: string | null;
}

export function buildStoryboard(options: BuildStoryboardOptions): Storyboard {
  const { plan, manifest } = options;
  const starts = beatStartTimes(plan);
  const ctaStart = plan.targetDurationSeconds - plan.cta.durationSeconds;
  const frameByBeat = new Map(options.frames.map((frame) => [frame.id, frame]));

  const beats: StoryboardBeat[] = plan.beats.map((beat, index) => {
    const asset = options.assetByBeatId.get(beat.id);
    const segment = options.segmentByBeatId.get(beat.id);
    const start = starts[index] ?? 0;
    const audioEvents = options.audioPlan.cues
      .filter((cue) => cue.atSeconds >= start && cue.atSeconds < start + beat.durationSeconds)
      .map((cue) => `${cue.role} at ${cue.atSeconds.toFixed(2)}s, ${cue.gainDb} dB`);

    return {
      beatId: beat.id,
      index: beat.index,
      timestampSeconds: start,
      durationSeconds: beat.durationSeconds,
      narrativeRole: beat.role,
      description: beat.description,
      sourceAssetId: asset?.asset.id ?? 'UNRESOLVED',
      sourceRelativePath: options.relativePathByAssetId.get(asset?.asset.id ?? '') ?? 'UNRESOLVED',
      sourceChecksumSha256: asset?.checksumSha256 ?? '',
      rightsClassification: asset?.asset.rights.classification ?? 'UNKNOWN',
      inSeconds: segment?.inSeconds ?? null,
      outSeconds: segment?.outSeconds ?? null,
      caption: beat.caption?.text ?? null,
      transition: beat.transitionIn ? beat.transitionIn.kind : null,
      motionTreatment: beat.motion.treatment,
      motionIntensity: beat.motion.intensity,
      motionDescription: sceneTreatmentSummary(beat.motion.treatment as SceneTreatmentKey),
      // Overlap, not start: the beat the card sits on begins slightly before
      // the card fades in, and calling that beat "before the CTA" would make
      // the storyboard disagree with what a reviewer sees.
      ctaState: start + beat.durationSeconds > ctaStart + 1e-6 ? 'CTA_CARD' : 'BEFORE_CTA',
      audioEvents,
      selectionReasoning: segment
        ? segment.reasons
        : ['a still image has no timeline, so no in-point was selected'],
      frameFileName: frameByBeat.get(beat.id)
        ? `${STORYBOARD_FRAME_DIRECTORY}/${frameByBeat.get(beat.id)?.fileName}`
        : null,
    };
  });

  const storyboard: Storyboard = {
    storyboardVersion: 1,
    campaignId: plan.campaignId,
    workspaceId: plan.workspaceId,
    campaignName: options.campaignName,
    authoredBy: plan.authoredBy,
    executionMode: options.executionMode,
    planningSource: 'HUMAN_SUPPLIED_STRUCTURED_PLAN',
    motionCatalogueVersion: MOTION_TREATMENT_CATALOGUE_VERSION,
    totalDurationSeconds: manifest.output.durationSeconds,
    beats,
    contactSheetFileName: options.contactSheetFileName,
    notice: STORYBOARD_NOTICE,
  };

  assertStoryboardSafe(storyboard);
  return storyboard;
}

/** HTML-escapes text so authored copy can never become markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The storyboard as one self-contained page.
 *
 * No stylesheet link, no script, no font request, no analytics — it opens from
 * the filesystem with no server and no network, which is the whole point: a
 * reviewer looking at a preview should not have to stand up infrastructure,
 * and a page that phones home is a page that leaks what is being reviewed.
 * Frame images are referenced by relative path, so the directory travels as a
 * unit.
 */
export function renderStoryboardHtml(storyboard: Storyboard): string {
  const rows = storyboard.beats
    .map((beat) => {
      const frame = beat.frameFileName
        ? `<img src="${escapeHtml(beat.frameFileName)}" alt="beat ${beat.index}" />`
        : '<div class="noframe">no frame</div>';
      const audio =
        beat.audioEvents.length > 0
          ? `<ul>${beat.audioEvents.map((event) => `<li>${escapeHtml(event)}</li>`).join('')}</ul>`
          : '<span class="muted">none</span>';
      return `
      <section class="beat">
        <div class="thumb">${frame}</div>
        <div class="detail">
          <h2><span class="idx">${beat.index}</span> ${escapeHtml(beat.narrativeRole)} <span class="muted">${beat.timestampSeconds.toFixed(2)}s &rarr; ${(beat.timestampSeconds + beat.durationSeconds).toFixed(2)}s (${beat.durationSeconds.toFixed(2)}s)</span></h2>
          <p class="desc">${escapeHtml(beat.description)}</p>
          <dl>
            <dt>Source</dt><dd>${escapeHtml(beat.sourceAssetId)} &mdash; <code>${escapeHtml(beat.sourceRelativePath)}</code></dd>
            <dt>Checksum</dt><dd><code>${escapeHtml(beat.sourceChecksumSha256.slice(0, 16))}&hellip;</code></dd>
            <dt>Rights</dt><dd>${escapeHtml(beat.rightsClassification)}</dd>
            <dt>In / out</dt><dd>${beat.inSeconds === null ? '<span class="muted">still image</span>' : `${beat.inSeconds.toFixed(2)}s &ndash; ${(beat.outSeconds ?? 0).toFixed(2)}s`}</dd>
            <dt>Caption</dt><dd>${beat.caption ? escapeHtml(beat.caption) : '<span class="muted">none</span>'}</dd>
            <dt>Transition in</dt><dd>${beat.transition ? escapeHtml(beat.transition) : '<span class="muted">opening beat</span>'}</dd>
            <dt>Motion</dt><dd>${escapeHtml(beat.motionTreatment)} @ ${beat.motionIntensity} &mdash; ${escapeHtml(beat.motionDescription)}</dd>
            <dt>CTA state</dt><dd>${escapeHtml(beat.ctaState)}</dd>
            <dt>Audio</dt><dd>${audio}</dd>
            <dt>Why this segment</dt><dd><ul>${beat.selectionReasoning.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></dd>
          </dl>
        </div>
      </section>`;
    })
    .join('\n');

  const sheet = storyboard.contactSheetFileName
    ? `<section class="sheet"><h2>Contact sheet</h2><img src="${escapeHtml(storyboard.contactSheetFileName)}" alt="contact sheet" /></section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(storyboard.campaignName)} — storyboard</title>
<style>
  :root { color-scheme: light dark; --fg: #16181d; --bg: #ffffff; --muted: #6b7280; --line: #e5e7eb; --card: #f9fafb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8eaed; --bg: #0e1016; --muted: #9aa1ad; --line: #262b36; --card: #171a22; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
         font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 1040px; margin: 0 auto; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .35rem; }
  .meta { color: var(--muted); font-size: .875rem; }
  .notice { margin: 1rem 0 0; padding: .75rem 1rem; background: var(--card);
            border: 1px solid var(--line); border-radius: 8px; font-size: .875rem; }
  .beat { display: grid; grid-template-columns: 180px 1fr; gap: 1.25rem; padding: 1.25rem 0;
          border-bottom: 1px solid var(--line); }
  @media (max-width: 720px) { .beat { grid-template-columns: 1fr; } }
  .thumb img { width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--line); display: block; }
  .noframe { aspect-ratio: 9/16; display: grid; place-items: center; color: var(--muted);
             border: 1px dashed var(--line); border-radius: 8px; font-size: .8rem; }
  h2 { font-size: 1rem; margin: 0 0 .4rem; font-weight: 600; }
  .idx { display: inline-block; min-width: 1.6em; padding: 0 .35em; margin-right: .4em; text-align: center;
         background: var(--card); border: 1px solid var(--line); border-radius: 5px; font-variant-numeric: tabular-nums; }
  .desc { margin: 0 0 .75rem; }
  dl { display: grid; grid-template-columns: 8.5rem 1fr; gap: .3rem .75rem; margin: 0; font-size: .875rem; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  dd ul { margin: 0; padding-left: 1.1rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .85em; }
  .muted { color: var(--muted); }
  .sheet img { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; }
  .sheet { margin-top: 2rem; overflow-x: auto; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(storyboard.campaignName)}</h1>
    <div class="meta">
      ${escapeHtml(storyboard.totalDurationSeconds.toFixed(2))}s &middot; ${storyboard.beats.length} beats &middot;
      execution mode <strong>${escapeHtml(storyboard.executionMode)}</strong> &middot;
      planning source <strong>${escapeHtml(storyboard.planningSource)}</strong> &middot;
      authored by ${escapeHtml(storyboard.authoredBy)} &middot;
      motion catalogue v${storyboard.motionCatalogueVersion}
    </div>
    <p class="notice">${escapeHtml(storyboard.notice)}</p>
  </header>
${rows}
${sheet}
</div>
</body>
</html>
`;
}

export interface WriteStoryboardArtefactsOptions extends BuildStoryboardOptions {
  readonly runDirectory: string;
}

/** Writes `storyboard.json` and the self-contained `storyboard.html`. */
export async function writeStoryboardArtefacts(
  options: WriteStoryboardArtefactsOptions,
): Promise<{ storyboard: Storyboard; jsonPath: string; htmlPath: string }> {
  const storyboard = buildStoryboard(options);
  const jsonPath = join(options.runDirectory, STORYBOARD_JSON_FILENAME);
  const htmlPath = join(options.runDirectory, STORYBOARD_HTML_FILENAME);
  await mkdir(options.runDirectory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8');
  await writeFile(htmlPath, renderStoryboardHtml(storyboard), 'utf8');
  return { storyboard, jsonPath, htmlPath };
}

export interface ExtractPreviewFramesOptions {
  readonly runner: CommandRunner;
  readonly binaries: FfmpegBinaries;
  readonly runDirectory: string;
  readonly plan: HumanCreativePlan;
  readonly assetByBeatId: ReadonlyMap<string, ResolvedAsset>;
  readonly segmentByBeatId: ReadonlyMap<string, SelectedSegment>;
}

/**
 * Pulls one frame per beat, at the in-point the cut will actually use, and
 * tiles them.
 *
 * Frame extraction is best-effort by design: a contact sheet is a review aid,
 * and a run that produced a correct advertisement should not be failed because
 * a thumbnail could not be tiled. The failure is reported rather than swallowed
 * — `contactSheetFileName` is null and the reason is returned.
 */
export async function extractPreviewFrames(options: ExtractPreviewFramesOptions): Promise<{
  frames: readonly ExtractedFrame[];
  contactSheetFileName: string | null;
  problem: string | null;
}> {
  const frameDirectory = join(options.runDirectory, STORYBOARD_FRAME_DIRECTORY);
  const requests = options.plan.beats.flatMap((beat) => {
    const asset = options.assetByBeatId.get(beat.id);
    if (!asset) return [];
    const segment = options.segmentByBeatId.get(beat.id);
    return [
      {
        id: beat.id,
        sourcePath: asset.absolutePath,
        atSeconds: segment?.inSeconds ?? 0,
        isStill: asset.asset.kind !== 'VIDEO',
      },
    ];
  });

  try {
    const frames = await extractStoryboardFrames(options.runner, requests, frameDirectory, {
      ffmpegPath: options.binaries.ffmpeg,
    });
    await buildContactSheet(
      options.runner,
      frames,
      frameDirectory,
      join(options.runDirectory, CONTACT_SHEET_FILENAME),
      { ffmpegPath: options.binaries.ffmpeg },
    );
    return { frames, contactSheetFileName: CONTACT_SHEET_FILENAME, problem: null };
  } catch (error) {
    return {
      frames: [],
      contactSheetFileName: null,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

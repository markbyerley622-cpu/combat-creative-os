import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { CommandRunner, FfmpegBinaries } from '@combat/media';

import type { CampaignRequest } from '../campaign-request';
import type { HumanCreativePlan } from '../preview/human-plan';
import { runPreviewCampaign, type PreviewCampaignResult } from '../preview/run-preview-campaign';
import {
  FINISHING_RUN_NOTICE,
  type CreativeFinishingBrief,
  type FinishingCandidate,
  type RevisionStage,
} from './finishing-contracts';
import {
  CONTROL_CANDIDATE_ID,
  STAGE_AXIS_POLICY,
  type DirectiveCandidate,
  type StageDirectiveSet,
} from './finishing-directives';
import { applyFinishingOperations, PlanEditError } from './finishing-plan-edits';
import {
  candidatePlanFile,
  candidateRenderDirectory,
  writeCandidate,
  writeStageComparison,
  type StageComparison,
} from './finishing-store';

/**
 * Proposing a stage: turning the reviewer's directives into watchable
 * alternatives.
 *
 * The control is added by this module, not by the reviewer. A comparison
 * without the current cut in it asks "which of these three?" when the honest
 * question is "any of these three, or what you already have?" — and the second
 * question is the one that stops a revision round from moving sideways.
 *
 * Every candidate is rendered through the existing zero-cost preview path,
 * unchanged: the same preflight, the same rights enforcement, the same
 * deterministic segment selection, the same actual-media QA. A finishing pass
 * that rendered through a shortcut would be comparing candidates against a
 * standard the finished master never has to meet.
 */

export interface ProposeStageOptions {
  readonly runDirectory: string;
  readonly request: CampaignRequest;
  readonly brief: CreativeFinishingBrief;
  readonly stage: RevisionStage;
  readonly basePlan: HumanCreativePlan;
  readonly basePlanSha256: string;
  readonly directives: StageDirectiveSet;
  readonly assetRoot: string;
  readonly repositoryRoot: string;
  readonly binaries: FfmpegBinaries;
  readonly workflowRunId: string;
  readonly now: Date;
  readonly runner?: CommandRunner;
  readonly skipRender: boolean;
  readonly onProgress?: (message: string) => void;
}

export interface ProposeStageResult {
  readonly comparison: StageComparison;
  readonly comparisonHtmlPath: string;
  readonly renderedCount: number;
  readonly failedCount: number;
}

interface DerivedCandidate {
  readonly candidate: FinishingCandidate;
  readonly plan: HumanCreativePlan;
  readonly label: string;
  readonly rationale: string;
}

/**
 * The control, expressed as a candidate.
 *
 * It carries a single change record saying it changed nothing, because
 * `changesFromBase` is `.min(1)` and a candidate with an empty list would read
 * as "we did not record what changed" rather than "nothing did".
 */
function controlCandidate(
  stage: RevisionStage,
  basePlan: HumanCreativePlan,
  basePlanSha256: string,
  createdAt: string,
): DerivedCandidate {
  const label = 'The approved cut, unchanged';
  return {
    plan: basePlan,
    label,
    rationale:
      'The plan as it stands. Present in every comparison so the reviewer is always choosing against what they already have, rather than only between alternatives.',
    candidate: {
      candidateId: CONTROL_CANDIDATE_ID,
      stage,
      label,
      rationale:
        'The plan as it stands. Present in every comparison so the reviewer is always choosing against what they already have, rather than only between alternatives.',
      basePlanSha256,
      planSha256: basePlanSha256,
      changesFromBase: [
        {
          axis: STAGE_AXIS_POLICY[stage].primaryAxis,
          field: 'control',
          from: 'the approved plan',
          to: 'the approved plan',
        },
      ],
      createdAt,
    },
  };
}

function deriveCandidate(
  stage: RevisionStage,
  directive: DirectiveCandidate,
  basePlan: HumanCreativePlan,
  basePlanSha256: string,
  brief: CreativeFinishingBrief,
  createdAt: string,
): DerivedCandidate {
  const edited = applyFinishingOperations(basePlan, directive.operations, brief);
  const declaredDefects = new Set(brief.defects.map((defect) => defect.id));
  for (const defectId of directive.addressesDefectIds) {
    if (!declaredDefects.has(defectId)) {
      throw new PlanEditError(
        `candidate "${directive.candidateId}" claims to address defect "${defectId}", which this brief never recorded.`,
      );
    }
  }
  return {
    plan: edited.plan,
    label: directive.label,
    rationale: directive.rationale,
    candidate: {
      candidateId: directive.candidateId,
      stage,
      label: directive.label,
      rationale: directive.rationale,
      basePlanSha256,
      planSha256: edited.planSha256,
      changesFromBase: edited.changes.map((change, index) => ({
        axis: change.axis,
        field: change.field,
        from: change.from,
        to: change.to,
        ...(directive.addressesDefectIds[index]
          ? { addressesDefectId: directive.addressesDefectIds[index] }
          : {}),
      })),
      createdAt,
    },
  };
}

export async function proposeStage(options: ProposeStageOptions): Promise<ProposeStageResult> {
  const createdAt = options.now.toISOString();
  const { stage, basePlan, basePlanSha256, brief } = options;

  if (options.directives.basePlanSha256 !== basePlanSha256) {
    throw new PlanEditError(
      `these directives were written against plan ${options.directives.basePlanSha256.slice(0, 16)}…, but the ${stage} stage varies from ${basePlanSha256.slice(0, 16)}…. Re-author them against the plan the previous stage approved rather than against one their author never saw.`,
    );
  }

  const derived: DerivedCandidate[] = [
    controlCandidate(stage, basePlan, basePlanSha256, createdAt),
    ...options.directives.candidates.map((directive) =>
      deriveCandidate(stage, directive, basePlan, basePlanSha256, brief, createdAt),
    ),
  ];

  // Two candidates that produce the same plan are one candidate presented
  // twice, and a reviewer comparing identical files learns nothing from the
  // comparison while believing they have.
  const byChecksum = new Map<string, string>();
  for (const entry of derived) {
    const previous = byChecksum.get(entry.candidate.planSha256);
    if (previous) {
      throw new PlanEditError(
        `candidates "${previous}" and "${entry.candidate.candidateId}" produce byte-identical plans. ${
          previous === CONTROL_CANDIDATE_ID
            ? 'One of them changes nothing at all against the approved cut.'
            : 'They are the same alternative written twice.'
        }`,
      );
    }
    byChecksum.set(entry.candidate.planSha256, entry.candidate.candidateId);
  }

  const entries: StageComparison['entries'] = [];
  let renderedCount = 0;
  let failedCount = 0;

  for (const entry of derived) {
    const { candidateId } = entry.candidate;
    await writeCandidate(options.runDirectory, entry.candidate, entry.plan);

    const changes = entry.candidate.changesFromBase.map((change) => ({
      axis: change.axis,
      field: change.field,
      from: change.from,
      to: change.to,
    }));

    if (options.skipRender) {
      entries.push({
        candidateId,
        label: entry.label,
        rationale: entry.rationale,
        planSha256: entry.candidate.planSha256,
        rendered: false,
        outputPath: null,
        qaVerdict: null,
        measuredDurationSeconds: null,
        measuredLoudnessLufs: null,
        outputChecksumSha256: null,
        failure: 'render skipped by request',
        changes,
      });
      continue;
    }

    options.onProgress?.(`rendering candidate ${candidateId}`);
    let result: PreviewCampaignResult;
    try {
      result = await runPreviewCampaign({
        request: options.request,
        planPath: join(options.runDirectory, candidatePlanFile(stage, candidateId)),
        assetRoot: options.assetRoot,
        runDirectory: join(options.runDirectory, candidateRenderDirectory(stage, candidateId)),
        repositoryRoot: options.repositoryRoot,
        binaries: options.binaries,
        // A distinct run id per candidate, so two candidates can never share a
        // render key and quietly reuse each other's encode.
        workflowRunId: `${options.workflowRunId}-${stage.toLowerCase()}-${candidateId}`,
        now: options.now,
        ...(options.runner ? { runner: options.runner } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
    } catch (error) {
      failedCount += 1;
      entries.push({
        candidateId,
        label: entry.label,
        rationale: entry.rationale,
        planSha256: entry.candidate.planSha256,
        rendered: false,
        outputPath: null,
        qaVerdict: null,
        measuredDurationSeconds: null,
        measuredLoudnessLufs: null,
        outputChecksumSha256: null,
        failure: error instanceof Error ? error.message : String(error),
        changes,
      });
      continue;
    }

    const rendered = result.exitCode === 0 && Boolean(result.outputPath);
    if (rendered) renderedCount += 1;
    else failedCount += 1;

    entries.push({
      candidateId,
      label: entry.label,
      rationale: entry.rationale,
      planSha256: entry.candidate.planSha256,
      rendered,
      // Relative, so the artefact is portable and holds no local absolute path.
      outputPath: result.outputPath ? relative(options.runDirectory, result.outputPath) : null,
      qaVerdict: result.qaVerdict ?? null,
      measuredDurationSeconds: result.measuredDurationSeconds ?? null,
      measuredLoudnessLufs: result.measuredLoudnessLufs ?? null,
      outputChecksumSha256: result.outputChecksumSha256 ?? null,
      failure: rendered ? null : (result.failure ?? `exit code ${result.exitCode}`),
      changes,
    });
  }

  const comparison: StageComparison = {
    stage,
    basePlanSha256,
    comparedAt: createdAt,
    primaryAxis: STAGE_AXIS_POLICY[stage].primaryAxis,
    notice: FINISHING_RUN_NOTICE,
    entries,
  };
  await writeStageComparison(options.runDirectory, comparison);
  const comparisonHtmlPath = await writeComparisonHtml(options.runDirectory, comparison);

  return { comparison, comparisonHtmlPath, renderedCount, failedCount };
}

/* -------------------------------------------------------------------------- */
/* The reviewer's page                                                         */
/* -------------------------------------------------------------------------- */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A comparison page a reviewer opens with no server, no network and no script.
 *
 * Every authored string is escaped, and the only src a `<video>` gets is a
 * path this run wrote itself. It states what changed rather than ranking the
 * candidates, because ranking them would be the system voting in an election
 * it is supposed to be running.
 */
async function writeComparisonHtml(
  runDirectory: string,
  comparison: StageComparison,
): Promise<string> {
  const cards = comparison.entries
    .map((entry) => {
      const measured = [
        entry.qaVerdict ? `QA ${entry.qaVerdict}` : 'QA not run',
        entry.measuredDurationSeconds === null
          ? 'duration not measured'
          : `${entry.measuredDurationSeconds.toFixed(3)}s`,
        entry.measuredLoudnessLufs === null
          ? 'loudness not measured'
          : `${entry.measuredLoudnessLufs.toFixed(1)} LUFS`,
      ].join(' · ');
      const changes = entry.changes
        .map(
          (change) =>
            `<li><span class="axis">${escapeHtml(change.axis)}</span> ${escapeHtml(change.field)}</li>`,
        )
        .join('');
      return `
      <section class="card">
        <h2>${escapeHtml(entry.label)} <span class="id">${escapeHtml(entry.candidateId)}</span></h2>
        <p class="why">${escapeHtml(entry.rationale)}</p>
        ${
          entry.rendered && entry.outputPath
            ? `<video controls preload="metadata" src="${escapeHtml(entry.outputPath.replace(/\\/g, '/'))}"></video>`
            : `<p class="failed">No master to watch${entry.failure ? `: ${escapeHtml(entry.failure)}` : '.'}</p>`
        }
        <p class="measured">${escapeHtml(measured)}</p>
        <ul class="changes">${changes}</ul>
      </section>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${escapeHtml(comparison.stage)} comparison</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem;background:#111;color:#eee}
 h1{font-size:1.4rem;margin:0 0 .25rem}
 .notice{color:#bbb;max-width:60rem;font-size:.85rem}
 .grid{display:flex;flex-wrap:wrap;gap:1.5rem;margin-top:2rem}
 .card{background:#1b1b1b;border:1px solid #2b2b2b;border-radius:8px;padding:1rem;width:22rem}
 .card h2{font-size:1rem;margin:0 0 .5rem}
 .id{color:#888;font-weight:400;font-size:.8rem}
 video{width:100%;border-radius:4px;background:#000}
 .why{color:#ccc;font-size:.85rem}
 .measured{color:#9ad;font-size:.8rem;font-variant-numeric:tabular-nums}
 .failed{color:#e88;font-size:.85rem}
 .changes{padding-left:1rem;font-size:.78rem;color:#aaa}
 .axis{display:inline-block;background:#2b2b2b;border-radius:3px;padding:0 .3rem;color:#ddd}
</style></head>
<body>
<h1>${escapeHtml(comparison.stage)} &mdash; comparing ${escapeHtml(comparison.primaryAxis)}</h1>
<p class="notice">${escapeHtml(comparison.notice)}</p>
<p class="notice">Nothing on this page ranks these candidates. Watch them and choose one with
<code>aamp:finish select</code>.</p>
<div class="grid">${cards}</div>
</body></html>
`;
  const target = join(runDirectory, 'stages', comparison.stage, 'comparison.html');
  await writeFile(target, html, 'utf8');
  return target;
}

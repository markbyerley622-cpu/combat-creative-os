import type { ComparisonReport } from './comparison';
import type { CreativeBenchmarkExperiment } from './experiment';
import { HUMAN_SCORECARD_DIMENSIONS } from './human-scorecard';

/**
 * The readable half of the report.
 *
 * Markdown rather than HTML: it renders in a terminal, in an editor, in a pull
 * request and in every chat tool a reviewer might paste it into, and it needs
 * no assets. The structured JSON beside it is the machine-readable half; this
 * one exists so a human can actually be asked for a judgement.
 *
 * The caveat is the first thing after the title and the last thing on the page,
 * because the middle of the document is a two-column table of differences and
 * that shape reads as a scoreboard.
 */

function escapePipes(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function truncate(value: string, limit = 90): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function renderComparisonMarkdown(
  experiment: CreativeBenchmarkExperiment,
  report: ComparisonReport,
): string {
  const lines: string[] = [];

  lines.push(`# Creative Memory benchmark — ${experiment.campaignName}`, '');
  lines.push(`> **${report.notice}**`, '');

  lines.push('## What was held constant', '');
  lines.push('| Setting | Value |', '| --- | --- |');
  for (const [label, value] of [
    ['Campaign request hash', experiment.inputs.requestHashSha256],
    ['Prompt hash', experiment.inputs.promptSha256],
    ['Production assets hash', experiment.inputs.productionAssetsSha256],
    ['Platform', experiment.inputs.platform],
    ['Target duration', `${experiment.inputs.targetDurationSeconds}s`],
    ['Reasoning profile', experiment.controlled.reasoningProfile],
    ['Reasoning model', experiment.controlled.reasoningModel],
    ['Deterministic reasoning', experiment.controlled.reasoningDeterministic ? 'yes' : 'no'],
    ['Agent prompt versions', experiment.controlled.agentPromptVersions.join(', ') || '—'],
    ['Render provider', experiment.controlled.renderProvider],
    [
      'Render settings',
      `${experiment.controlled.renderSettings.widthPx}x${experiment.controlled.renderSettings.heightPx} @ ${experiment.controlled.renderSettings.frameRate}fps`,
    ],
    ['QA configuration', experiment.controlled.qaConfiguration],
    [
      'Deterministic seed',
      experiment.controlled.deterministicSeed === null
        ? 'not supported by this provider'
        : String(experiment.controlled.deterministicSeed),
    ],
  ] as const) {
    lines.push(`| ${label} | \`${escapePipes(String(value))}\` |`);
  }
  lines.push('');

  lines.push('## Execution', '');
  lines.push('| Fact | Value |', '| --- | --- |');
  lines.push(`| Execution mode | \`${experiment.executionMode}\` |`);
  lines.push(`| Requested execution mode | \`${experiment.requestedExecutionMode ?? '(none)'}\` |`);
  lines.push(`| Benchmark profile | \`${experiment.benchmarkProfileName ?? '—'}\` |`);
  lines.push(
    `| Paid providers | ${experiment.paidProvidersAuthorised ? 'AUTHORISED' : 'not authorised — no paid call was made'} |`,
  );
  lines.push(
    `| Estimated maximum cost | ${experiment.estimatedMaximumCostCents === null ? 'not computed' : `${experiment.estimatedMaximumCostCents} cents`} |`,
  );
  lines.push(`| Experiment status | \`${experiment.status}\` |`);
  lines.push(`| Comparison status | \`${experiment.comparisonStatus}\` |`);
  lines.push(`| Human review | \`${experiment.humanReviewStatus}\` |`);
  lines.push('');

  lines.push('## Arms', '');
  lines.push(
    '| Arm | Creative Memory | Exit | QA | Output | Originality |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const arm of experiment.arms) {
    lines.push(
      `| **${arm.key}** | \`${arm.creativeMemoryMode}\` | ${arm.exitCode} | ${arm.qaVerdict ?? (arm.renderSkipped ? 'render skipped' : '—')} | ${
        arm.outputPath ? `\`${escapePipes(arm.outputPath)}\`` : '—'
      } | ${arm.originalityRiskLevel ?? '—'}${arm.originalityBlocked ? ' (BLOCKED)' : ''} |`,
    );
  }
  lines.push('');

  lines.push('## What changed', '');
  lines.push(
    `${report.changedDimensions.length} of ${report.dimensions.length} dimensions differ. **This is a count of differences, not of improvements.**`,
    '',
  );
  lines.push('| Dimension | Kind | Creative Memory OFF | Creative Memory REQUIRED | Changed |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const dimension of report.dimensions) {
    lines.push(
      `| ${dimension.dimension} | ${dimension.kind === 'MEASUREMENT' ? 'measured' : 'structural'} | ${escapePipes(
        truncate(dimension.off),
      )} | ${escapePipes(truncate(dimension.required))} | ${dimension.changed ? '**yes**' : 'no'} |`,
    );
  }
  lines.push('');

  lines.push('## Retrieval control', '');
  lines.push(
    `- OFF arm retrievals: **${report.off.retrievalCount}** ${
      report.offPerformedNoRetrieval
        ? '(correct — OFF must perform none)'
        : '(**DEFECT** — OFF must perform none)'
    }`,
  );
  lines.push(`- REQUIRED arm retrievals: ${report.required.retrievalCount}`);
  lines.push(
    `- Distinct references influencing the REQUIRED plan: ${report.required.distinctReferencesUsed}`,
  );
  lines.push(
    `- Reference roles queried: ${report.required.referenceRolesQueried.join(', ') || '—'}`,
  );
  lines.push(
    '- No reference contributed a byte to either output. Retrieval, injection and benchmark-profile approval grant no output rights.',
    '',
  );

  lines.push('## What a human still has to decide', '');
  lines.push(
    'Nothing above is a quality judgement. Score each arm separately, watching each MP4 end to end with sound, then submit with `pnpm aamp:benchmark score`.',
    '',
  );
  lines.push('| # | Dimension | The question |', '| --- | --- | --- |');
  HUMAN_SCORECARD_DIMENSIONS.forEach((dimension, index) => {
    lines.push(`| ${index + 1} | ${dimension.label} | ${escapePipes(dimension.prompt)} |`);
  });
  lines.push('');

  lines.push('---', '');
  lines.push(`> **${report.notice}**`, '');
  lines.push(`> ${experiment.interpretation}`, '');
  lines.push(
    `Report checksum \`${report.reportChecksumSha256}\` · experiment \`${experiment.experimentId}\` · compared ${report.comparedAt}`,
  );

  return `${lines.join('\n')}\n`;
}

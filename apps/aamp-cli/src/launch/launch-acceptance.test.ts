import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LAUNCH_DISTINCTNESS_AXES } from '@combat/domain';

import { LAUNCH_EXIT_CODES } from './launch-contracts';
import { runLaunchCli, type LaunchCliContext } from './launch-cli';
import {
  FfprobeOnlyRunner,
  LAUNCH_FIXTURE_AT,
  LAUNCH_FIXTURE_BENCHMARK_PROFILE,
  LAUNCH_FIXTURE_CAMPAIGN_ID,
  LAUNCH_FIXTURE_REVIEWER,
  LAUNCH_FIXTURE_WORKSPACE_ID,
  launchCreativeMemoryDependencies,
  launchRequestJson,
  writeLaunchFixtureWorkspace,
} from './launch-fixtures';

/**
 * The product-launch acceptance fixture, end to end:
 *
 *   launch brief → approved assets → approved product captures → governed
 *   Creative Memory → competing agent-authored concepts → deterministic
 *   distinctness → benchmark assessment → human concept gate → revision →
 *   selection → handoff → the existing script, shot and render path
 *
 * **What this proves:** the orchestration. Concepts come from the agent and not
 * from application code; three to five of them compete; the deterministic
 * comparison refuses a set that is one idea rewritten; each concept is assessed
 * and persisted with its originality report; rendering is impossible before a
 * named reviewer selects; a revision goes back through the agent and creates a
 * new immutable version; a superseded or cross-workspace selection is refused;
 * and the approved concept reaches script and shot planning with its provenance
 * intact.
 *
 * **What it does not prove:** anything about creative quality. The reasoning
 * provider here is a deterministic fixture, every artefact says
 * DEMONSTRATION ONLY, and no model runs, no endpoint is contacted and no money
 * is spent.
 */

let workspace: string;
let output: string;
let runDirectory: string;

const RUN_ID = 'launch-acceptance-000000000001';

interface Recorder extends LaunchCliContext {
  readonly out: string[];
  readonly err: string[];
}

async function context(overrides: Partial<LaunchCliContext> = {}): Promise<Recorder> {
  const out: string[] = [];
  const err: string[] = [];
  let conceptCounter = 0;
  return {
    cwd: process.cwd(),
    env: { NODE_ENV: 'development', REASONING_PROVIDER: 'mock' },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => LAUNCH_FIXTURE_AT,
    workflowRunId: 'launch-acceptance-run',
    launchRunId: RUN_ID,
    newConceptId: () => `concept-${(conceptCounter += 1)}`,
    runner: new FfprobeOnlyRunner(),
    creativeMemoryDependencies: await launchCreativeMemoryDependencies(),
    out,
    err,
    ...overrides,
  } as Recorder;
}

async function readJson(...segments: string[]): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(...segments), 'utf8')) as Record<string, unknown>;
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aamp-launch-'));
  output = join(workspace, 'runs');
  await writeLaunchFixtureWorkspace(workspace);

  const ctx = await context();
  const code = await runLaunchCli(
    [
      'plan',
      '--request',
      join(workspace, 'request.json'),
      '--benchmark-profile',
      LAUNCH_FIXTURE_BENCHMARK_PROFILE,
      '--output-dir',
      output,
      '--fixture-demo',
      '--json',
    ],
    ctx,
  );
  expect(code, ctx.err.join('')).toBe(LAUNCH_EXIT_CODES.SUCCESS);
  runDirectory = (JSON.parse(ctx.out.join('')) as { runDirectory: string }).runDirectory;
}, 120_000);

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('the agents produce a competing set of structured concepts', () => {
  it('produces between three and five concepts, each a validated structured concept', async () => {
    const set = await readJson(runDirectory, 'concept-set.json');
    const conceptIds = set.conceptIds as string[];
    expect(conceptIds.length).toBeGreaterThanOrEqual(3);
    expect(conceptIds.length).toBeLessThanOrEqual(5);

    for (const conceptId of conceptIds) {
      const record = await readJson(runDirectory, 'concepts', `${conceptId}.v1.json`);
      const concept = record.concept as Record<string, Record<string, string>>;
      expect(record.origin).toBe('INITIAL_COMPETITION');
      expect(String(record.authoredByAgent)).toMatch(/^creative-director@v\d+$/);
      expect(concept.title).toBeTruthy();
      expect(concept.centralIdea).toBeTruthy();
      // Every structural axis carries both a vocabulary value and the agent's
      // own direction for it.
      for (const axis of LAUNCH_DISTINCTNESS_AXES) {
        if (axis === 'centralIdea') continue;
        expect(concept[axis]?.kind, axis).toBeTruthy();
        expect(concept[axis]?.direction, axis).toBeTruthy();
      }
    }
  });

  it('produces structurally different concepts, and records why they count as different', async () => {
    const report = await readJson(runDirectory, 'distinctness-report.json');
    expect(report.verdict).toBe('DISTINCT');
    expect(report.failures).toEqual([]);

    const pairs = report.pairs as { differingAxes: string[]; superficiallyDuplicated: boolean }[];
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(pair.superficiallyDuplicated).toBe(false);
      expect(pair.differingAxes.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('cites only supplied product facts, never an invented one', async () => {
    const request = launchRequestJson();
    const factIds = new Set((request.productFacts as { id: string }[]).map((fact) => fact.id));
    const set = await readJson(runDirectory, 'concept-set.json');

    for (const conceptId of set.conceptIds as string[]) {
      const record = await readJson(runDirectory, 'concepts', `${conceptId}.v1.json`);
      const claims = (record.concept as { factualProductClaims: { factId: string }[] })
        .factualProductClaims;
      expect(claims.length).toBeGreaterThan(0);
      for (const claim of claims) expect(factIds.has(claim.factId)).toBe(true);
    }
  });
});

describe('the brief and its constraints reach the agents', () => {
  it('carries the campaign prompt, the product truths and the prohibited claims into the run', async () => {
    // The concepts exist only because the agents were given the brief: the
    // strategy the whole competition was built on restates this campaign's
    // positioning, and the run manifest pins the exact prompt that produced it.
    const manifest = await readJson(runDirectory, 'launch-run.json');
    const request = launchRequestJson();
    const strategy = await readJson(runDirectory, 'strategy.json');

    expect(manifest.campaignPromptSha256).toMatch(/^[0-9a-f]{64}$/);
    const launch = request.productLaunch as { positioning: string; prohibitedClaims: string[] };
    expect(JSON.stringify(strategy)).toContain(launch.positioning);

    // And the prohibited claims travelled with it: every concept records them
    // as implications it must not be read as making.
    const set = await readJson(runDirectory, 'concept-set.json');
    const first = await readJson(
      runDirectory,
      'concepts',
      `${(set.conceptIds as string[])[0]}.v1.json`,
    );
    const implications = (first.concept as { prohibitedImplications: string[] })
      .prohibitedImplications;
    expect(implications).toEqual(expect.arrayContaining([launch.prohibitedClaims[0] as string]));
  });
});

describe('Creative Memory is role-specific, governed and analysis-only', () => {
  it('retrieves for the strategist and the director under the approved profile', async () => {
    const provenance = await readJson(runDirectory, 'creative-memory-provenance.json');
    const retrievals = provenance.retrievals as { agentRole: string; planKey: string }[];
    const roles = new Set(retrievals.map((audit) => audit.agentRole));

    expect(roles.has('CAMPAIGN_STRATEGIST')).toBe(true);
    expect(roles.has('CREATIVE_DIRECTOR')).toBe(true);
    // Role scoping: the two roles run different retrieval plans.
    const planKeys = new Set(retrievals.map((audit) => audit.planKey));
    expect(planKeys.size).toBeGreaterThan(1);

    const profiles = provenance.governingProfiles as { name: string }[];
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) expect(profile.name).toBe(LAUNCH_FIXTURE_BENCHMARK_PROFILE);
  });

  it('states that no reference became output-eligible, and lets none reach the asset library', async () => {
    const provenance = await readJson(runDirectory, 'creative-memory-provenance.json');
    expect(provenance.anyReferenceOutputEligible).toBe(false);
    expect(String(provenance.notice)).toContain('analysis-only');

    const retrievals = provenance.retrievals as {
      items: { referenceId: string }[];
      anyReferenceOutputEligible: boolean;
    }[];
    const referenceIds = new Set(
      retrievals.flatMap((audit) => audit.items.map((item) => item.referenceId)),
    );
    expect(referenceIds.size).toBeGreaterThan(0);
    for (const audit of retrievals) expect(audit.anyReferenceOutputEligible).toBe(false);

    const merged = await readFile(join(runDirectory, 'production-assets.merged.json'), 'utf8');
    for (const referenceId of referenceIds) expect(merged).not.toContain(referenceId);
    expect(merged).not.toContain('.aamp-reference-analysis');
  });

  it('persists the originality assessment and the reference-pattern provenance per concept', async () => {
    const set = await readJson(runDirectory, 'concept-set.json');
    for (const conceptId of set.conceptIds as string[]) {
      const assessment = await readJson(
        runDirectory,
        'concepts',
        `${conceptId}.v1.assessment.json`,
      );
      const originality = assessment.originality as { riskLevel: string; notice: string };
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(originality.riskLevel);
      expect(originality.notice).toBeTruthy();

      const record = await readJson(runDirectory, 'concepts', `${conceptId}.v1.json`);
      const provenance = (
        record.concept as { referencePatternProvenance: { referenceId: string }[] }
      ).referencePatternProvenance;
      expect(provenance.length).toBeGreaterThan(0);
    }
  });
});

describe('benchmark assessment is decision support, not a verdict', () => {
  it('assesses every dimension and never claims agency quality', async () => {
    const set = await readJson(runDirectory, 'concept-set.json');
    const assessment = await readJson(
      runDirectory,
      'concepts',
      `${(set.conceptIds as string[])[0]}.v1.assessment.json`,
    );

    const dimensions = assessment.dimensions as {
      dimension: string;
      basis: string;
      verdict: string;
    }[];
    expect(dimensions.map((entry) => entry.dimension)).toEqual(
      expect.arrayContaining([
        'STRATEGIC_CLARITY',
        'PRODUCT_COMPREHENSION',
        'EMOTIONAL_IMPACT',
        'BRAND_DISTINCTIVENESS',
        'NARRATIVE_COHERENCE',
        'VISUAL_FEASIBILITY',
        'ASSET_FEASIBILITY',
        'SOUND_OPPORTUNITY',
        'ORIGINALITY_RISK',
        'PLATFORM_SUITABILITY',
      ]),
    );

    // A judgement dimension carries no verdict, rather than a number that would
    // read as evidence.
    for (const dimension of dimensions) {
      if (dimension.basis === 'HUMAN_JUDGEMENT_REQUIRED') {
        expect(dimension.verdict).toBe('NOT_ASSESSED');
      }
    }
    expect(assessment.agencyGradeClaim).toBe('NOT_ASSESSED');
    expect(assessment.requiresHumanApproval).toBe(true);
    // No finding claims craft quality. The notice is exempt: it is where the
    // system states that it never makes that claim, so it necessarily names it.
    expect(JSON.stringify(dimensions)).not.toMatch(/agency[- ]grade|agency quality/i);
    expect(String(assessment.notice)).toContain('never the source of that claim');
  });

  it('measures asset feasibility against the approved inventory', async () => {
    const set = await readJson(runDirectory, 'concept-set.json');
    const assessment = await readJson(
      runDirectory,
      'concepts',
      `${(set.conceptIds as string[])[0]}.v1.assessment.json`,
    );
    const feasibility = assessment.assetFeasibility as {
      verdict: string;
      satisfiedByAssetIds: string[];
      missingCaptureIds: string[];
    };
    expect(feasibility.verdict).toBe('FEASIBLE');
    expect(feasibility.missingCaptureIds).toEqual([]);
    expect(feasibility.satisfiedByAssetIds.length).toBeGreaterThan(0);
  });
});

describe('product captures are substituted, and only the eligible ones', () => {
  it('merges output-eligible captures and refuses the inspection-only screen entry', async () => {
    const verification = await readJson(runDirectory, 'capture-verification.json');
    expect(verification.outputEligibleCaptureIds).toEqual(['app-information', 'app-prediction']);
    expect(verification.reviewRequiredCaptureIds).toEqual(['app-discussion']);
    expect(verification.missingRequiredCaptureIds).toEqual([]);
    expect(verification.mergedAssetIds).toEqual(['app-information', 'app-prediction']);

    const merged = await readJson(runDirectory, 'production-assets.merged.json');
    const assets = merged.assets as { id: string; path: string; checksumSha256?: string }[];
    const discussion = assets.find((asset) => asset.id === 'app-discussion');
    // The inspection-only capture exists in the session and did not replace
    // anything: the merged entry still points at the original library file.
    expect(discussion?.path).not.toContain('app-discussion.png');
    expect(discussion?.checksumSha256).toBeUndefined();

    const information = assets.find((asset) => asset.id === 'app-information');
    expect(information?.path).toContain('app-information.png');
    expect(information?.checksumSha256).toBeTruthy();
  });
});

describe('the human concept gate', () => {
  it('refuses to render before a reviewer has selected', async () => {
    const ctx = await context();
    const code = await runLaunchCli(['render', '--run', runDirectory, '--fixture-demo'], ctx);
    expect(code).toBe(LAUNCH_EXIT_CODES.HUMAN_SELECTION_REQUIRED);
    expect(ctx.err.join('')).toContain('No concept has been selected');
  });

  it('reports every concept, its assessment and that rendering is blocked', async () => {
    const ctx = await context();
    const code = await runLaunchCli(['inspect', '--run', runDirectory, '--json'], ctx);
    expect(code).toBe(LAUNCH_EXIT_CODES.SUCCESS);

    const inspection = JSON.parse(ctx.out.join('')) as {
      concepts: { conceptId: string; dimensions: unknown[]; selectable: boolean }[];
      renderPermitted: boolean;
      selection: unknown;
      isRealCampaignRun: boolean;
    };
    expect(inspection.concepts.length).toBeGreaterThanOrEqual(3);
    expect(inspection.concepts[0]?.dimensions).toHaveLength(10);
    expect(inspection.renderPermitted).toBe(false);
    expect(inspection.selection).toBeNull();
    expect(inspection.isRealCampaignRun).toBe(false);
  });

  it('refuses a reviewer the brief never approved', async () => {
    const ctx = await context();
    const code = await runLaunchCli(
      ['select', '--run', runDirectory, '--concept', 'concept-1', '--reviewer', 'someone-else'],
      ctx,
    );
    expect(code).toBe(LAUNCH_EXIT_CODES.SELECTION_REFUSED);
    expect(ctx.err.join('')).toContain('REVIEWER_NOT_APPROVED');
  });

  it('refuses a selection made against another workspace', async () => {
    const ctx = await context();
    const code = await runLaunchCli(
      [
        'select',
        '--run',
        runDirectory,
        '--concept',
        'concept-1',
        '--reviewer',
        LAUNCH_FIXTURE_REVIEWER,
        '--workspace',
        '11111111-2222-4333-8444-555555555555',
      ],
      ctx,
    );
    expect(code).toBe(LAUNCH_EXIT_CODES.SELECTION_REFUSED);
    expect(ctx.err.join('')).toContain('CROSS_WORKSPACE');
  });
});

describe('revision goes back through the agent and creates a new immutable version', () => {
  const FEEDBACK = 'The opening is too slow. Try a different structure and a different ending.';

  it('records the reviewer request and writes version 2 without touching version 1', async () => {
    const before = await readFile(join(runDirectory, 'concepts', 'concept-2.v1.json'), 'utf8');
    const feedbackPath = join(workspace, 'feedback.txt');
    await writeFile(feedbackPath, FEEDBACK, 'utf8');

    const ctx = await context();
    const code = await runLaunchCli(
      [
        'revise',
        '--run',
        runDirectory,
        '--concept',
        'concept-2',
        '--feedback',
        feedbackPath,
        '--reviewer',
        LAUNCH_FIXTURE_REVIEWER,
        '--fixture-demo',
        '--json',
      ],
      ctx,
    );
    expect(code, ctx.err.join('')).toBe(LAUNCH_EXIT_CODES.SUCCESS);

    // Version 1 is byte-identical to what the reviewer read.
    expect(await readFile(join(runDirectory, 'concepts', 'concept-2.v1.json'), 'utf8')).toBe(
      before,
    );

    const version2 = await readJson(runDirectory, 'concepts', 'concept-2.v2.json');
    expect(version2.origin).toBe('REVISION');
    expect(version2.supersedesVersion).toBe(1);
    // The feedback travelled through the agent's own input, and the record says so.
    expect(version2.revisionFeedback).toBe(FEEDBACK);
    expect(String(version2.authoredByAgent)).toMatch(/^creative-director@v\d+$/);
    expect(version2.conceptChecksumSha256).not.toBe(
      (JSON.parse(before) as { conceptChecksumSha256: string }).conceptChecksumSha256,
    );

    const decisions = await readJson(runDirectory, 'decisions', '001-revision_requested.json');
    expect(decisions.decision).toBe('REVISION_REQUESTED');
    expect(decisions.reviewerId).toBe(LAUNCH_FIXTURE_REVIEWER);
    expect(decisions.feedback).toBe(FEEDBACK);
  });

  it('refuses to select the superseded version', async () => {
    const ctx = await context();
    const code = await runLaunchCli(
      [
        'select',
        '--run',
        runDirectory,
        '--concept',
        'concept-2',
        '--version',
        '1',
        '--reviewer',
        LAUNCH_FIXTURE_REVIEWER,
      ],
      ctx,
    );
    expect(code).toBe(LAUNCH_EXIT_CODES.CONCEPT_STALE_OR_SUPERSEDED);
    expect(ctx.err.join('')).toContain('SUPERSEDED_VERSION');
  });
});

describe('selection, handoff and the existing production path', () => {
  it('records an attributed, checksum-pinned selection', async () => {
    const ctx = await context();
    const code = await runLaunchCli(
      [
        'select',
        '--run',
        runDirectory,
        '--concept',
        'concept-1',
        '--reviewer',
        LAUNCH_FIXTURE_REVIEWER,
        '--json',
      ],
      ctx,
    );
    expect(code, ctx.err.join('')).toBe(LAUNCH_EXIT_CODES.SUCCESS);

    const selection = await readJson(runDirectory, 'concept-selection.json');
    const version = await readJson(runDirectory, 'concepts', 'concept-1.v1.json');
    expect(selection.conceptId).toBe('concept-1');
    expect(selection.reviewerId).toBe(LAUNCH_FIXTURE_REVIEWER);
    expect(selection.selectedAt).toBe(LAUNCH_FIXTURE_AT.toISOString());
    expect(selection.conceptChecksumSha256).toBe(version.conceptChecksumSha256);
    expect(selection.workspaceId).toBe(LAUNCH_FIXTURE_WORKSPACE_ID);
    expect(selection.campaignId).toBe(LAUNCH_FIXTURE_CAMPAIGN_ID);
  });

  it('refuses a second selection rather than overwriting the first', async () => {
    const ctx = await context();
    const code = await runLaunchCli(
      [
        'select',
        '--run',
        runDirectory,
        '--concept',
        'concept-3',
        '--reviewer',
        LAUNCH_FIXTURE_REVIEWER,
      ],
      ctx,
    );
    expect(code).toBe(LAUNCH_EXIT_CODES.SELECTION_REFUSED);
    expect(ctx.err.join('')).toContain('ALREADY_SELECTED');
  });

  it('hands the approved concept, with its provenance, to script and shot planning', async () => {
    const ctx = await context();
    const code = await runLaunchCli(
      ['render', '--run', runDirectory, '--fixture-demo', '--skip-render', '--json'],
      ctx,
    );
    expect(code, ctx.err.join('')).toBe(LAUNCH_EXIT_CODES.SUCCESS);

    const handoff = await readJson(runDirectory, 'handoff.json');
    const selection = await readJson(runDirectory, 'concept-selection.json');
    expect(handoff.conceptId).toBe(selection.conceptId);
    expect(handoff.conceptChecksumSha256).toBe(selection.conceptChecksumSha256);
    expect(handoff.campaignPromptSha256).toBe(selection.campaignPromptSha256);
    expect(handoff.reviewerId).toBe(LAUNCH_FIXTURE_REVIEWER);
    expect(handoff.benchmarkProfileName).toBe(LAUNCH_FIXTURE_BENCHMARK_PROFILE);
    expect((handoff.benchmarkProfileVersions as string[]).length).toBeGreaterThan(0);
    expect((handoff.creativeMemoryRetrievalIds as string[]).length).toBeGreaterThan(0);
    expect(handoff.productCaptureIds).toEqual(['app-information', 'app-prediction']);
    expect((handoff.factualConstraints as string[]).length).toBeGreaterThan(0);
    expect(handoff.prohibitedClaims).toEqual(
      (launchRequestJson().productLaunch as { prohibitedClaims: string[] }).prohibitedClaims,
    );
    expect(handoff.anyReferenceOutputEligible).toBe(false);

    // The approved concept — not a freshly generated one — is what the script
    // stage planned against.
    const director = await readJson(runDirectory, 'concepts', 'concept-1.v1.director.json');
    const agentOutputs = await readJson(runDirectory, 'render', 'agent-outputs.json');
    const concept = agentOutputs.concept as { logline: string; visualDirection: string };
    expect(concept.logline).toBe(director.logline);
    expect(concept.visualDirection).toBe(director.visualDirection);

    // The two upstream agents were not re-run: only the script and shot roles
    // appear in this stage's agent versions.
    const agentVersions = agentOutputs.agentVersions as string[];
    expect(agentVersions.some((version) => version.startsWith('script-timing-director@'))).toBe(
      true,
    );
    expect(agentVersions.some((version) => version.startsWith('shot-prompt-engineer@'))).toBe(true);
    expect(agentVersions.some((version) => version.startsWith('creative-director@'))).toBe(false);

    // And the render manifest holds only output-permitted sources.
    const manifest = await readJson(runDirectory, 'render', 'render-manifest.json');
    for (const source of manifest.sources as { license: { usageClass: string } }[]) {
      expect(['OWNED', 'LICENSED_FOR_OUTPUT']).toContain(source.license.usageClass);
    }
  });
});

describe('a fixture run can never claim to be a real campaign', () => {
  it('labels the run a demonstration in the manifest and on the console', async () => {
    const manifest = await readJson(runDirectory, 'launch-run.json');
    expect(manifest.isRealCampaignRun).toBe(false);
    expect(manifest.executionMode).toBe('FIXTURE');
    expect(manifest.runMode).toBe('FIXTURE_DEMO');
    expect(String(manifest.caveat)).toContain('DEMONSTRATION ONLY');
    expect(manifest.requiresHumanApproval).toBe(true);
  });

  it('refuses --execution-mode production for a fixture run', async () => {
    const ctx = await context();
    const code = await runLaunchCli(
      [
        'plan',
        '--request',
        join(workspace, 'request.json'),
        '--benchmark-profile',
        LAUNCH_FIXTURE_BENCHMARK_PROFILE,
        '--output-dir',
        output,
        '--fixture-demo',
        '--execution-mode',
        'production',
      ],
      ctx,
    );
    expect(code).toBe(LAUNCH_EXIT_CODES.EXECUTION_MODE_NOT_ATTAINED);
  });

  it('records that no paid provider call was possible', async () => {
    const manifest = await readJson(runDirectory, 'launch-run.json');
    const cost = manifest.costBasis as {
      paidProviderCallsPossible: boolean;
      estimatedMaximumCostCents: number;
    };
    expect(cost.paidProviderCallsPossible).toBe(false);
    expect(cost.estimatedMaximumCostCents).toBe(0);
  });
});

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InMemoryReferenceStore } from '@combat/database';
import { evaluateOriginality, type CreativeMemoryAgentRole } from '@combat/domain';
import { StructuralBaselineEmbeddingProvider } from '@combat/providers';

import type { ResolvedAsset } from '../asset-resolution';
import { buildSourceEdit } from '../build-source-edit';
import type { CampaignRequest } from '../campaign-request';
import { planCampaign, type CampaignPlan } from '../plan-campaign';
import { selectSources } from '../source-selection';
import { seedBenchmarkProfiles } from './benchmark-profile-commands';
import { seedBenchmarkWorkspace, WORKSPACE_A } from './benchmark-fixture';
import { ContextAwareFixtureReasoningProvider } from './context-aware-fixture-reasoning';
import { InMemoryQdrant } from './in-memory-qdrant';
import { CreativeMemoryInjector } from './injection';
import { buildOriginalityEntries } from './originality-inputs';
import { indexWorkspace } from './retrieval-pipeline';

/**
 * The Creative Memory injection acceptance fixture.
 *
 * Runs the whole planning chain twice against the same synthetic, rights-safe
 * benchmark library — once with Creative Memory ON and once OFF — and compares
 * what actually came out:
 *
 *   campaign request → approved benchmark profile → role-specific retrieval →
 *   agent-safe context → four specialist agents → original campaign plan →
 *   rights-safe render manifest → provenance and originality report
 *
 * **What this proves:** that governed benchmark intelligence reaches the right
 * agent and materially changes hook strategy, the beat plan, a transition
 * decision and a shot specification — and that the manifest it produces still
 * contains only production-eligible assets.
 *
 * **What it does not prove:** anything about creative quality, agency-level
 * craft, or how a real reasoning model would use this context. The reasoning
 * provider here is a deterministic fixture that derives from measurements; it
 * demonstrates the mechanism, not the judgement. No model runs, no endpoint is
 * contacted, no money is spent, and no FFmpeg binary is required — this test
 * ends at the render manifest.
 */

const CAMPAIGN = '99999999-9999-4999-8999-999999999999';
const AT = new Date('2026-07-27T00:00:00.000Z');
const CHECKSUM = (seed: string): string => seed.padEnd(64, '0').slice(0, 64);

const REQUEST: CampaignRequest = {
  requestVersion: 1,
  name: 'combat-reviews-weekend',
  workspaceId: WORKSPACE_A,
  campaignId: CAMPAIGN,
  brandName: 'Combat Reviews',
  campaignPrompt:
    'Promote this weekend’s coverage. Hook on the number of events, then details, predictions and discussion, and finish on Download Free.',
  promptSha256: CHECKSUM('abc'),
  objective: 'Drive installs before the weekend’s events',
  targetAudience: 'Fans who follow more than one promotion',
  platform: 'TIKTOK',
  targetDurationSeconds: 15,
  productFacts: [
    { id: 'coverage', label: 'Coverage', detail: 'Every promotion’s card in one place.' },
  ],
  eventFacts: [],
  keyMessages: ['One card, one place.'],
  mandatories: [],
  cta: { headline: 'Download Free', subline: 'Combat Reviews', durationSeconds: 3 },
  brandKit: {
    logoAssetId: 'logo',
    primaryColorHex: '#0B0B0F',
    accentColorHex: '#FF3B30',
    captionFontFamily: 'Arial',
    safeAreaTopPx: 220,
    safeAreaBottomPx: 420,
  },
  sourceAssetManifest: 'assets.json',
  sourceAssetManifestPath: resolve('assets.json'),
  outputDirectory: '.aamp-output/runs',
  generation: {
    source: 'SOURCE_ONLY',
    comfyuiProfile: 'LTX_2_3_DRAFT',
    generatedShotCount: 0,
    maxGeneratedShotSeconds: 4,
  },
  requestPath: resolve('request.json'),
};

/**
 * Resolved assets, built directly rather than probed.
 *
 * `resolveProductionAssets` is what proves rights, containment, checksums and
 * measurements against real files, and it is tested where it lives. Repeating
 * it here would put an FFmpeg dependency on a test whose subject is planning —
 * so these carry already-measured values, and the assertion that matters (only
 * output-eligible rights reach the manifest) is made on the manifest itself.
 */
function assets(): readonly ResolvedAsset[] {
  const owned = (owner = 'Combat Reviews') => ({
    classification: 'OWNED' as const,
    owner,
    permittedOutputUse: true,
    restrictions: [] as string[],
  });

  return [
    {
      asset: {
        id: 'arena-clip',
        path: 'arena.mp4',
        kind: 'VIDEO',
        role: 'SOURCE_CLIP',
        description: 'Owned arena crowd footage, vertical',
        rights: owned(),
        beats: ['HOOK', 'EVENT_DETAIL'],
        tags: ['coverage', 'promotion'],
      },
      absolutePath: resolve('arena.mp4'),
      sizeBytes: 1000,
      checksumSha256: CHECKSUM('a'),
      measuredDurationSeconds: 12,
      measuredWidthPx: 1080,
      measuredHeightPx: 1920,
      discrepancies: [],
    },
    ...(['information', 'prediction', 'discussion'] as const).map((beat, index) => ({
      asset: {
        id: `app-${beat}`,
        path: `${beat}.png`,
        kind: 'IMAGE' as const,
        role: 'APP_SCREENSHOT' as const,
        description: `Combat Reviews app screen for ${beat}`,
        rights: owned(),
        beats: [beat.toUpperCase() as 'INFORMATION' | 'PREDICTION' | 'DISCUSSION'],
        tags: ['coverage'],
      },
      absolutePath: resolve(`${beat}.png`),
      sizeBytes: 500,
      checksumSha256: CHECKSUM(`b${index}`),
      measuredWidthPx: 1080,
      measuredHeightPx: 1920,
      discrepancies: [],
    })),
    {
      asset: {
        id: 'brand-card',
        path: 'card.png',
        kind: 'IMAGE',
        role: 'BRAND_CARD',
        description: 'Designed Combat Reviews end card',
        rights: owned(),
        beats: ['CTA'],
        tags: [],
      },
      absolutePath: resolve('card.png'),
      sizeBytes: 400,
      checksumSha256: CHECKSUM('c'),
      measuredWidthPx: 1080,
      measuredHeightPx: 1920,
      discrepancies: [],
    },
    {
      asset: {
        id: 'logo',
        path: 'logo.png',
        kind: 'IMAGE',
        role: 'LOGO',
        description: 'Combat Reviews lockup',
        rights: owned(),
        beats: [],
        tags: [],
      },
      absolutePath: resolve('logo.png'),
      sizeBytes: 200,
      checksumSha256: CHECKSUM('d'),
      measuredWidthPx: 600,
      measuredHeightPx: 200,
      discrepancies: [],
    },
  ] as readonly ResolvedAsset[];
}

async function seededInjector(): Promise<CreativeMemoryInjector> {
  const store = new InMemoryReferenceStore();
  await seedBenchmarkWorkspace(store);
  await seedBenchmarkProfiles(store, {
    workspaceId: WORKSPACE_A,
    name: 'combat-reviews-benchmark',
    reviewerId: 'reviewer-1',
    activatedBy: 'operator-1',
    at: AT,
  });

  const embedder = new StructuralBaselineEmbeddingProvider();
  const qdrant = new InMemoryQdrant().asClient();
  await indexWorkspace({ db: store, workspaceId: WORKSPACE_A, embedder, qdrant });

  return new CreativeMemoryInjector({
    mode: 'required',
    dependencies: { db: store, qdrant, embedder },
    workspaceId: WORKSPACE_A,
    campaignId: CAMPAIGN,
    platform: 'TIKTOK',
    now: AT,
  });
}

async function plan(withMemory: boolean): Promise<{
  plan: CampaignPlan;
  injector?: CreativeMemoryInjector;
}> {
  const injector = withMemory ? await seededInjector() : undefined;
  const built = await planCampaign({
    request: REQUEST,
    reasoningProvider: new ContextAwareFixtureReasoningProvider(),
    workflowRunId: 'acceptance-run',
    ...(injector ? { injector } : {}),
  });
  return { plan: built, ...(injector ? { injector } : {}) };
}

function manifestFor(built: CampaignPlan) {
  const library = assets();
  return buildSourceEdit({
    request: REQUEST,
    selections: selectSources({ request: REQUEST, shots: built.shots, assets: library }),
    assets: library,
    captionLines: built.captionLines,
  });
}

describe('Creative Memory injection acceptance: ON versus OFF', () => {
  it('changes the hook strategy', async () => {
    const on = await plan(true);
    const off = await plan(false);

    expect(on.plan.strategy.strategy.keyMessages).not.toEqual(
      off.plan.strategy.strategy.keyMessages,
    );
    expect(on.plan.strategy.strategy.keyMessages[0]).toMatch(/first \d+(\.\d+)? seconds/);
    expect(off.plan.strategy.strategy.keyMessages[0]).not.toMatch(/first \d+(\.\d+)? seconds/);
  });

  it('changes the timing and beat plan', async () => {
    const on = await plan(true);
    const off = await plan(false);

    const beats = (built: CampaignPlan): number[] =>
      built.script.shots.map((shot) => shot.durationFrames);
    expect(beats(on.plan)).not.toEqual(beats(off.plan));
    expect(on.plan.script.shots.length).not.toBe(off.plan.script.shots.length);
    // Whatever the beat plan is, it must still add up exactly.
    expect(beats(on.plan).reduce((sum, frames) => sum + frames, 0)).toBe(
      on.plan.script.totalDurationFrames,
    );
  });

  it('changes a motion or transition decision', async () => {
    const on = await plan(true);
    const off = await plan(false);

    const first = (built: CampaignPlan) => built.shotBriefs[0];
    expect(first(on.plan)?.transitionIn ?? first(on.plan)?.motionIntensity).toBeDefined();
    expect([first(on.plan)?.transitionIn, first(on.plan)?.motionIntensity]).not.toEqual([
      first(off.plan)?.transitionIn,
      first(off.plan)?.motionIntensity,
    ]);
  });

  it('changes the shot specification', async () => {
    const on = await plan(true);
    const off = await plan(false);

    expect(on.plan.shotBriefs[0]?.cameraMovement).not.toBe(off.plan.shotBriefs[0]?.cameraMovement);
    expect(on.plan.shotBriefs[0]?.promptText).not.toBe(off.plan.shotBriefs[0]?.promptText);
  });

  it('changes the resulting render manifest', async () => {
    const on = manifestFor((await plan(true)).plan);
    const off = manifestFor((await plan(false)).plan);

    expect(on.scenes.length).not.toBe(off.scenes.length);
    expect(JSON.stringify(on.scenes)).not.toBe(JSON.stringify(off.scenes));
  });
});

describe('the plan produced with Creative Memory is still rights-safe', () => {
  it('puts only production-eligible assets in the manifest', async () => {
    const manifest = manifestFor((await plan(true)).plan);
    for (const source of manifest.sources) {
      expect(['OWNED', 'LICENSED_FOR_OUTPUT']).toContain(source.license.usageClass);
    }
  });

  it('never puts a reference id, path or scene id into the manifest', async () => {
    const { plan: built } = await plan(true);
    const serialised = JSON.stringify(manifestFor(built));
    const referenceIds = new Set(
      built.roleContexts.flatMap(
        (record) => record.context?.items.map((item) => item.referenceId) ?? [],
      ),
    );
    expect(referenceIds.size).toBeGreaterThan(0);
    for (const referenceId of referenceIds) {
      expect(serialised).not.toContain(referenceId);
    }
    expect(serialised).not.toContain('.aamp-reference-analysis');
  });
});

describe('provenance and originality', () => {
  it('records a context, a divergence record and scores for every role that used one', async () => {
    const { plan: built, injector } = await plan(true);

    const roles = new Set<CreativeMemoryAgentRole>(
      built.roleContexts.filter((record) => record.context).map((record) => record.agentRole),
    );
    expect([...roles].sort()).toEqual([
      'CAMPAIGN_STRATEGIST',
      'CREATIVE_DIRECTOR',
      'SCRIPT_TIMING_DIRECTOR',
      'SHOT_PROMPT_ENGINEER',
    ]);

    for (const record of built.roleContexts) {
      expect(record.divergence, `${record.agentRole} returned no divergence record`).toBeDefined();
      expect(record.divergence?.campaignSpecificTransformation.length).toBeGreaterThan(0);
    }

    const audits = injector?.audits ?? [];
    expect(audits.length).toBe(built.roleContexts.length);
    for (const audit of audits) {
      expect(audit.governanceDecision).toBe('CONTEXT_INJECTED');
      expect(audit.queryHash).toMatch(/^[0-9a-f]{64}$/);
      expect(audit.contextHash).toMatch(/^[0-9a-f]{64}$/);
      expect(audit.benchmarkProfile?.name).toBe('combat-reviews-benchmark');
      expect(audit.retrievalProfile).toBe('STRUCTURAL_BASELINE_V1');
      expect(audit.anyReferenceOutputEligible).toBe(false);
      for (const item of audit.items) {
        expect(item.annotationId).toBeTruthy();
        expect(typeof item.retrievalScore).toBe('number');
        expect(typeof item.rerankScore).toBe('number');
      }
    }
  });

  it('evaluates the plan as LOW originality risk and does not block it', async () => {
    const { plan: built } = await plan(true);
    const assessment = evaluateOriginality(buildOriginalityEntries(built));

    expect(assessment.signals).toEqual([]);
    expect(assessment.riskLevel).toBe('LOW');
    expect(assessment.blocked).toBe(false);
    expect(assessment.rolesWithContext.length).toBe(built.roleContexts.length);
  });

  it('turning Creative Memory off changes what the agents were given', async () => {
    const on = await plan(true);
    const off = await plan(false);

    expect(on.plan.roleContexts.every((record) => record.context !== undefined)).toBe(true);
    // OFF still records that each agent ran — with no context and nothing to
    // diverge from. An absent record and a record of absence are different
    // claims, and provenance should make the second one.
    expect(off.plan.roleContexts.length).toBeGreaterThan(0);
    expect(off.plan.roleContexts.every((record) => record.context === undefined)).toBe(true);
    expect(off.plan.roleContexts.every((record) => record.divergence === undefined)).toBe(true);
    expect(evaluateOriginality(buildOriginalityEntries(off.plan)).rolesWithContext).toEqual([]);
    expect(evaluateOriginality(buildOriginalityEntries(off.plan)).signals).toEqual([]);
  });
});

describe('the three human approval gates are untouched', () => {
  it('has no path from this milestone’s code to an approval signal', async () => {
    // UI visibility is never authorization, and neither is a CLI. The approval
    // signals are dispatched only from apps/api; a source-level check is the
    // cheap way to keep it that way as this area grows.
    const files = [
      'injection.ts',
      'role-context.ts',
      'originality-inputs.ts',
      'benchmark-profile-commands.ts',
      'context-aware-fixture-reasoning.ts',
    ];
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop -- read in declared order for a stable failure
      const source = await readFile(resolve(__dirname, file), 'utf8');
      expect(source).not.toMatch(/approveConcept|selectShots|approveFinal/);
    }
  });
});

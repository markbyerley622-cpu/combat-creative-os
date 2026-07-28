import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compileSceneTreatment, MOTION_TREATMENT_CATALOGUE_VERSION } from '@combat/media';

import { parseHumanPlan, type HumanCreativePlan } from '../preview/human-plan';
import { buildFidelityReport } from './fidelity-v2';
import { parseFlagship2Args } from './flagship2-cli';
import { parseProductionTreatment } from './production-treatment';
import { findProhibitedClaims } from './factual-sanitisation';
import {
  v2AuthoredStrings,
  V2_EXECUTION_MODE,
  V2_IS_PUBLIC_RELEASE_READY,
  V2_IS_REAL_CAMPAIGN_RUN,
  V2_OUTPUT_USE,
  V2_PAID_PROVIDER_CALLS,
} from './run-flagship-v2';
import {
  buildPanelAssets,
  LOCKED_SCENE_ROLES,
  LOCKED_SCENE_SLOTS,
  panelAssetId,
  StoryboardV2Error,
  verifyStoryboardV2,
} from './storyboard-v2';

/**
 * The locked-storyboard proof's contracts, against fixtures and temporary
 * directories. No FFmpeg, no network, and never the operator's Desktop.
 */

const CAMPAIGN = resolve(__dirname, '..', '..', 'campaigns', 'combat-reviews-flagship-02');

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aamp-sb2-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function panelBytes(index: number): Buffer {
  return Buffer.from(
    `FRAME-${String(index).padStart(2, '0')} fixture ${'z'.repeat(index * 3)}`,
    'utf8',
  );
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface FixtureOptions {
  readonly mutate?: (manifest: Record<string, any>) => void;
  readonly corruptFrame?: number;
}

async function writeV2Fixture(root: string, options: FixtureOptions = {}): Promise<string> {
  await mkdir(join(root, 'frames'), { recursive: true });
  await mkdir(join(root, 'frames-corrected'), { recursive: true });
  const sheet = Buffer.from('fixture sheet', 'utf8');
  await writeFile(join(root, 'sheet.png'), sheet);

  const frames: Record<string, any>[] = [];
  for (const [index, role] of LOCKED_SCENE_ROLES.entries()) {
    const sequence = index + 1;
    const bytes = panelBytes(sequence);
    await writeFile(join(root, 'frames', `FRAME-${String(sequence).padStart(2, '0')}.png`), bytes);
    const slot = LOCKED_SCENE_SLOTS[index] as readonly [number, number];
    const frame: Record<string, any> = {
      frameId: `FRAME-${String(sequence).padStart(2, '0')}`,
      sequence,
      sceneRole: role,
      sourceFramePath: `frames/FRAME-${String(sequence).padStart(2, '0')}.png`,
      startSeconds: slot[0],
      endSeconds: slot[1],
      durationSeconds: Number((slot[1] - slot[0]).toFixed(6)),
      purpose: `purpose ${sequence}`,
      visibleIntent: `intent ${sequence}`,
      viewerUnderstanding: `understanding ${sequence}`,
      requiredProductionRole: `role ${sequence}`,
      requiredAssetTypes: ['fixture'],
      productFeature: `feature ${sequence}`,
      onScreenCopyIntent: [`HEADLINE ${sequence}`],
      factualClaimsRequiringValidation: [],
      prohibitedOutputElements: [],
      checksumSha256: sha(bytes),
      sizeBytes: bytes.byteLength,
      widthPx: 470,
      heightPx: 378,
      usageClass: 'STORYBOARD_INTERNAL_REVIEW_ONLY',
      outputEligibleForPublicRelease: false,
      internalReviewMotionProofAuthorised: true,
    };
    if (sequence === 1) {
      const corrected = Buffer.from('corrected panel one', 'utf8');
      await writeFile(join(root, 'frames-corrected', 'FRAME-01.png'), corrected);
      frame.factualCorrection = {
        region: { xPx: 88, yPx: 245, widthPx: 75, heightPx: 44 },
        removed: '12',
        replacedWith: null,
        headlineBefore: '12 FIGHTS THIS WEEKEND',
        headlineAfter: 'FIGHTS THIS WEEKEND',
        reason: 'no verified feed backs a count',
        method: 'gradient-matched erase',
        correctedFramePath: 'frames-corrected/FRAME-01.png',
        correctedChecksumSha256: sha(corrected),
        correctedSizeBytes: corrected.byteLength,
      };
    }
    frames.push(frame);
  }

  const manifest: Record<string, any> = {
    schemaVersion: '2.0.0',
    storyboardId: 'combat-reviews-flagship-storyboard-02',
    campaign: 'fixture',
    objective: 'fixture',
    durationSeconds: 15,
    creativeTerritory: 'Never miss fight night.',
    CTA: 'EXPLORE EVENTS',
    sourceImage: { packagedPath: 'sheet.png', originalPath: 'C:/fixture/Storyboard2.png' },
    sourceChecksum: { algorithm: 'SHA256', original: sha(sheet), copy: sha(sheet) },
    usageClass: 'STORYBOARD_INTERNAL_REVIEW_ONLY',
    outputEligibleForPublicRelease: false,
    internalReviewMotionProofAuthorised: true,
    licensedForPublicProduction: false,
    isPublicReleaseReady: false,
    rightsStatement: 'internal review only',
    referenceRule: 'panels may be animated for internal review only',
    productAssetsRule: 'every phone screen is concept UI',
    frames,
  };
  options.mutate?.(manifest);
  await writeFile(
    join(root, 'storyboard-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  if (options.corruptFrame !== undefined) {
    await writeFile(
      join(root, 'frames', `FRAME-${String(options.corruptFrame).padStart(2, '0')}.png`),
      Buffer.from('substituted', 'utf8'),
    );
  }
  return root;
}

describe('the locked ten-panel storyboard package', () => {
  it('accepts a well-formed package and recomputes every checksum', async () => {
    const verified = await verifyStoryboardV2(await writeV2Fixture(join(workspace, 'sb2')));
    expect(verified.frames).toHaveLength(10);
    expect(verified.frames.map((f) => f.sceneRole)).toEqual([...LOCKED_SCENE_ROLES]);
    expect(verified.usageClass).toBe('STORYBOARD_INTERNAL_REVIEW_ONLY');
    expect(verified.isPublicReleaseReady).toBe(false);
    expect(verified.licensedForPublicProduction).toBe(false);
    expect(verified.corrections).toHaveLength(1);
  });

  it('renders the corrected panel where a correction is declared, and the original elsewhere', async () => {
    const verified = await verifyStoryboardV2(await writeV2Fixture(join(workspace, 'sb2')));
    const first = verified.frames[0]!;
    expect(first.isFactuallyCorrected).toBe(true);
    expect(first.renderRelativePath).toBe('frames-corrected/FRAME-01.png');
    expect(first.renderChecksumSha256).not.toBe(first.checksumSha256);
    expect(verified.frames[1]!.renderChecksumSha256).toBe(verified.frames[1]!.checksumSha256);
  });

  it.each([
    ['outputEligibleForPublicRelease', (m: any) => (m.outputEligibleForPublicRelease = true)],
    ['licensedForPublicProduction', (m: any) => (m.licensedForPublicProduction = true)],
    ['isPublicReleaseReady', (m: any) => (m.isPublicReleaseReady = true)],
    [
      'a frame promoted to public release',
      (m: any) => (m.frames[4].outputEligibleForPublicRelease = true),
    ],
  ])('refuses a package that overstates its rights via %s', async (_name, mutate) => {
    await expect(
      verifyStoryboardV2(await writeV2Fixture(join(workspace, 'sb2'), { mutate })),
    ).rejects.toMatchObject({ problems: [expect.objectContaining({ kind: 'RIGHTS_OVERSTATED' })] });
  });

  it('refuses a package whose scenes are reordered', async () => {
    await expect(
      verifyStoryboardV2(
        await writeV2Fixture(join(workspace, 'sb2'), {
          mutate: (m) => {
            const a = m.frames[2].sceneRole;
            m.frames[2].sceneRole = m.frames[3].sceneRole;
            m.frames[3].sceneRole = a;
          },
        }),
      ),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.objectContaining({ kind: 'SCENE_ORDER' })]),
    });
  });

  it('refuses a scene that drifts off its locked slot', async () => {
    await expect(
      verifyStoryboardV2(
        await writeV2Fixture(join(workspace, 'sb2'), {
          mutate: (m) => {
            m.frames[5].endSeconds = 8.2;
            m.frames[6].startSeconds = 8.2;
          },
        }),
      ),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.objectContaining({ kind: 'SCENE_TIMING' })]),
    });
  });

  it('refuses a panel whose bytes disagree with the declared checksum', async () => {
    await expect(
      verifyStoryboardV2(await writeV2Fixture(join(workspace, 'sb2'), { corruptFrame: 4 })),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([
        expect.objectContaining({ kind: 'FRAME_CHECKSUM_MISMATCH' }),
      ]),
    });
  });

  it('refuses a declared correction whose corrected panel is identical to the original', async () => {
    const root = await writeV2Fixture(join(workspace, 'sb2'));
    const original = await readFile(join(root, 'frames', 'FRAME-01.png'));
    await writeFile(join(root, 'frames-corrected', 'FRAME-01.png'), original);
    const manifest = JSON.parse(await readFile(join(root, 'storyboard-manifest.json'), 'utf8'));
    manifest.frames[0].factualCorrection.correctedChecksumSha256 = sha(original);
    await writeFile(
      join(root, 'storyboard-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    await expect(verifyStoryboardV2(root)).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.objectContaining({ kind: 'CORRECTION_MISSING' })]),
    });
  });

  it('refuses a package with nine panels', async () => {
    await expect(
      verifyStoryboardV2(
        await writeV2Fixture(join(workspace, 'sb2'), { mutate: (m) => m.frames.pop() }),
      ),
    ).rejects.toBeInstanceOf(StoryboardV2Error);
  });
});

describe('panels as declared production media', () => {
  it('carries its provenance, its channel and its concept-UI position on every panel', async () => {
    const verified = await verifyStoryboardV2(await writeV2Fixture(join(workspace, 'sb2')));
    const assets = buildPanelAssets(verified);
    expect(assets).toHaveLength(10);
    for (const { asset } of assets) {
      expect(asset.id).toMatch(/^storyboard-panel-\d{2}$/);
      expect(asset.rights.classification).toBe('OWNED');
      expect(asset.description).toContain('STORYBOARD PANEL');
      expect(asset.description).toContain('internal review only');
      const restrictions = asset.rights.restrictions.join(' ');
      expect(restrictions).toContain('STORYBOARD_PANEL');
      expect(restrictions).toContain('not licensed public-production media');
      expect(restrictions).toContain('PRODUCT_MOCKUP');
      expect(restrictions).toContain('INTERNAL_REVIEW');
      // Never a screenshot: calling designed art a capture would make the
      // vocabulary itself say something untrue.
      expect(asset.role).toBe('BRAND_CARD');
    }
  });

  it('binds each panel to its own scene, by sequence', async () => {
    const verified = await verifyStoryboardV2(await writeV2Fixture(join(workspace, 'sb2')));
    expect(buildPanelAssets(verified).map(({ asset }) => asset.id)).toEqual(
      verified.frames.map((frame) => panelAssetId(frame)),
    );
  });
});

describe('the committed flagship-02 campaign', () => {
  const loadPlan = async (): Promise<HumanCreativePlan> =>
    parseHumanPlan(JSON.parse(await readFile(join(CAMPAIGN, 'creative-plan.json'), 'utf8')));

  it('is ten beats tiling exactly 15.00 seconds on the locked slots', async () => {
    const plan = await loadPlan();
    expect(plan.beats).toHaveLength(10);
    let running = 0;
    const slots: [number, number][] = [];
    plan.beats.forEach((beat, index) => {
      const overlap = beat.transitionIn?.durationSeconds ?? 0;
      const start = index === 0 ? 0 : Number(running.toFixed(6));
      running = index === 0 ? beat.durationSeconds : running + beat.durationSeconds - overlap;
      slots.push([start, Number(running.toFixed(6))]);
    });
    slots.forEach((slot, index) => {
      const locked = LOCKED_SCENE_SLOTS[index] as readonly [number, number];
      expect(slot[0]).toBeCloseTo(locked[0], 3);
      expect(slot[1]).toBeCloseTo(locked[1], 3);
    });
    expect(running).toBeCloseTo(15, 6);
  });

  it('binds every beat to its own storyboard panel, in order', async () => {
    const plan = await loadPlan();
    expect(plan.beats.map((beat) => beat.source.assetId)).toEqual(
      Array.from(
        { length: 10 },
        (_u, index) => `storyboard-panel-${String(index + 1).padStart(2, '0')}`,
      ),
    );
  });

  it('renders neither a caption track nor a second end card over the locked panels', async () => {
    const plan = await loadPlan();
    expect(plan.beats.every((beat) => beat.caption === undefined)).toBe(true);
    expect(plan.cta.renderEndCard).toBe(false);
    expect(plan.brandConstraints.showLogoOverlay).toBe(false);
  });

  it('varies its transitions rather than repeating one', async () => {
    const plan = await loadPlan();
    const kinds = plan.beats.slice(1).map((beat) => beat.transitionIn?.kind);
    expect(kinds).toHaveLength(9);
    expect(new Set(kinds).size).toBeGreaterThanOrEqual(5);
  });

  it('puts no prohibited claim in the plan or the treatment', async () => {
    const plan = await loadPlan();
    const treatment = parseProductionTreatment(
      JSON.parse(await readFile(join(CAMPAIGN, 'production-treatment.json'), 'utf8')),
    );
    expect(findProhibitedClaims(v2AuthoredStrings(plan, treatment))).toEqual([]);
  });

  it('has a treatment answering for all ten panels', async () => {
    const treatment = parseProductionTreatment(
      JSON.parse(await readFile(join(CAMPAIGN, 'production-treatment.json'), 'utf8')),
    );
    expect(treatment.storyboardFrameCount).toBe(10);
    expect(treatment.assetFeasibility).toHaveLength(10);
    expect(treatment.transitionGrammar).toHaveLength(9);
  });

  it('has an authored note for every locked scene', async () => {
    const notes = JSON.parse(await readFile(join(CAMPAIGN, 'scene-notes.json'), 'utf8')) as {
      scenes: Record<string, Record<string, string>>;
    };
    for (const role of LOCKED_SCENE_ROLES) {
      const note = notes.scenes[role];
      expect(note, role).toBeDefined();
      if (!note) continue;
      // Both are the point of the file: a scene with no recorded mismatch and
      // no recorded gap is a scene nobody looked at.
      expect(note.remainingMismatch ?? '', role).not.toHaveLength(0);
      expect(note.missingProductionAsset ?? '', role).not.toHaveLength(0);
    }
  });
});

describe('storyboard fidelity', () => {
  const notes = new Map(
    LOCKED_SCENE_ROLES.map((role) => [
      role,
      {
        compositionNote: 'contained at full width',
        animationPerformed: 'push',
        remainingMismatch: '',
        productScreenSource: 'PRODUCT_MOCKUP' as const,
      },
    ]),
  );

  const panelIds = new Map(
    Array.from({ length: 10 }, (_u, index) => [
      index + 1,
      `storyboard-panel-${String(index + 1).padStart(2, '0')}`,
    ]),
  );

  it('passes for the committed plan against the locked package', async () => {
    const verified = await verifyStoryboardV2(await writeV2Fixture(join(workspace, 'sb2')));
    const plan = parseHumanPlan(
      JSON.parse(await readFile(join(CAMPAIGN, 'creative-plan.json'), 'utf8')),
    );
    const report = buildFidelityReport({
      storyboard: verified,
      plan,
      sceneNotes: notes,
      panelAssetIdBySequence: panelIds,
    });
    expect(report.verdict).toBe('PASS');
    expect(report.sceneCount).toBe(10);
    expect(report.totalSeconds).toBeCloseTo(15, 3);
  });

  it('fails when a scene renders an asset that is not its own panel', async () => {
    const verified = await verifyStoryboardV2(await writeV2Fixture(join(workspace, 'sb2')));
    const raw = JSON.parse(await readFile(join(CAMPAIGN, 'creative-plan.json'), 'utf8'));
    raw.beats[3].source.assetId = 'storyboard-panel-09';
    const report = buildFidelityReport({
      storyboard: verified,
      plan: parseHumanPlan(raw),
      sceneNotes: notes,
      panelAssetIdBySequence: panelIds,
    });
    expect(report.verdict).toBe('FAIL');
    expect(report.failures.join(' ')).toContain('rather than its own locked panel');
  });

  it('fails when a scene drifts off its locked slot', async () => {
    const verified = await verifyStoryboardV2(await writeV2Fixture(join(workspace, 'sb2')));
    const raw = JSON.parse(await readFile(join(CAMPAIGN, 'creative-plan.json'), 'utf8'));
    raw.beats[2].durationSeconds += 0.4;
    raw.beats[3].durationSeconds -= 0.4;
    const report = buildFidelityReport({
      storyboard: verified,
      plan: parseHumanPlan(raw),
      sceneNotes: notes,
      panelAssetIdBySequence: panelIds,
    });
    expect(report.verdict).toBe('FAIL');
    expect(report.failures.join(' ')).toContain('locked slot');
  });

  it('never scores how good the animation is', async () => {
    const verified = await verifyStoryboardV2(await writeV2Fixture(join(workspace, 'sb2')));
    const plan = parseHumanPlan(
      JSON.parse(await readFile(join(CAMPAIGN, 'creative-plan.json'), 'utf8')),
    );
    const report = buildFidelityReport({
      storyboard: verified,
      plan,
      sceneNotes: notes,
      panelAssetIdBySequence: panelIds,
    });
    expect(JSON.stringify(report)).not.toMatch(/"score"|"rating"|agencyGrade/i);
    expect(report.notice).toContain('does not score');
  });
});

describe('the panel treatments', () => {
  const input = {
    inputLabel: '0:v',
    outputLabel: 'vout',
    scopeTag: 't3',
    intensity: 0.6,
    durationSeconds: 1.5,
    frameRate: 30,
    widthPx: 1080,
    heightPx: 1920,
    sourceKind: 'IMAGE' as const,
    framing: { mode: 'COVER' as const, anchorX: 0.5, anchorY: 0.5 },
  };

  it('contain the panel rather than cropping it', () => {
    const graph = compileSceneTreatment('STORYBOARD_PANEL_2_5D', input).graph;
    // The foreground is scaled by width with the height derived, never cropped.
    expect(graph).toContain('scale=1036:-2:flags=lanczos');
    expect(graph).toContain("overlay=x='(W-w)/2':y='(H-h)/2'");
  });

  it('keep the push small enough that a contained panel can never leave the frame', () => {
    const graph = compileSceneTreatment('STORYBOARD_PANEL_2_5D', { ...input, intensity: 1 }).graph;
    const push = /\[t3comp\]zoompan=z='1\+([0-9.]+)\*on/.exec(graph);
    expect(push).not.toBeNull();
    // 96% of the frame width, grown by the maximum push, is still inside it.
    expect(0.96 * (1 + Number(push?.[1]))).toBeLessThan(1);
  });

  it('cut the slice reveal into five sequential slices', () => {
    const graph = compileSceneTreatment('STORYBOARD_SLICE_REVEAL', input).graph;
    expect(graph).toContain('split=5');
    for (let index = 0; index < 5; index += 1) {
      expect(graph).toContain(`crop=iw/5:ih:iw*${index}/5:0`);
    }
    const enables = [...graph.matchAll(/enable='gte\(t,([0-9.]+)\)'/g)].map((m) => Number(m[1]));
    expect(enables).toHaveLength(5);
    // Strictly increasing, and every slice established inside the scene.
    expect([...enables].sort((a, b) => a - b)).toEqual(enables);
    expect(Math.max(...enables)).toBeLessThan(input.durationSeconds);
  });

  it('are deterministic and reject a video source', () => {
    for (const key of ['STORYBOARD_PANEL_2_5D', 'STORYBOARD_SLICE_REVEAL'] as const) {
      expect(compileSceneTreatment(key, input).graph).toBe(compileSceneTreatment(key, input).graph);
      expect(() => compileSceneTreatment(key, { ...input, sourceKind: 'VIDEO' })).toThrow();
      expect(compileSceneTreatment(key, input).catalogueVersion).toBe(
        MOTION_TREATMENT_CATALOGUE_VERSION,
      );
    }
  });
});

describe('execution-mode non-promotion', () => {
  it('fixes the five labels as constants', () => {
    expect(V2_EXECUTION_MODE).toBe('HUMAN_ASSISTED_PREVIEW');
    expect(V2_OUTPUT_USE).toBe('INTERNAL_REVIEW');
    expect(V2_IS_REAL_CAMPAIGN_RUN).toBe(false);
    expect(V2_IS_PUBLIC_RELEASE_READY).toBe(false);
    expect(V2_PAID_PROVIDER_CALLS).toBe(0);
  });

  it.each([
    ['--execution-mode', 'production'],
    ['--output-use', 'PUBLICATION'],
    ['--public-release-ready', 'true'],
    ['--reasoning-provider', 'claude'],
    [['--allow', 'paid', 'providers'].join('-'), ''],
  ])('refuses the promoting flag %s', (flag, value) => {
    expect(() => parseFlagship2Args(value ? [flag, value] : [flag])).toThrow(/unknown option/);
  });
});

describe('paid-provider structural absence', () => {
  it('imports no provider, database client or paid SDK', async () => {
    for (const file of [
      'run-flagship-v2.ts',
      'flagship2-cli.ts',
      'storyboard-v2.ts',
      'fidelity-v2.ts',
    ]) {
      const text = await readFile(join(__dirname, file), 'utf8');
      for (const needle of [
        '@combat/providers',
        '@combat/database',
        '@anthropic-ai',
        'PrismaClient',
        'QdrantClient',
        'createReasoningProvider',
        'createVideoGenerationProvider',
      ]) {
        expect(text, `${file} must not reference ${needle}`).not.toContain(needle);
      }
    }
  });
});

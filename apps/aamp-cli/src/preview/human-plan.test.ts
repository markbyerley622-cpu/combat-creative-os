import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadCampaignRequest, type CampaignRequest } from '../campaign-request';
import {
  buildHumanPlanTemplate,
  HumanPlanValidationError,
  loadHumanPlan,
  parseHumanPlan,
} from './human-plan';

/**
 * The plan is the entire input to a mode that renders a finished, downloadable
 * advertisement, so the interesting cases are all the ones where it should be
 * refused. A plan that is merely *nearly* right must not render — a preview
 * that silently differs from the plan somebody approved is worse than no
 * preview.
 */

const EXAMPLES = resolve(__dirname, '..', '..', 'examples');
const REQUEST_PATH = join(EXAMPLES, 'combat-reviews-preview.request.json');
const PLAN_PATH = join(EXAMPLES, 'combat-reviews-preview.plan.json');

async function loadPlanJson(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(PLAN_PATH, 'utf8')) as Record<string, any>;
}

/** The committed plan with one branch mutated — every negative case starts from something valid. */
async function planWith(mutate: (plan: Record<string, any>) => void): Promise<Record<string, any>> {
  const plan = await loadPlanJson();
  mutate(plan);
  return plan;
}

function expectRejected(value: unknown): HumanPlanValidationError {
  try {
    parseHumanPlan(value);
  } catch (error) {
    expect(error).toBeInstanceOf(HumanPlanValidationError);
    return error as HumanPlanValidationError;
  }
  throw new Error('expected the plan to be rejected, but it parsed');
}

describe('human creative plan — the committed example', () => {
  it('parses, and describes the campaign it claims to', async () => {
    const plan = parseHumanPlan(await loadPlanJson());
    expect(plan.planVersion).toBe(1);
    expect(plan.targetDurationSeconds).toBe(15);
    expect(plan.beats).toHaveLength(5);
    expect(plan.beats.at(-1)?.role).toBe('CTA');
    expect(plan.authoredBy.length).toBeGreaterThan(0);
  });

  it('carries every decision the pipeline would otherwise ask an agent for', async () => {
    const plan = parseHumanPlan(await loadPlanJson());
    expect(plan.strategy.positioning.length).toBeGreaterThan(0);
    expect(plan.creativeDirection.visualDirection.length).toBeGreaterThan(0);
    expect(plan.hook.onScreenLine.length).toBeGreaterThan(0);
    expect(plan.factualConstraints.length).toBeGreaterThan(0);
    expect(plan.brandConstraints.logoAssetId.length).toBeGreaterThan(0);
    expect(plan.cta.holdSeconds).toBeGreaterThan(0);
    // Beat timing, shot specification, transitions, motion, captions and audio
    // intentions all present on the beats themselves.
    for (const beat of plan.beats) {
      expect(beat.durationSeconds).toBeGreaterThan(0);
      expect(beat.motion.treatment.length).toBeGreaterThan(0);
      expect(beat.source).toBeDefined();
    }
    expect(plan.beats.slice(1).every((beat) => beat.transitionIn)).toBe(true);
    expect(plan.beats.some((beat) => beat.caption)).toBe(true);
    expect(plan.beats.some((beat) => beat.audioCues.length > 0)).toBe(true);
  });

  it('lands its timeline exactly on the requested duration', async () => {
    const plan = parseHumanPlan(await loadPlanJson());
    const beats = plan.beats.reduce((sum, beat) => sum + beat.durationSeconds, 0);
    const overlaps = plan.beats.reduce(
      (sum, beat) => sum + (beat.transitionIn?.durationSeconds ?? 0),
      0,
    );
    expect(beats - overlaps).toBeCloseTo(plan.targetDurationSeconds, 6);
  });
});

describe('human creative plan — strict validation', () => {
  it('refuses an unknown field instead of silently ignoring it', async () => {
    const error = expectRejected(await planWith((plan) => (plan.renderer = 'aerender')));
    expect(error.message).toContain('Unrecognized key');
  });

  it('refuses a plan with no author, because the mode claims a person made it', async () => {
    const error = expectRejected(await planWith((plan) => delete plan.authoredBy));
    expect(error.issues.some((issue) => issue.path === 'authoredBy')).toBe(true);
  });

  it('refuses a timeline that does not add up to the requested duration', async () => {
    const error = expectRejected(await planWith((plan) => (plan.beats[0].durationSeconds = 9)));
    expect(error.message).toContain('targetDurationSeconds');
  });

  it('refuses non-contiguous beat indices', async () => {
    const error = expectRejected(await planWith((plan) => (plan.beats[2].index = 7)));
    expect(error.message).toContain('indices must be contiguous');
  });

  it('refuses a duplicate beat id', async () => {
    const error = expectRejected(await planWith((plan) => (plan.beats[2].id = plan.beats[1].id)));
    expect(error.message).toContain('duplicate beat id');
  });

  it('refuses a transitionIn on the first beat and a missing one on any later beat', async () => {
    const first = expectRejected(
      await planWith(
        (plan) => (plan.beats[0].transitionIn = { kind: 'CUT', durationSeconds: 0.3 }),
      ),
    );
    expect(first.message).toContain('first beat cannot have a transitionIn');
    const later = expectRejected(await planWith((plan) => delete plan.beats[2].transitionIn));
    expect(later.message).toContain('must declare a transitionIn');
  });

  it('refuses a transition as long as the beat it enters', async () => {
    const error = expectRejected(
      // Exactly the beat's own length: a transition that consumes the whole
      // shot it enters leaves nothing of that shot on screen.
      await planWith((plan) => (plan.beats[1].transitionIn.durationSeconds = 3.6)),
    );
    expect(error.message).toContain('cannot be as long as the beat');
  });

  it('refuses a plan that does not end on its CTA beat', async () => {
    const error = expectRejected(await planWith((plan) => (plan.beats[4].role = 'INFORMATION')));
    expect(error.message).toContain('must end on its CTA beat');
  });

  it('refuses a CTA hold longer than the card itself', async () => {
    const error = expectRejected(await planWith((plan) => (plan.cta.holdSeconds = 9)));
    expect(error.message).toContain('hold cannot outlast the card');
  });

  it('refuses an audio cue with no asset behind it', async () => {
    const error = expectRejected(await planWith((plan) => (plan.audio.cueAssetIds = {})));
    expect(error.message).toContain('no asset in audio.cueAssetIds');
  });

  it('refuses an audio cue landing past the end of its own beat', async () => {
    const error = expectRejected(
      await planWith((plan) => (plan.beats[0].audioCues[0].atOffsetSeconds = 30)),
    );
    expect(error.message).toContain('audio cue');
  });

  it('refuses an unknown motion treatment rather than falling back to a static hold', async () => {
    const error = expectRejected(
      await planWith((plan) => (plan.beats[0].motion.treatment = 'SWIRL')),
    );
    expect(error.issues.some((issue) => issue.path.includes('motion'))).toBe(true);
  });

  it('refuses a plan that asks for imitation, naming what it forbids', async () => {
    const error = expectRejected(
      await planWith(
        (plan) =>
          (plan.creativeDirection.visualDirection =
            'Shoot it in the style of a famous drinks brand.'),
      ),
    );
    expect(error.message).toContain('never by naming or imitating');
  });

  it('refuses a shot-for-shot recreation brief', async () => {
    const error = expectRejected(
      await planWith((plan) => (plan.hook.strategy = 'Recreate the campaign shot-for-shot.')),
    );
    expect(error.message).toContain('never by naming or imitating');
  });
});

describe('human creative plan — binding to one brief', () => {
  let request: CampaignRequest;
  let workDir: string;

  beforeAll(async () => {
    request = await loadCampaignRequest(REQUEST_PATH);
    workDir = await mkdtemp(join(tmpdir(), 'human-plan-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  const writePlan = async (mutate: (plan: Record<string, any>) => void): Promise<string> => {
    const plan = await planWith(mutate);
    const target = join(workDir, `plan-${Math.abs(JSON.stringify(plan).length)}.json`);
    await writeFile(target, JSON.stringify(plan, null, 2), 'utf8');
    return target;
  };

  it('accepts the committed plan against the committed request', async () => {
    const plan = await loadHumanPlan(PLAN_PATH, request);
    expect(plan.campaignPromptSha256).toBe(request.promptSha256);
  });

  it('preserves the campaign-prompt hash, and refuses a plan written against another brief', async () => {
    const path = await writePlan((plan) => (plan.campaignPromptSha256 = 'a'.repeat(64)));
    await expect(loadHumanPlan(path, request)).rejects.toThrow(/Re-author the plan/);
  });

  it('refuses a plan for a different campaign', async () => {
    const path = await writePlan(
      (plan) => (plan.campaignId = '11111111-2222-3333-4444-555555555555'),
    );
    await expect(loadHumanPlan(path, request)).rejects.toThrow(/plan is for campaign/);
  });

  it('refuses a plan for a different workspace', async () => {
    const path = await writePlan(
      (plan) => (plan.workspaceId = '11111111-2222-3333-4444-555555555555'),
    );
    await expect(loadHumanPlan(path, request)).rejects.toThrow(/plan is for workspace/);
  });

  it('refuses a plan cut for a different duration', async () => {
    const path = await writePlan((plan) => {
      plan.targetDurationSeconds = 20;
      plan.beats[0].durationSeconds += 5;
    });
    await expect(loadHumanPlan(path, request)).rejects.toThrow(/plan is cut for/);
  });

  it('refuses a plan that uses a different logo from the request', async () => {
    const path = await writePlan((plan) => (plan.brandConstraints.logoAssetId = 'other-logo'));
    await expect(loadHumanPlan(path, request)).rejects.toThrow(/plan uses logo/);
  });
});

describe('human creative plan — the emitted template', () => {
  it('is deterministic for one request and instant', async () => {
    const request = await loadCampaignRequest(REQUEST_PATH);
    const at = '2026-07-27T00:00:00.000Z';
    expect(JSON.stringify(buildHumanPlanTemplate(request, at))).toBe(
      JSON.stringify(buildHumanPlanTemplate(request, at)),
    );
  });

  it('is bound to the request it was emitted for', async () => {
    const request = await loadCampaignRequest(REQUEST_PATH);
    const template = buildHumanPlanTemplate(request, '2026-07-27T00:00:00.000Z');
    expect(template.campaignPromptSha256).toBe(request.promptSha256);
    expect(template.campaignId).toBe(request.campaignId);
    expect(template.targetDurationSeconds).toBe(request.targetDurationSeconds);
  });

  it('already satisfies the exact-duration rule, so only the prose needs writing', async () => {
    const request = await loadCampaignRequest(REQUEST_PATH);
    const template = buildHumanPlanTemplate(request, '2026-07-27T00:00:00.000Z') as any;
    const beats = template.beats.reduce((sum: number, beat: any) => sum + beat.durationSeconds, 0);
    const overlaps = template.beats.reduce(
      (sum: number, beat: any) => sum + (beat.transitionIn?.durationSeconds ?? 0),
      0,
    );
    expect(beats - overlaps).toBeCloseTo(request.targetDurationSeconds, 6);
  });

  it('is a skeleton a person must finish, not a plan that would render as-is', async () => {
    const request = await loadCampaignRequest(REQUEST_PATH);
    const template = buildHumanPlanTemplate(request, '2026-07-27T00:00:00.000Z');
    // Every TODO is a decision only a person can make. A template that
    // rendered untouched would make this mode's whole claim untrue on first
    // use.
    expect(JSON.stringify(template)).toContain('TODO');
    expect(String(template.authoredBy)).toContain('TODO');
  });
});

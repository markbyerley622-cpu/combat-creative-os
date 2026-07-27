import { describe, expect, it } from 'vitest';

import type { ResolvedAsset } from '../asset-resolution';
import { AUDIO_CUE_ROLE_KEYS, buildAudioPlan, clampCueGain, CUE_MIX_RULES } from './audio-plan';

/**
 * The mix is deterministic because every rule is data. What is worth testing
 * is that the rules are actually applied — a gain outside its role's range is
 * clamped rather than honoured, a cue longer than its role allows is trimmed
 * rather than left to bury the bed, and a role that never ducks cannot be
 * talked into ducking by a plan that asks nicely.
 */

function audioAsset(id: string, durationSeconds: number): ResolvedAsset {
  return {
    asset: {
      id,
      path: `audio/${id}.wav`,
      kind: 'AUDIO',
      role: 'MUSIC',
      description: 'cue',
      rights: {
        classification: 'COMMISSIONED',
        owner: 'Combat Reviews',
        permittedOutputUse: true,
        restrictions: [],
      },
      beats: [],
      tags: [],
    },
    absolutePath: `/library/audio/${id}.wav`,
    sizeBytes: 2048,
    checksumSha256: 'c'.repeat(64),
    measuredDurationSeconds: durationSeconds,
    discrepancies: [],
  };
}

const assetsById = new Map<string, ResolvedAsset>([
  ['bell', audioAsset('bell', 1.6)],
  ['crowd', audioAsset('crowd', 30)],
  ['click', audioAsset('click', 8)],
]);

const base = {
  assetsById,
  sourceAudioGainDb: -14,
  cueDuckingDb: 6,
  musicCrossfadeSeconds: 0.25,
  peakCeilingDbtp: -1.5,
  outputDurationSeconds: 15,
};

describe('deterministic audio mixing', () => {
  it('produces an identical plan for identical input', () => {
    const build = () =>
      buildAudioPlan({
        ...base,
        cues: [
          {
            role: 'FIGHT_BELL',
            assetId: 'bell',
            atSeconds: 1,
            gainDb: -6,
            ducksMusic: true,
            beatId: 'a',
          },
          {
            role: 'CROWD',
            assetId: 'crowd',
            atSeconds: 3,
            gainDb: -20,
            ducksMusic: false,
            beatId: 'b',
          },
        ],
      });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('clamps a gain outside its role’s range and records what was asked for', () => {
    const plan = buildAudioPlan({
      ...base,
      cues: [
        {
          role: 'UI_CLICK',
          assetId: 'click',
          atSeconds: 2,
          gainDb: 6,
          ducksMusic: false,
          beatId: 'a',
        },
      ],
    });
    const cue = plan.cues[0]!;
    expect(cue.gainDb).toBe(CUE_MIX_RULES.UI_CLICK.maximumGainDb);
    expect(cue.clampedFromDb).toBe(6);
    expect(plan.decisions.join(' ')).toContain('clamped to');
  });

  it('trims a cue whose source runs past its role’s ceiling', () => {
    const plan = buildAudioPlan({
      ...base,
      cues: [
        {
          role: 'UI_CLICK',
          assetId: 'click',
          atSeconds: 2,
          gainDb: -12,
          ducksMusic: false,
          beatId: 'a',
        },
      ],
    });
    // The source is 8s; a click is a detail and may not run longer than 0.4s.
    expect(plan.cues[0]!.durationSeconds).toBe(CUE_MIX_RULES.UI_CLICK.maximumDurationSeconds);
    expect(plan.decisions.join(' ')).toContain('trimmed to the role');
  });

  it('never lets a cue run past the end of the cut', () => {
    const plan = buildAudioPlan({
      ...base,
      cues: [
        {
          role: 'CROWD',
          assetId: 'crowd',
          atSeconds: 14.5,
          gainDb: -20,
          ducksMusic: false,
          beatId: 'a',
        },
      ],
    });
    expect(plan.cues[0]!.durationSeconds).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('refuses to let a non-ducking role duck the bed, however the plan asks', () => {
    const plan = buildAudioPlan({
      ...base,
      cues: [
        {
          role: 'CROWD',
          assetId: 'crowd',
          atSeconds: 2,
          gainDb: -20,
          ducksMusic: true,
          beatId: 'a',
        },
      ],
    });
    expect(CUE_MIX_RULES.CROWD.ducksMusic).toBe(false);
    expect(plan.cues[0]!.ducksMusic).toBe(false);
  });

  it('honours a duck for a role that is allowed one', () => {
    const plan = buildAudioPlan({
      ...base,
      cues: [
        {
          role: 'FIGHT_BELL',
          assetId: 'bell',
          atSeconds: 1,
          gainDb: -6,
          ducksMusic: true,
          beatId: 'a',
        },
      ],
    });
    expect(plan.cues[0]!.ducksMusic).toBe(true);
    expect(plan.design.cues[0]!.ducksMusic).toBe(true);
  });

  it('drops a cue whose asset is not in the library rather than emitting a dangling reference', () => {
    const plan = buildAudioPlan({
      ...base,
      cues: [
        {
          role: 'IMPACT',
          assetId: 'missing',
          atSeconds: 1,
          gainDb: -8,
          ducksMusic: true,
          beatId: 'a',
        },
      ],
    });
    expect(plan.cues).toHaveLength(0);
    expect(plan.design.cues).toHaveLength(0);
  });

  it('carries the peak-protection and ducking decisions into the design and the report', () => {
    const plan = buildAudioPlan({ ...base, cues: [] });
    expect(plan.design.peakCeilingDbtp).toBe(-1.5);
    expect(plan.design.limiterEnabled).toBe(true);
    expect(plan.design.sourceAudioGainDb).toBe(-14);
    expect(plan.decisions.join(' ')).toContain('brick-wall limiter');
  });

  it('gives every cue role a rule, with a stated rationale', () => {
    for (const role of AUDIO_CUE_ROLE_KEYS) {
      const rule = CUE_MIX_RULES[role];
      expect(rule, `${role} has no mix rule`).toBeDefined();
      expect(rule.rationale.length).toBeGreaterThan(0);
      expect(rule.minimumGainDb).toBeLessThan(rule.maximumGainDb);
      expect(clampCueGain(role, 100)).toBe(rule.maximumGainDb);
      expect(clampCueGain(role, -100)).toBe(rule.minimumGainDb);
    }
  });
});

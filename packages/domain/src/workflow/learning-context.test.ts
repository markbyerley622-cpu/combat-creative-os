import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LearningConfidence, LearningRecord, LearningScope } from '../schemas/learning-record';
import {
  formatLearningContext,
  MAX_LEARNING_CONTEXT_ITEMS,
  selectLearningContext,
} from './learning-context';

function record(overrides: Partial<LearningRecord> = {}): LearningRecord {
  return {
    id: overrides.id ?? randomUUID(),
    workspaceId: overrides.workspaceId ?? randomUUID(),
    version: overrides.version ?? 1,
    learningKey: overrides.learningKey ?? `key-${randomUUID().slice(0, 8)}`,
    insight: overrides.insight ?? 'Hooks under two seconds hold attention.',
    scope: overrides.scope ?? ('STRATEGY' as LearningScope),
    applicability: overrides.applicability ?? { platforms: [], durationsSeconds: [], tags: [] },
    confidence: overrides.confidence ?? ('MEDIUM' as LearningConfidence),
    evidence: overrides.evidence ?? [
      {
        performanceObservationId: randomUUID(),
        campaignId: randomUUID(),
        platform: 'TIKTOK',
        impressions: 10_000,
      },
    ],
    totalImpressions: overrides.totalImpressions ?? 10_000,
    status: overrides.status ?? 'APPROVED',
    sourceCampaignId: overrides.sourceCampaignId ?? randomUUID(),
    createdByAgentInvocationId: overrides.createdByAgentInvocationId ?? randomUUID(),
    promptVersionId: overrides.promptVersionId ?? randomUUID(),
    createdAt: overrides.createdAt ?? new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

const REQUEST = {
  scope: 'STRATEGY' as LearningScope,
  targetPlatforms: ['TIKTOK'] as const,
  targetDurationsSeconds: [15, 10, 6] as const,
};

describe('selectLearningContext — what may never reach an agent', () => {
  it('excludes records that are not APPROVED', () => {
    const items = selectLearningContext(
      [record({ status: 'PROPOSED' }), record({ status: 'REJECTED' })],
      REQUEST,
    );

    expect(items).toHaveLength(0);
  });

  it('excludes superseded records', () => {
    const items = selectLearningContext([record({ supersededAt: new Date() })], REQUEST);

    expect(items).toHaveLength(0);
  });

  it('excludes a record scoped to a different agent', () => {
    const items = selectLearningContext([record({ scope: 'CONCEPT' })], REQUEST);

    expect(items).toHaveLength(0);
  });

  it('excludes LOW-confidence records — a thin claim never shapes a strategy', () => {
    const items = selectLearningContext([record({ confidence: 'LOW' })], REQUEST);

    expect(items).toHaveLength(0);
  });

  it('excludes a record whose platform applicability does not overlap the campaign', () => {
    const items = selectLearningContext(
      [
        record({
          applicability: { platforms: ['YOUTUBE_SHORTS'], durationsSeconds: [], tags: [] },
        }),
      ],
      REQUEST,
    );

    expect(items).toHaveLength(0);
  });

  it('excludes a record whose duration applicability does not overlap the campaign', () => {
    const items = selectLearningContext(
      [record({ applicability: { platforms: [], durationsSeconds: [30], tags: [] } })],
      REQUEST,
    );

    expect(items).toHaveLength(0);
  });

  it('treats an empty applicability array as unrestricted on that dimension', () => {
    const items = selectLearningContext(
      [record({ applicability: { platforms: [], durationsSeconds: [], tags: [] } })],
      REQUEST,
    );

    expect(items).toHaveLength(1);
  });
});

describe('selectLearningContext — bounded and ranked', () => {
  it('caps the payload so it cannot grow with workspace history', () => {
    const many = Array.from({ length: MAX_LEARNING_CONTEXT_ITEMS + 20 }, (_, i) =>
      record({ learningKey: `key-${i}`, totalImpressions: 10_000 + i }),
    );

    const items = selectLearningContext(many, REQUEST);

    expect(items).toHaveLength(MAX_LEARNING_CONTEXT_ITEMS);
  });

  it('ranks HIGH confidence above MEDIUM, then by evidence weight', () => {
    const items = selectLearningContext(
      [
        record({ learningKey: 'medium-big', confidence: 'MEDIUM', totalImpressions: 900_000 }),
        record({ learningKey: 'high-small', confidence: 'HIGH', totalImpressions: 60_000 }),
        record({ learningKey: 'medium-small', confidence: 'MEDIUM', totalImpressions: 6_000 }),
      ],
      REQUEST,
    );

    expect(items.map((i) => i.learningKey)).toEqual(['high-small', 'medium-big', 'medium-small']);
  });

  it('is deterministic for equal-weight records (stable key ordering)', () => {
    const candidates = [
      record({ learningKey: 'b', totalImpressions: 10_000 }),
      record({ learningKey: 'a', totalImpressions: 10_000 }),
    ];

    expect(selectLearningContext(candidates, REQUEST).map((i) => i.learningKey)).toEqual([
      'a',
      'b',
    ]);
  });

  it('honours an explicit lower cap', () => {
    const items = selectLearningContext(
      [record({ learningKey: 'a' }), record({ learningKey: 'b' })],
      { ...REQUEST, maxItems: 1 },
    );

    expect(items).toHaveLength(1);
  });
});

describe('selectLearningContext — attributable and advisory', () => {
  it('preserves the source id, version, confidence and evidence weight', () => {
    const source = record({ totalImpressions: 42_000 });

    const [item] = selectLearningContext([source], REQUEST);

    expect(item).toMatchObject({
      learningRecordId: source.id,
      learningKey: source.learningKey,
      version: source.version,
      confidence: source.confidence,
      evidenceCount: source.evidence.length,
      totalImpressions: 42_000,
    });
  });

  it('carries no campaign internals, assets, approvals or raw metrics', () => {
    const [item] = selectLearningContext([record()], REQUEST);

    // The context shape is exactly these keys — nothing that could act as an
    // instruction or reference production state.
    expect(Object.keys(item!).sort()).toEqual([
      'applicability',
      'confidence',
      'evidenceCount',
      'insight',
      'learningKey',
      'learningRecordId',
      'totalImpressions',
      'version',
    ]);
  });
});

describe('formatLearningContext', () => {
  it('renders each item with its confidence, evidence weight and traceable source id', () => {
    const source = record({ insight: 'Short hooks outperform.', totalImpressions: 42_000 });
    const [item] = selectLearningContext([source], REQUEST);

    const [line] = formatLearningContext([item!]);

    expect(line).toContain('MEDIUM confidence');
    expect(line).toContain('1 observation(s)');
    expect(line).toContain('42000 impressions');
    expect(line).toContain(`learning:${source.id} v1`);
    expect(line).toContain('Short hooks outperform.');
  });

  it('returns an empty list when nothing qualified', () => {
    expect(formatLearningContext([])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@combat/database';
import { createPrismaActivityDatabase, nullsToUndefined } from './prisma-activity-database';

/**
 * The null-vs-undefined bridge between Prisma's generated types and the
 * repository layer's `*DataSource` record types. Exercised against a fake
 * Prisma client — this environment has no live Postgres, and the conversion
 * itself is pure, so a real database would prove nothing extra here.
 */

interface FakeCall {
  model: string;
  method: string;
  args: unknown;
}

function fakePrisma(rows: Record<string, unknown>, calls: FakeCall[]): PrismaClient {
  const model = (name: string) => ({
    findFirst: async (args: unknown) => {
      calls.push({ model: name, method: 'findFirst', args });
      return rows[name] ?? null;
    },
    findMany: async (args: unknown) => {
      calls.push({ model: name, method: 'findMany', args });
      const row = rows[name];
      return row === undefined ? [] : [row];
    },
    create: async (args: unknown) => {
      calls.push({ model: name, method: 'create', args });
      return rows[name] ?? null;
    },
    count: async () => 7,
  });

  return {
    humanApproval: model('humanApproval'),
    campaign: model('campaign'),
    shotSpecification: model('shotSpecification'),
    $disconnect: async () => undefined,
  } as unknown as PrismaClient;
}

describe('nullsToUndefined', () => {
  it(`converts a row's top-level nulls to undefined`, () => {
    expect(nullsToUndefined({ id: 'a', comments: null, repairTarget: null })).toEqual({
      id: 'a',
      comments: undefined,
      repairTarget: undefined,
    });
  });

  it('maps over an array of rows', () => {
    expect(nullsToUndefined([{ a: null }, { a: 1 }])).toEqual([{ a: undefined }, { a: 1 }]);
  });

  it('passes a null result through unchanged, so "not found" stays falsy', () => {
    expect(nullsToUndefined(null)).toBeNull();
  });

  it('never rewrites the contents of a JSON column', () => {
    const row = { id: 'a', generationParams: { seed: null, aspectRatio: '9:16' } };
    const normalized = nullsToUndefined(row) as typeof row;

    // The column itself is present, and the null *inside* it survives — a
    // recursive conversion would silently corrupt stored JSON.
    expect(normalized.generationParams).toEqual({ seed: null, aspectRatio: '9:16' });
  });

  it('leaves Date values intact rather than treating them as rows', () => {
    const createdAt = new Date('2026-07-26T00:00:00.000Z');
    const normalized = nullsToUndefined({ createdAt }) as { createdAt: Date };

    expect(normalized.createdAt).toBeInstanceOf(Date);
    expect(normalized.createdAt.toISOString()).toBe('2026-07-26T00:00:00.000Z');
  });

  it('passes non-row results through', () => {
    expect(nullsToUndefined(7)).toBe(7);
    expect(nullsToUndefined('x')).toBe('x');
  });
});

describe('createPrismaActivityDatabase', () => {
  it('normalizes nullable columns on every delegate method', async () => {
    const calls: FakeCall[] = [];
    const db = createPrismaActivityDatabase(
      fakePrisma(
        { humanApproval: { id: 'h1', comments: null, repairTarget: null, gate: 'CONCEPT' } },
        calls,
      ),
    );

    const [approval] = await db.humanApproval.findMany({
      where: { workspaceId: 'w', campaignId: 'c' },
    });

    // `null` would not be assignable to `comments?: string`; `undefined` is.
    expect(approval).toEqual({
      id: 'h1',
      comments: undefined,
      repairTarget: undefined,
      gate: 'CONCEPT',
    });
    expect('comments' in approval!).toBe(true);
  });

  it('forwards arguments to Prisma untouched', async () => {
    const calls: FakeCall[] = [];
    const db = createPrismaActivityDatabase(fakePrisma({ campaign: { id: 'c1' } }, calls));

    await db.campaign.findFirst({ where: { id: 'c1', workspaceId: 'w1' } });

    expect(calls).toEqual([
      { model: 'campaign', method: 'findFirst', args: { where: { id: 'c1', workspaceId: 'w1' } } },
    ]);
  });

  it('returns null for a missing row so repository "not found" checks still work', async () => {
    const db = createPrismaActivityDatabase(fakePrisma({}, []));

    await expect(
      db.campaign.findFirst({ where: { id: 'nope', workspaceId: 'w' } }),
    ).resolves.toBeNull();
  });

  it('passes Prisma lifecycle members through untouched', async () => {
    const prisma = fakePrisma({}, []);
    const db = createPrismaActivityDatabase(prisma) as unknown as PrismaClient;

    await expect(db.$disconnect()).resolves.toBeUndefined();
  });
});

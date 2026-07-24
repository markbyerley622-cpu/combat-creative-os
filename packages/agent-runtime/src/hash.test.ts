import { describe, expect, it } from 'vitest';
import { stableHash } from './hash';

describe('stableHash', () => {
  it('is identical for objects with the same keys in a different order', () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });

  it('differs when a value changes', () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  it('is stable across repeated calls (no timestamp/random leakage)', () => {
    const value = { nested: { list: [1, 2, 3] } };
    expect(stableHash(value)).toBe(stableHash(value));
  });
});

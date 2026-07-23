import { describe, expect, it } from 'vitest';
import { WorkspaceSchema } from './tenancy';

describe('WorkspaceSchema', () => {
  const base = {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Combat Reviews',
    slug: 'combat-reviews',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('accepts a valid workspace', () => {
    expect(() => WorkspaceSchema.parse(base)).not.toThrow();
  });

  it('rejects a slug with uppercase or spaces', () => {
    expect(() => WorkspaceSchema.parse({ ...base, slug: 'Combat Reviews' })).toThrow();
  });

  it('rejects a non-uuid id', () => {
    expect(() => WorkspaceSchema.parse({ ...base, id: 'not-a-uuid' })).toThrow();
  });
});

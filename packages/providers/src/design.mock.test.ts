import { describe, expect, it } from 'vitest';
import { MockDesignProvider } from './design.mock';
import { DesignProviderError, type DesignExportInput } from './design';

function buildInput(overrides: Partial<DesignExportInput> = {}): DesignExportInput {
  return {
    idempotencyKey: 'export-1',
    fileKey: 'file-abc',
    nodeId: 'node-123',
    format: 'png',
    ...overrides,
  };
}

describe('MockDesignProvider', () => {
  it('exposes supported export formats via getCapabilities', () => {
    const provider = new MockDesignProvider();
    expect(provider.getCapabilities().exportFormats).toContain('png');
    expect(provider.getCapabilities().exportFormats).toContain('svg');
  });

  it('fetchNode returns deterministic node metadata', async () => {
    const provider = new MockDesignProvider();
    await expect(provider.fetchNode('file-abc', 'node-123')).resolves.toEqual({
      fileKey: 'file-abc',
      nodeId: 'node-123',
      name: 'mock-node-node-123',
    });
  });

  it('exportAsset is idempotent by idempotencyKey', async () => {
    const provider = new MockDesignProvider();
    const first = await provider.exportAsset(buildInput());
    const second = await provider.exportAsset(buildInput());
    expect(second).toEqual(first);
  });

  it('exportAsset is deterministic across separate instances', async () => {
    const a = new MockDesignProvider();
    const b = new MockDesignProvider();
    const refA = await a.exportAsset(buildInput({ idempotencyKey: 'stable' }));
    const refB = await b.exportAsset(buildInput({ idempotencyKey: 'stable' }));
    expect(refA).toEqual(refB);
  });

  it('exportAsset returns metadata only — an s3Key, no binary bytes', async () => {
    const provider = new MockDesignProvider();
    const ref = await provider.exportAsset(buildInput({ format: 'svg' }));
    expect(ref.s3Key).toBe('mock/design/file-abc/node-123.svg');
    expect(typeof ref.assetId).toBe('string');
    expect(ref).not.toHaveProperty('body');
    expect(ref).not.toHaveProperty('bytes');
  });

  it('rejects an unsupported export format with a typed DesignProviderError', async () => {
    const provider = new MockDesignProvider({ capabilities: { exportFormats: ['png'] } });
    await expect(provider.exportAsset(buildInput({ format: 'svg' }))).rejects.toBeInstanceOf(
      DesignProviderError,
    );
    await expect(provider.exportAsset(buildInput({ format: 'svg' }))).rejects.toMatchObject({
      reason: 'UNSUPPORTED_CAPABILITY',
    });
  });
});

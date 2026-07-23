import { randomUUID } from 'node:crypto';
import type { DesignProvider } from './design';
import type { AssetRef } from './types';

export class MockDesignProvider implements DesignProvider {
  readonly name = 'mock-design';

  async fetchNode(
    fileKey: string,
    nodeId: string,
  ): Promise<{ fileKey: string; nodeId: string; name: string }> {
    return { fileKey, nodeId, name: `mock-node-${nodeId}` };
  }

  async exportAsset(fileKey: string, nodeId: string, format: 'png' | 'svg'): Promise<AssetRef> {
    const assetId = randomUUID();
    return { assetId, s3Key: `mock/design/${fileKey}/${nodeId}.${format}` };
  }
}

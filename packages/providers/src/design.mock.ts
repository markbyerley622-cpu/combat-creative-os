import { createHash } from 'node:crypto';
import type { DesignCapabilities, DesignExportInput, DesignProvider } from './design';
import { DESIGN_EXPORT_FORMATS, DesignProviderError } from './design';
import type { AssetRef } from './types';

const DEFAULT_DESIGN_CAPABILITIES: DesignCapabilities = {
  exportFormats: [...DESIGN_EXPORT_FORMATS],
};

export interface MockDesignOptions {
  capabilities?: DesignCapabilities;
}

/**
 * Deterministic, in-memory design mock — no network, no real bytes.
 * `exportAsset` is idempotent by `idempotencyKey` (same key -> same AssetRef,
 * derived by hash so two instances agree) and rejects unsupported formats
 * before recording state, matching every other provider mock here.
 */
export class MockDesignProvider implements DesignProvider {
  readonly name = 'mock-design';
  private readonly capabilities: DesignCapabilities;
  private readonly exportsByIdempotencyKey = new Map<string, AssetRef>();

  constructor(options: MockDesignOptions = {}) {
    this.capabilities = options.capabilities ?? DEFAULT_DESIGN_CAPABILITIES;
  }

  getCapabilities(): DesignCapabilities {
    return this.capabilities;
  }

  async fetchNode(
    fileKey: string,
    nodeId: string,
  ): Promise<{ fileKey: string; nodeId: string; name: string }> {
    return { fileKey, nodeId, name: `mock-node-${nodeId}` };
  }

  async exportAsset(input: DesignExportInput): Promise<AssetRef> {
    const existing = this.exportsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    if (!this.capabilities.exportFormats.includes(input.format)) {
      throw new DesignProviderError(
        'UNSUPPORTED_CAPABILITY',
        `export format "${input.format}" is not supported`,
      );
    }

    const ref: AssetRef = {
      assetId: stableId(input.idempotencyKey),
      s3Key: `mock/design/${input.fileKey}/${input.nodeId}.${input.format}`,
    };
    this.exportsByIdempotencyKey.set(input.idempotencyKey, ref);
    return ref;
  }
}

function stableId(idempotencyKey: string): string {
  return createHash('sha256').update(`design-export:${idempotencyKey}`).digest('hex').slice(0, 32);
}

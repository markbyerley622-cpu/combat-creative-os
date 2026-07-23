import type { AssetRef } from './types';

/** Figma — no real adapter yet; interface + mock only (docs/architecture.md §5). */
export interface DesignProvider {
  readonly name: string;
  fetchNode(
    fileKey: string,
    nodeId: string,
  ): Promise<{ fileKey: string; nodeId: string; name: string }>;
  exportAsset(fileKey: string, nodeId: string, format: 'png' | 'svg'): Promise<AssetRef>;
}

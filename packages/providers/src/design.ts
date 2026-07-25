import type { AssetRef, IdempotencyKey } from './types';

/**
 * Figma (or any design source) — no real adapter yet; interface + deterministic
 * mock only (docs/architecture.md §5). This is the "design/overlay handoff"
 * surface the M9 compositing path uses to pull exported overlay assets
 * (lower-thirds, logos, captions) referenced by a MotionGraphicsTimeline. Kept
 * intentionally minimal and vendor-neutral.
 */

export const DESIGN_EXPORT_FORMATS = ['png', 'svg', 'pdf'] as const;
export type DesignExportFormat = (typeof DESIGN_EXPORT_FORMATS)[number];

export interface DesignCapabilities {
  readonly exportFormats: readonly DesignExportFormat[];
}

export const DESIGN_FAILURE_REASONS = ['UNSUPPORTED_CAPABILITY', 'PROVIDER_ERROR'] as const;
export type DesignFailureReason = (typeof DESIGN_FAILURE_REASONS)[number];

/**
 * Thrown by `exportAsset` for request-shape problems (an unsupported export
 * format) that never reach the design provider at all. Mirrors
 * `VideoGenerationError` / `MotionGraphicsProviderError`.
 */
export class DesignProviderError extends Error {
  constructor(
    public readonly reason: DesignFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'DesignProviderError';
  }
}

export interface DesignExportInput {
  readonly idempotencyKey: IdempotencyKey;
  readonly fileKey: string;
  readonly nodeId: string;
  readonly format: DesignExportFormat;
}

export interface DesignProvider {
  readonly name: string;
  getCapabilities(): DesignCapabilities;
  fetchNode(
    fileKey: string,
    nodeId: string,
  ): Promise<{ fileKey: string; nodeId: string; name: string }>;
  /**
   * Idempotent by idempotencyKey (a replay returns the same AssetRef) and
   * deterministic. Rejects (throws DesignProviderError with reason
   * UNSUPPORTED_CAPABILITY) for a format outside getCapabilities() BEFORE
   * recording state. Returns metadata only — never binary bytes.
   */
  exportAsset(input: DesignExportInput): Promise<AssetRef>;
}

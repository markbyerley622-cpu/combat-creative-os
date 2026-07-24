import type {
  AssetDataSource,
  AssetRecord,
  CampaignDataSource,
  LicenseDataSource,
} from '@combat/database';
import {
  createAssetWithProvenance,
  createLicenseRecord,
  findAssetByChecksum,
} from '@combat/database';
import type { LicenseType } from '@combat/domain';
import type { StorageProvider } from '@combat/providers';
// Reuses execute-specialist-agent-activity.ts's CampaignNotFoundError (also
// re-exported from this package's activities barrel) — same meaning here
// (ownership mismatch is an orchestrator bug, never a persisted typed
// failure), no reason for a second error class.
import { CampaignNotFoundError } from './execute-specialist-agent-activity';

/**
 * The deterministic upload location for a given (workspace, campaign,
 * uploadId) — the one and only place an object key for a user upload is
 * ever computed. Neither `request-upload` nor `confirm-upload` (apps/api)
 * accepts an `s3Key` from the client; both call this same function so the
 * client can never choose, override, or guess a different object's key
 * ("never trusts client-provided storage keys" — M5 requirement). Content
 * (not the key) is what's later deduped by checksum.
 */
export function buildUploadS3Key(input: {
  workspaceId: string;
  campaignId: string;
  uploadId: string;
  originalFilename: string;
}): string {
  return `workspaces/${input.workspaceId}/campaigns/${input.campaignId}/uploads/${input.uploadId}/${sanitizeFilenameForKey(input.originalFilename)}`;
}

/** Strips any path components and anything outside a conservative safe-character set — defends against `../`-style traversal or null-byte tricks in a client-supplied filename ending up inside an object key. */
export function sanitizeFilenameForKey(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'file';
}

export interface IngestAssetLicensingInput {
  readonly licenseType: LicenseType;
  readonly rightsHolder: string;
  readonly restrictions?: readonly string[];
  readonly expiresAt?: Date;
}

export interface IngestAssetInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly uploadId: string;
  readonly originalFilename: string;
  readonly declaredMimeType: string;
  readonly declaredSizeBytes: number;
  readonly uploadedByUserId: string;
  readonly licensing: IngestAssetLicensingInput;
}

export type IngestAssetOutput =
  | { readonly ok: true; readonly asset: AssetRecord; readonly deduped: boolean }
  | { readonly ok: false; readonly reason: 'UPLOAD_NOT_FOUND'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'UNSUPPORTED_MIME_TYPE'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'FILE_TOO_LARGE'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'MISSING_LICENSING'; readonly detail: string };

export interface IngestAssetActivityDeps {
  readonly storageProvider: StorageProvider;
  readonly campaignDb: CampaignDataSource;
  readonly assetDb: AssetDataSource;
  readonly licenseDb: LicenseDataSource;
  readonly maxUploadBytes: number;
  readonly mimeAllowlist: readonly string[];
}

/**
 * The M5 asset-ingestion service, shaped as a Temporal Activity (same
 * `createXActivity(deps) => (input) => Promise<output>` pattern as
 * execute-specialist-agent-activity.ts) so it's callable identically
 * in-process (apps/api's confirm-upload route, this milestone — no live
 * Temporal Worker registers it yet, matching M3/M4's own documented interim
 * state) or from a future Activity dispatch.
 *
 * Order of checks matters: declared-value checks (MIME, declared size,
 * licensing) run before ever touching storage, so a request that's invalid
 * on its face never even attempts a `headObject` call.
 */
export function createIngestAssetActivity(
  deps: IngestAssetActivityDeps,
): (input: IngestAssetInput) => Promise<IngestAssetOutput> {
  return async function ingestAssetActivity(input: IngestAssetInput): Promise<IngestAssetOutput> {
    const campaign = await deps.campaignDb.campaign.findFirst({
      where: { id: input.campaignId, workspaceId: input.workspaceId },
    });
    if (!campaign) {
      throw new CampaignNotFoundError(input.workspaceId, input.campaignId);
    }

    if (!deps.mimeAllowlist.includes(input.declaredMimeType)) {
      return {
        ok: false,
        reason: 'UNSUPPORTED_MIME_TYPE',
        detail: `MIME type "${input.declaredMimeType}" is not in the allowlist`,
      };
    }

    if (input.declaredSizeBytes > deps.maxUploadBytes) {
      return {
        ok: false,
        reason: 'FILE_TOO_LARGE',
        detail: `declared size ${input.declaredSizeBytes} exceeds the ${deps.maxUploadBytes}-byte limit`,
      };
    }

    if (!input.licensing.licenseType || !input.licensing.rightsHolder) {
      return {
        ok: false,
        reason: 'MISSING_LICENSING',
        detail: 'licenseType and rightsHolder are both required to ingest an uploaded asset',
      };
    }

    const s3Key = buildUploadS3Key(input);

    let head;
    try {
      head = await deps.storageProvider.headObject(s3Key);
    } catch {
      return {
        ok: false,
        reason: 'UPLOAD_NOT_FOUND',
        detail: `no object was found at the expected upload location for uploadId ${input.uploadId} — the file may not have finished uploading`,
      };
    }

    // Defense in depth: re-check the *actual* uploaded size, not just the
    // caller's declared intent from request-upload.
    if (head.sizeBytes > deps.maxUploadBytes) {
      return {
        ok: false,
        reason: 'FILE_TOO_LARGE',
        detail: `uploaded object is ${head.sizeBytes} bytes, exceeding the ${deps.maxUploadBytes}-byte limit`,
      };
    }

    const existing = await findAssetByChecksum(
      deps.assetDb,
      input.workspaceId,
      head.checksum,
      'UPLOADED_SOURCE',
    );
    if (existing) {
      return { ok: true, asset: existing, deduped: true };
    }

    const { asset } = await createAssetWithProvenance(deps.assetDb, input.workspaceId, {
      campaignId: input.campaignId,
      kind: 'UPLOADED_SOURCE',
      s3Key,
      checksum: head.checksum,
      mimeType: head.contentType ?? input.declaredMimeType,
      originalFilename: input.originalFilename,
      sizeBytes: head.sizeBytes,
      ingestionStatus: 'PENDING',
      uploadedByUserId: input.uploadedByUserId,
    });

    await createLicenseRecord(deps.licenseDb, input.workspaceId, {
      assetId: asset.id,
      licenseType: input.licensing.licenseType,
      rightsHolder: input.licensing.rightsHolder,
      restrictions: input.licensing.restrictions ? [...input.licensing.restrictions] : undefined,
      expiresAt: input.licensing.expiresAt,
    });

    return { ok: true, asset, deduped: false };
  };
}

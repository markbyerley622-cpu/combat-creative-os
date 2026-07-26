import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { LicenseTypeSchema, roleHasPermission, type RoleName } from '@combat/domain';
import {
  getAsset,
  getCampaign,
  getLicenseRecord,
  listMembershipsForWorkspace,
} from '@combat/database';
import { activities } from '@combat/workflows';
import type { StorageProvider } from '@combat/providers';
import type { AssetDatabase } from './asset-database';
import { requirePrincipal } from './authentication';

/**
 * Declared-value MIME allowlist for M5's upload path — brand assets and
 * reference material only (images/video/audio), not arbitrary files.
 * Deliberately a code constant, not env-configurable — see
 * packages/config's `assetEnvSchema` doc comment for why.
 */
const ASSET_MIME_ALLOWLIST = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/aac',
] as const;

export interface AssetRouteLimits {
  readonly maxUploadBytes: number;
  readonly uploadUrlExpirySeconds: number;
  readonly downloadUrlExpirySeconds: number;
}

export interface AssetRouteDeps {
  readonly db: AssetDatabase;
  readonly storageProvider: StorageProvider;
  readonly limits: AssetRouteLimits;
}

const LicensingBodySchema = z.object({
  licenseType: LicenseTypeSchema,
  rightsHolder: z.string().min(1),
  restrictions: z.array(z.string()).optional(),
  expiresAt: z.coerce.date().optional(),
});

/**
 * AAMP-1 step 2: no `userId` field, and `.strict()` so supplying one is a 400.
 * The uploader recorded on the asset is `request.principal.userId` — a verified
 * identity, not a claimed one.
 */
const RequestUploadBodySchema = z
  .object({
    originalFilename: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().positive(),
    licensing: LicensingBodySchema,
  })
  .strict();

const ConfirmUploadBodySchema = RequestUploadBodySchema.extend({
  uploadId: z.string().min(1),
});

interface AssetView {
  id: string;
  workspaceId: string;
  campaignId: string;
  kind: string;
  checksum: string;
  mimeType: string;
  originalFilename: string;
  sizeBytes: number;
  ingestionStatus: string;
  mediaMetadata?: unknown;
  inspectionFailureDetails?: string;
  createdAt: Date;
}

/** Never returns `s3Key` — the internal object key is not for client consumption ("never expose... internal object keys," M5 requirement 6). A signed, time-limited download URL is the only way a caller ever reaches the bytes. */
function toAssetView(asset: {
  id: string;
  workspaceId: string;
  campaignId: string;
  kind: string;
  checksum: string;
  mimeType: string;
  originalFilename: string;
  sizeBytes: number;
  ingestionStatus: string;
  mediaMetadata?: unknown;
  inspectionFailureDetails?: string;
  createdAt: Date;
}): AssetView {
  return {
    id: asset.id,
    workspaceId: asset.workspaceId,
    campaignId: asset.campaignId,
    kind: asset.kind,
    checksum: asset.checksum,
    mimeType: asset.mimeType,
    originalFilename: asset.originalFilename,
    sizeBytes: asset.sizeBytes,
    ingestionStatus: asset.ingestionStatus,
    mediaMetadata: asset.mediaMetadata,
    inspectionFailureDetails: asset.inspectionFailureDetails,
    createdAt: asset.createdAt,
  };
}

async function authorize(
  db: AssetDatabase,
  workspaceId: string,
  userId: string,
  requiredPermission: Parameters<typeof roleHasPermission>[1] | null,
): Promise<{ ok: true } | { ok: false; status: number; body: { error: string; message: string } }> {
  const memberships = await listMembershipsForWorkspace(db, workspaceId);
  const membership = memberships.find((m) => m.userId === userId);
  if (!membership) {
    return {
      ok: false,
      status: 403,
      body: { error: 'FORBIDDEN', message: 'caller is not a member of this workspace' },
    };
  }
  const role = membership.role as RoleName;
  if (requiredPermission && !roleHasPermission(role, requiredPermission)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'FORBIDDEN', message: `role ${role} lacks permission ${requiredPermission}` },
    };
  }
  return { ok: true };
}

/** See approval-routes.ts's identical doc comment for why `app`'s type is this loose. */
export function registerAssetRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  deps: AssetRouteDeps,
): void {
  const ingestAssetActivity = activities.createIngestAssetActivity({
    storageProvider: deps.storageProvider,
    campaignDb: deps.db,
    assetDb: deps.db,
    licenseDb: deps.db,
    maxUploadBytes: deps.limits.maxUploadBytes,
    mimeAllowlist: ASSET_MIME_ALLOWLIST,
  });

  // --- Request upload ---------------------------------------------------
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/assets/request-upload',
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = RequestUploadBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: parsed.error.issues });
      }
      const auth = await authorize(
        deps.db,
        workspaceId,
        requirePrincipal(request).userId,
        'MANAGE_ASSETS',
      );
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      if (!ASSET_MIME_ALLOWLIST.includes(parsed.data.mimeType as never)) {
        return reply.status(400).send({
          error: 'UNSUPPORTED_MIME_TYPE',
          message: `MIME type "${parsed.data.mimeType}" is not supported`,
        });
      }
      if (parsed.data.sizeBytes > deps.limits.maxUploadBytes) {
        return reply.status(400).send({
          error: 'FILE_TOO_LARGE',
          message: `declared size exceeds the ${deps.limits.maxUploadBytes}-byte limit`,
        });
      }

      const uploadId = randomUUID();
      const s3Key = activities.buildUploadS3Key({
        workspaceId,
        campaignId,
        uploadId,
        originalFilename: parsed.data.originalFilename,
      });
      const uploadUrl = await deps.storageProvider.getPresignedUploadUrl(s3Key, {
        expirySeconds: deps.limits.uploadUrlExpirySeconds,
        contentType: parsed.data.mimeType,
      });
      const expiresAt = new Date(
        Date.now() + deps.limits.uploadUrlExpirySeconds * 1000,
      ).toISOString();

      return reply.status(201).send({ uploadId, uploadUrl, expiresAt });
    },
  );

  // --- Confirm upload ---------------------------------------------------
  app.post<{ Params: { workspaceId: string; campaignId: string }; Body: unknown }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/assets/confirm-upload',
    async (request, reply) => {
      const { workspaceId, campaignId } = request.params;
      const parsed = ConfirmUploadBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_BODY', issues: parsed.error.issues });
      }
      const auth = await authorize(
        deps.db,
        workspaceId,
        requirePrincipal(request).userId,
        'MANAGE_ASSETS',
      );
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const campaign = await getCampaign(deps.db, workspaceId, campaignId);
      if (!campaign) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'campaign not found' });
      }

      const result = await ingestAssetActivity({
        workspaceId,
        campaignId,
        uploadId: parsed.data.uploadId,
        originalFilename: parsed.data.originalFilename,
        declaredMimeType: parsed.data.mimeType,
        declaredSizeBytes: parsed.data.sizeBytes,
        uploadedByUserId: requirePrincipal(request).userId,
        licensing: parsed.data.licensing,
      });

      if (!result.ok) {
        const status = result.reason === 'UPLOAD_NOT_FOUND' ? 404 : 400;
        return reply.status(status).send({ error: result.reason, message: result.detail });
      }

      return reply.status(201).send({ asset: toAssetView(result.asset), deduped: result.deduped });
    },
  );

  // --- Asset metadata -----------------------------------------------------
  app.get<{
    Params: { workspaceId: string; campaignId: string; assetId: string };
    Querystring: unknown;
  }>('/workspaces/:workspaceId/campaigns/:campaignId/assets/:assetId', async (request, reply) => {
    const { workspaceId, campaignId, assetId } = request.params;
    const auth = await authorize(deps.db, workspaceId, requirePrincipal(request).userId, null);
    if (!auth.ok) return reply.status(auth.status).send(auth.body);

    const asset = await getAsset(deps.db, workspaceId, assetId);
    if (!asset || asset.campaignId !== campaignId) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'asset not found' });
    }

    const license = await getLicenseRecord(deps.db, workspaceId, assetId);
    return reply.status(200).send({ asset: toAssetView(asset), license });
  });

  // --- Signed download URL -------------------------------------------------
  app.get<{
    Params: { workspaceId: string; campaignId: string; assetId: string };
    Querystring: unknown;
  }>(
    '/workspaces/:workspaceId/campaigns/:campaignId/assets/:assetId/download-url',
    async (request, reply) => {
      const { workspaceId, campaignId, assetId } = request.params;
      const auth = await authorize(deps.db, workspaceId, requirePrincipal(request).userId, null);
      if (!auth.ok) return reply.status(auth.status).send(auth.body);

      const asset = await getAsset(deps.db, workspaceId, assetId);
      if (!asset || asset.campaignId !== campaignId) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'asset not found' });
      }

      const url = await deps.storageProvider.getPresignedUrl(
        asset.s3Key,
        deps.limits.downloadUrlExpirySeconds,
      );
      const expiresAt = new Date(
        Date.now() + deps.limits.downloadUrlExpirySeconds * 1000,
      ).toISOString();

      return reply.status(200).send({ url, expiresAt });
    },
  );
}

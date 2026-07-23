import { z } from 'zod';
import { LicenseTypeSchema } from './shared-enums';

/** 0..1 on Asset by design — intermediate assets (proxies, thumbnails) don't need one. */
export const LicenseRecordSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  assetId: z.string().uuid(),
  licenseType: LicenseTypeSchema,
  rightsHolder: z.string().min(1),
  restrictions: z.array(z.string()).default([]),
  expiresAt: z.date().optional(),
  createdAt: z.date(),
});
export type LicenseRecord = z.infer<typeof LicenseRecordSchema>;

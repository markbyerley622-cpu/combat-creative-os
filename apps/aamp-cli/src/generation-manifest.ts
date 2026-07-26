import { z } from 'zod';

/**
 * The campaign generation manifest — the input side of `pnpm aamp:generate`,
 * and the counterpart to `@combat/media`'s render manifest.
 *
 * The two are deliberately different documents. A *render* manifest describes
 * a cut that already exists in every particular: which file, trimmed where,
 * over which transition. A *generation* manifest describes a campaign before
 * anything has been shot — a prompt, an audience, a hook, the assets that are
 * already owned, and the delivery target. Everything between the two is what
 * the agents and the generation provider produce.
 *
 * Versioned by literal discriminator, `.strict()`, and cross-field validated,
 * for exactly the reasons `RenderManifestV1Schema` documents: a v2 manifest
 * should fail parsing here rather than be half-understood.
 */

const IsoDateStringSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

/**
 * Mirrors `@combat/media`'s `SOURCE_USAGE_CLASSES` plus the generation-side
 * `GENERATED`. Supplied assets declare their own class so the licensing gate
 * can run before either FFmpeg or ComfyUI sees a byte.
 */
export const MANIFEST_USAGE_CLASSES = [
  'OWNED',
  'LICENSED_FOR_OUTPUT',
  'GENERATED',
  'ANALYSIS_ONLY',
] as const;
export const ManifestUsageClassSchema = z.enum(MANIFEST_USAGE_CLASSES);

export const ManifestLicenseSchema = z
  .object({
    usageClass: ManifestUsageClassSchema,
    rightsHolder: z.string().min(1),
    licenseType: z.string().min(1),
    expiresAt: IsoDateStringSchema.optional(),
    attribution: z.string().min(1).optional(),
    restrictions: z.array(z.string().min(1)).default([]),
  })
  .strict();

/**
 * What an asset is *for*. Drives placement: a logo becomes branding, app
 * screenshots become scenes, music becomes an audio track, a reference image
 * is sent to the generation model rather than to the renderer.
 */
export const MANIFEST_ASSET_ROLES = [
  'APP_SCREENSHOT',
  'LOGO',
  'LICENSED_CLIP',
  'MUSIC',
  'REFERENCE_IMAGE',
] as const;
export const ManifestAssetRoleSchema = z.enum(MANIFEST_ASSET_ROLES);
export type ManifestAssetRole = z.infer<typeof ManifestAssetRoleSchema>;

export const ManifestAssetSchema = z
  .object({
    id: z.string().min(1),
    role: ManifestAssetRoleSchema,
    kind: z.enum(['VIDEO', 'IMAGE', 'AUDIO']),
    /** Absolute, or relative to the manifest file. Containment is enforced at resolution. */
    path: z.string().min(1),
    description: z.string().min(1),
    license: ManifestLicenseSchema,
  })
  .strict();
export type ManifestAsset = z.infer<typeof ManifestAssetSchema>;

export const GenerationSettingsSchema = z
  .object({
    /** A `ComfyUIWorkflowProfileKey`. Validated against the live registry when the provider is built. */
    profile: z.string().min(1).default('LTX_2_3_DRAFT'),
    /** How many shots to actually generate. The rest of the timeline is filled from supplied assets. */
    shotCount: z.number().int().positive().max(6).default(1),
    /** Per-shot ceiling. Latent video models snap frame counts, so the real clip may be slightly different. */
    maxShotDurationSeconds: z.number().positive().max(10).default(4),
    candidateCount: z.number().int().positive().max(4).default(1),
    /** Fixed seed for a reproducible run. Omitted means "derive from the idempotency key". */
    seed: z.number().int().nonnegative().optional(),
  })
  .strict();

export const CtaSchema = z
  .object({
    headline: z.string().min(1).max(80),
    subline: z.string().min(1).max(120).optional(),
    durationSeconds: z.number().positive().max(10),
  })
  .strict();

const CampaignGenerationManifestObjectSchema = z
  .object({
    manifestVersion: z.literal(1),
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'name must be filesystem-safe'),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),

    brandName: z.string().min(1).max(120),
    /** The free-text brief. This is the "PROMPT" end of prompt-to-video. */
    campaignPrompt: z.string().min(1).max(4000),
    objective: z.string().min(1).max(500),
    targetAudience: z.string().min(1).max(500),
    /** The opening beat the ad must earn attention with. */
    hook: z.string().min(1).max(300),
    keyMessages: z.array(z.string().min(1)).default([]),
    mandatories: z.array(z.string().min(1)).default([]),

    outputDurationSeconds: z.number().positive().max(120),
    /** Reservation ceiling for the whole run, in cents. */
    budgetCents: z.number().int().nonnegative().default(0),

    generation: GenerationSettingsSchema.default({}),
    cta: CtaSchema,
    assets: z.array(ManifestAssetSchema).min(1),
  })
  .strict();

export const CampaignGenerationManifestV1Schema =
  CampaignGenerationManifestObjectSchema.superRefine((manifest, ctx) => {
    const addIssue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };

    const ids = new Set<string>();
    manifest.assets.forEach((asset, index) => {
      if (ids.has(asset.id)) addIssue(`duplicate asset id "${asset.id}"`, ['assets', index, 'id']);
      ids.add(asset.id);

      if (asset.role === 'MUSIC' && asset.kind !== 'AUDIO') {
        addIssue('a MUSIC asset must be AUDIO', ['assets', index, 'kind']);
      }
      if ((asset.role === 'LOGO' || asset.role === 'APP_SCREENSHOT') && asset.kind !== 'IMAGE') {
        addIssue(`a ${asset.role} asset must be IMAGE`, ['assets', index, 'kind']);
      }
      if (asset.role === 'LICENSED_CLIP' && asset.kind !== 'VIDEO') {
        addIssue('a LICENSED_CLIP asset must be VIDEO', ['assets', index, 'kind']);
      }
      // Caught here as well as at the provider and the renderer: an
      // ANALYSIS_ONLY asset has no legitimate role in a production manifest,
      // and saying so at parse time is far more legible than a refusal three
      // stages later.
      if (asset.license.usageClass === 'ANALYSIS_ONLY') {
        addIssue(
          `asset "${asset.id}" is ANALYSIS_ONLY — reference material may be studied but never placed in an output manifest`,
          ['assets', index, 'license', 'usageClass'],
        );
      }
    });

    if (!manifest.assets.some((asset) => asset.role === 'LOGO')) {
      addIssue('at least one LOGO asset is required', ['assets']);
    }
    if (!manifest.assets.some((asset) => asset.role === 'APP_SCREENSHOT')) {
      addIssue('at least one APP_SCREENSHOT asset is required', ['assets']);
    }
    if (manifest.cta.durationSeconds >= manifest.outputDurationSeconds) {
      addIssue('the CTA cannot be as long as the whole cut', ['cta', 'durationSeconds']);
    }

    const generatedSeconds =
      manifest.generation.shotCount * manifest.generation.maxShotDurationSeconds;
    if (generatedSeconds > manifest.outputDurationSeconds) {
      addIssue(
        `generation asks for ${generatedSeconds}s of footage but the cut is only ${manifest.outputDurationSeconds}s`,
        ['generation', 'shotCount'],
      );
    }
  });

export type CampaignGenerationManifest = z.infer<typeof CampaignGenerationManifestV1Schema>;

export class GenerationManifestValidationError extends Error {
  constructor(
    public readonly issues: readonly { path: string; message: string }[],
    public readonly manifestPath?: string,
  ) {
    const where = manifestPath ? ` (${manifestPath})` : '';
    super(
      `Campaign generation manifest is invalid${where}:\n${issues
        .map((issue) => `  - ${issue.path || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'GenerationManifestValidationError';
  }
}

export function parseGenerationManifest(
  value: unknown,
  manifestPath?: string,
): CampaignGenerationManifest {
  const result = CampaignGenerationManifestV1Schema.safeParse(value);
  if (result.success) return result.data;
  throw new GenerationManifestValidationError(
    result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
    manifestPath,
  );
}

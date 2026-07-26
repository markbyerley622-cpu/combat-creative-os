import { z } from 'zod';

/**
 * The production asset manifest — every real file that may contribute bytes to
 * a finished advertisement, with the rights that permit it.
 *
 * This is the *production* register, deliberately separate from anything a
 * future Creative Memory would hold. Benchmark advertisements, competitor
 * reels and any other study-only reference are `ANALYSIS_ONLY` and are refused
 * here by construction: they may be analysed for pacing and structure, and
 * they may never appear in an output manifest. The enum below includes the
 * refused classes on purpose — declaring one and being told exactly why it is
 * refused is far more useful than a generic "invalid enum value".
 */

const IsoDateStringSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

/**
 * Rights classes.
 *
 * The first three permit output. `ANALYSIS_ONLY` and `UNKNOWN_RIGHTS` are
 * declarable but always refused — the second one matters most, because
 * "we're not sure" is the state real asset libraries are actually in, and
 * silently treating it as permitted is how unlicensed footage ships.
 */
export const RIGHTS_CLASSIFICATIONS = [
  'OWNED',
  'COMMISSIONED',
  'LICENSED_FOR_OUTPUT',
  'ANALYSIS_ONLY',
  'UNKNOWN_RIGHTS',
] as const;
export const RightsClassificationSchema = z.enum(RIGHTS_CLASSIFICATIONS);
export type RightsClassification = z.infer<typeof RightsClassificationSchema>;

/** The only three classes whose bytes may reach FFmpeg. */
export const OUTPUT_PERMITTED_CLASSIFICATIONS: readonly RightsClassification[] = [
  'OWNED',
  'COMMISSIONED',
  'LICENSED_FOR_OUTPUT',
];

export function permitsOutput(classification: RightsClassification): boolean {
  return OUTPUT_PERMITTED_CLASSIFICATIONS.includes(classification);
}

export const AssetRightsSchema = z
  .object({
    classification: RightsClassificationSchema,
    /** Who owns or licensed it. Required even for OWNED — "Combat Reviews" is an answer. */
    owner: z.string().min(1).max(200),
    /**
     * The operator's own assertion that this may appear in a published
     * advertisement. Both this *and* an output-permitting classification are
     * required: a licence that covers internal review but not paid media is a
     * real and common case.
     */
    permittedOutputUse: z.boolean(),
    attribution: z.string().min(1).max(300).optional(),
    /** Absent means perpetual. Present and past refuses the asset. */
    expiresAt: IsoDateStringSchema.optional(),
    restrictions: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type AssetRights = z.infer<typeof AssetRightsSchema>;

export const ASSET_KINDS = ['VIDEO', 'IMAGE', 'AUDIO'] as const;
export const AssetKindSchema = z.enum(ASSET_KINDS);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/**
 * What the asset is for. Drives selection: a `SOURCE_CLIP` can fill a story
 * beat, an `APP_SCREENSHOT` shows the product, a `BRAND_CARD` is the designed
 * fallback when no footage fits, and a `LOGO` is never a scene.
 */
export const ASSET_ROLES = [
  'SOURCE_CLIP',
  'APP_SCREENSHOT',
  'BRAND_CARD',
  'LOGO',
  'MUSIC',
] as const;
export const AssetRoleSchema = z.enum(ASSET_ROLES);
export type AssetRole = z.infer<typeof AssetRoleSchema>;

/**
 * Story beats an asset can serve. Deliberately a closed vocabulary rather than
 * free tags: selection has to be deterministic and explainable, and matching
 * arbitrary strings would make "why was this clip chosen?" unanswerable.
 * Free-form `tags` remain available for tie-breaking.
 */
export const STORY_BEATS = [
  'HOOK',
  'EVENT_DETAIL',
  'INFORMATION',
  'PREDICTION',
  'DISCUSSION',
  'CTA',
] as const;
export const StoryBeatSchema = z.enum(STORY_BEATS);
export type StoryBeat = z.infer<typeof StoryBeatSchema>;

export const ProductionAssetSchema = z
  .object({
    id: z.string().min(1).max(80),
    /** Relative to the manifest file, or absolute. Containment is enforced at resolution. */
    path: z.string().min(1),
    kind: AssetKindSchema,
    role: AssetRoleSchema,
    description: z.string().min(1).max(300),
    rights: AssetRightsSchema,
    /** Beats this asset can serve. Empty means "usable anywhere its kind fits". */
    beats: z.array(StoryBeatSchema).default([]),
    tags: z.array(z.string().min(1).max(60)).default([]),
    /** Expected sha256. A mismatch refuses the asset rather than rendering the wrong file. */
    checksumSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'checksumSha256 must be a lowercase hex sha256')
      .optional(),
    /** Declared metadata. Always re-measured with ffprobe; a disagreement is reported. */
    declaredDurationSeconds: z.number().positive().optional(),
    declaredWidthPx: z.number().int().positive().optional(),
    declaredHeightPx: z.number().int().positive().optional(),
  })
  .strict();
export type ProductionAsset = z.infer<typeof ProductionAssetSchema>;

const ProductionAssetManifestObjectSchema = z
  .object({
    manifestVersion: z.literal(1),
    /** Human label for this asset library, e.g. "Combat Reviews owned library". */
    library: z.string().min(1).max(200),
    assets: z.array(ProductionAssetSchema).min(1),
  })
  .strict();

export const ProductionAssetManifestV1Schema = ProductionAssetManifestObjectSchema.superRefine(
  (manifest, ctx) => {
    const addIssue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };

    const ids = new Set<string>();
    manifest.assets.forEach((asset, index) => {
      if (ids.has(asset.id)) addIssue(`duplicate asset id "${asset.id}"`, ['assets', index, 'id']);
      ids.add(asset.id);

      // Refused at parse time, with the reason named. Catching this here means
      // a study-only reference can never reach selection, resolution or FFmpeg
      // — there is no later stage where a mistake could slip through.
      if (asset.rights.classification === 'ANALYSIS_ONLY') {
        addIssue(
          `asset "${asset.id}" is ANALYSIS_ONLY — benchmark and reference material may be studied for structure and pacing, but must never enter a production asset manifest`,
          ['assets', index, 'rights', 'classification'],
        );
      }
      if (asset.rights.classification === 'UNKNOWN_RIGHTS') {
        addIssue(
          `asset "${asset.id}" has UNKNOWN_RIGHTS — establish and record the rights before using it in an advertisement`,
          ['assets', index, 'rights', 'classification'],
        );
      }
      if (!asset.rights.permittedOutputUse) {
        addIssue(
          `asset "${asset.id}" is marked permittedOutputUse: false — it may not contribute bytes to an output`,
          ['assets', index, 'rights', 'permittedOutputUse'],
        );
      }

      if (asset.role === 'MUSIC' && asset.kind !== 'AUDIO') {
        addIssue(`asset "${asset.id}" is MUSIC but not AUDIO`, ['assets', index, 'kind']);
      }
      if ((asset.role === 'LOGO' || asset.role === 'APP_SCREENSHOT') && asset.kind !== 'IMAGE') {
        addIssue(`asset "${asset.id}" is ${asset.role} but not IMAGE`, ['assets', index, 'kind']);
      }
      if (asset.role === 'SOURCE_CLIP' && asset.kind !== 'VIDEO') {
        addIssue(`asset "${asset.id}" is SOURCE_CLIP but not VIDEO`, ['assets', index, 'kind']);
      }
    });

    if (!manifest.assets.some((asset) => asset.role === 'LOGO')) {
      addIssue('at least one LOGO asset is required', ['assets']);
    }
  },
);

export type ProductionAssetManifest = z.infer<typeof ProductionAssetManifestV1Schema>;

export class ProductionAssetManifestError extends Error {
  constructor(
    public readonly issues: readonly { path: string; message: string }[],
    public readonly manifestPath?: string,
  ) {
    const where = manifestPath ? ` (${manifestPath})` : '';
    super(
      `Production asset manifest is invalid${where}:\n${issues
        .map((issue) => `  - ${issue.path || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'ProductionAssetManifestError';
  }
}

export function parseProductionAssetManifest(
  value: unknown,
  manifestPath?: string,
): ProductionAssetManifest {
  const result = ProductionAssetManifestV1Schema.safeParse(value);
  if (result.success) return result.data;
  throw new ProductionAssetManifestError(
    result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
    manifestPath,
  );
}

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';

import { DeliveryPlatformSchema } from '@combat/domain';
import { z } from 'zod';

/**
 * The campaign request — the canonical input to `pnpm aamp:generate`.
 *
 * This replaces the previous milestone's generation manifest as the primary
 * interface, and the difference is the point of this milestone. That document
 * described a *cut* (durations, assets, a CTA). This one describes a
 * *campaign*: what is being advertised, to whom, with which verifiable facts,
 * and what the requester actually asked for in their own words. The prompt and
 * the facts are the inputs the agents reason over; everything visual is
 * derived.
 *
 * Versioned by literal discriminator and `.strict()`, for the reason
 * `RenderManifestV1Schema` documents: a v2 request should fail parsing here
 * rather than be half-understood by a v1 reader.
 */

const IsoDateStringSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

/**
 * A verifiable claim about the product. Kept as structured `label`/`detail`
 * pairs rather than free prose so the agents receive them as *constraints*
 * rather than as more prompt to paraphrase — and so a later reviewer can check
 * each one against the finished ad.
 */
export const ProductFactSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    detail: z.string().min(1).max(600),
  })
  .strict();
export type ProductFact = z.infer<typeof ProductFactSchema>;

/** A dated fact about upcoming coverage — the "this weekend" half of the brief. */
export const EventFactSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    detail: z.string().min(1).max(600),
    startsAt: IsoDateStringSchema.optional(),
  })
  .strict();
export type EventFact = z.infer<typeof EventFactSchema>;

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colour must be #RRGGBB');

/**
 * Brand constants the renderer must honour. These reference assets by id in
 * the production asset manifest rather than by path — the request never names
 * a file, so a request cannot smuggle in an unvetted source.
 */
export const BrandKitSchema = z
  .object({
    logoAssetId: z.string().min(1),
    primaryColorHex: HexColorSchema.default('#0B0B0F'),
    accentColorHex: HexColorSchema.default('#FF3B30'),
    captionFontFamily: z.string().min(1).default('Arial'),
    /** Distance kept clear of the top and bottom edges, in output pixels. */
    safeAreaTopPx: z.number().int().min(0).max(600).default(220),
    safeAreaBottomPx: z.number().int().min(0).max(900).default(420),
  })
  .strict();
export type BrandKit = z.infer<typeof BrandKitSchema>;

export const RequestCtaSchema = z
  .object({
    headline: z.string().min(1).max(80),
    subline: z.string().min(1).max(120).optional(),
    durationSeconds: z.number().positive().max(10).default(3),
  })
  .strict();

/**
 * Where footage comes from.
 *
 * `SOURCE_ONLY` is the default and the whole reason this milestone exists: a
 * useful advertisement is assembled from real owned/licensed material with no
 * GPU, no ComfyUI and no generated footage. `COMFYUI` additionally generates
 * shots, and is only usable when a compatible endpoint is configured — the CLI
 * verifies that rather than assuming it.
 */
export const GENERATION_SOURCES = ['SOURCE_ONLY', 'COMFYUI'] as const;
export const GenerationSourceSchema = z.enum(GENERATION_SOURCES);
export type GenerationSource = z.infer<typeof GenerationSourceSchema>;

export const RequestGenerationSchema = z
  .object({
    source: GenerationSourceSchema.default('SOURCE_ONLY'),
    /** Only consulted when `source` is COMFYUI. */
    comfyuiProfile: z.string().min(1).default('LTX_2_3_DRAFT'),
    generatedShotCount: z.number().int().min(0).max(6).default(0),
    maxGeneratedShotSeconds: z.number().positive().max(10).default(4),
  })
  .strict();

const CampaignRequestObjectSchema = z
  .object({
    requestVersion: z.literal(1),
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'name must be filesystem-safe'),
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),

    brandName: z.string().min(1).max(120),

    /**
     * The brief, in the requester's own words. Exactly one of this or
     * `promptFile` must be present — `promptFile` exists so a multi-paragraph
     * brief never has to survive PowerShell quoting.
     */
    campaignPrompt: z.string().min(1).max(8000).optional(),
    /** Path to a UTF-8 text file holding the prompt. Resolved relative to the request file. */
    promptFile: z.string().min(1).optional(),

    objective: z.string().min(1).max(500),
    targetAudience: z.string().min(1).max(1000),
    platform: DeliveryPlatformSchema.default('TIKTOK'),
    targetDurationSeconds: z.number().positive().max(120),

    productFacts: z.array(ProductFactSchema).min(1),
    eventFacts: z.array(EventFactSchema).default([]),
    keyMessages: z.array(z.string().min(1)).default([]),
    mandatories: z.array(z.string().min(1)).default([]),

    cta: RequestCtaSchema,
    brandKit: BrandKitSchema,

    /** Path to the production asset manifest. Resolved relative to the request file. */
    sourceAssetManifest: z.string().min(1),
    /** Run directory root. Resolved relative to the repository root. */
    outputDirectory: z.string().min(1).default('.aamp-output/runs'),

    generation: RequestGenerationSchema.default({}),
  })
  .strict();

export const CampaignRequestV1Schema = CampaignRequestObjectSchema.superRefine((request, ctx) => {
  const addIssue = (message: string, path: (string | number)[]): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  };

  const hasInline = (request.campaignPrompt ?? '').trim().length > 0;
  const hasFile = (request.promptFile ?? '').trim().length > 0;
  if (hasInline === hasFile) {
    addIssue(
      hasInline
        ? 'supply campaignPrompt or promptFile, not both — two prompts means no canonical brief'
        : 'a campaign prompt is required: set campaignPrompt, or promptFile pointing at a text file',
      ['campaignPrompt'],
    );
  }

  if (request.cta.durationSeconds >= request.targetDurationSeconds) {
    addIssue('the CTA cannot be as long as the whole cut', ['cta', 'durationSeconds']);
  }

  for (const [collection, label] of [
    [request.productFacts, 'productFacts'],
    [request.eventFacts, 'eventFacts'],
  ] as const) {
    const ids = new Set<string>();
    collection.forEach((fact, index) => {
      if (ids.has(fact.id)) addIssue(`duplicate ${label} id "${fact.id}"`, [label, index, 'id']);
      ids.add(fact.id);
    });
  }

  if (request.generation.source === 'COMFYUI' && request.generation.generatedShotCount === 0) {
    addIssue(
      'generation.source is COMFYUI but generatedShotCount is 0 — either request generated shots or use SOURCE_ONLY',
      ['generation', 'generatedShotCount'],
    );
  }
  if (request.generation.source === 'SOURCE_ONLY' && request.generation.generatedShotCount > 0) {
    addIssue('generation.source is SOURCE_ONLY but generatedShotCount is greater than 0', [
      'generation',
      'generatedShotCount',
    ]);
  }
});

export type CampaignRequestFile = z.infer<typeof CampaignRequestV1Schema>;

/**
 * A request whose prompt has been resolved from `promptFile` and whose paths
 * are absolute. This — not the file — is what the pipeline consumes, so no
 * downstream code has to think about which of the two prompt fields was used.
 */
export interface CampaignRequest extends Omit<
  CampaignRequestFile,
  'campaignPrompt' | 'promptFile'
> {
  readonly campaignPrompt: string;
  /** Lowercase hex sha256 of the resolved prompt. Recorded in provenance; the prompt itself is not a secret. */
  readonly promptSha256: string;
  readonly sourceAssetManifestPath: string;
  readonly requestPath: string;
}

export class CampaignRequestValidationError extends Error {
  constructor(
    public readonly issues: readonly { path: string; message: string }[],
    public readonly requestPath?: string,
  ) {
    const where = requestPath ? ` (${requestPath})` : '';
    super(
      `Campaign request is invalid${where}:\n${issues
        .map((issue) => `  - ${issue.path || '<root>'}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'CampaignRequestValidationError';
  }
}

export function parseCampaignRequest(value: unknown, requestPath?: string): CampaignRequestFile {
  const result = CampaignRequestV1Schema.safeParse(value);
  if (result.success) return result.data;
  throw new CampaignRequestValidationError(
    result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
    requestPath,
  );
}

/**
 * Rejects a path that escapes the directory it is declared relative to.
 *
 * A request file is operator-authored, but it is also the kind of file that
 * gets templated, generated and passed around, so `../../..` in a path field
 * is treated as a defect rather than a convenience.
 */
export function resolveContainedPath(
  candidate: string,
  baseDirectory: string,
  field: string,
): string {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(baseDirectory, candidate);
  const base = resolve(baseDirectory);
  const contained =
    absolute === base || absolute.startsWith(`${base}\\`) || absolute.startsWith(`${base}/`);
  if (!contained && !isAbsolute(candidate)) {
    throw new CampaignRequestValidationError([
      { path: field, message: `"${candidate}" escapes ${base}` },
    ]);
  }
  return absolute;
}

export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt.trim(), 'utf8').digest('hex');
}

/**
 * Reads a request file, resolves its prompt (inline or from `promptFile`) and
 * its manifest path, and returns the canonical in-memory request.
 */
export async function loadCampaignRequest(requestPath: string): Promise<CampaignRequest> {
  const raw = JSON.parse(await readFile(requestPath, 'utf8')) as unknown;
  const parsed = parseCampaignRequest(raw, requestPath);
  const requestDir = dirname(resolve(requestPath));

  let campaignPrompt = (parsed.campaignPrompt ?? '').trim();
  if (parsed.promptFile) {
    const promptPath = resolveContainedPath(parsed.promptFile, requestDir, 'promptFile');
    campaignPrompt = (await readFile(promptPath, 'utf8')).trim();
    if (campaignPrompt.length === 0) {
      throw new CampaignRequestValidationError(
        [{ path: 'promptFile', message: `${promptPath} is empty` }],
        requestPath,
      );
    }
  }

  const { campaignPrompt: _inline, promptFile: _file, ...rest } = parsed;
  return {
    ...rest,
    campaignPrompt,
    promptSha256: hashPrompt(campaignPrompt),
    sourceAssetManifestPath: resolveContainedPath(
      parsed.sourceAssetManifest,
      requestDir,
      'sourceAssetManifest',
    ),
    requestPath: resolve(requestPath),
  };
}

/**
 * The factual constraints, flattened into the labelled lines the agents
 * receive. Ordered exactly as declared so the same request always produces the
 * same agent input — which is what makes planning reproducible and what the
 * prompt-propagation tests assert.
 */
export function formatFactualConstraints(request: CampaignRequest): string[] {
  return [
    ...request.productFacts.map((fact) => `PRODUCT — ${fact.label}: ${fact.detail}`),
    ...request.eventFacts.map(
      (fact) =>
        `EVENT — ${fact.label}: ${fact.detail}${fact.startsAt ? ` (starts ${fact.startsAt})` : ''}`,
    ),
  ];
}

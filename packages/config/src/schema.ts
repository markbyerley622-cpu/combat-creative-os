import { z } from 'zod';

const booleanFromString = z
  .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
  .transform((v) => v === 'true' || v === '1')
  .or(z.boolean());

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
      message: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    }),
});

export const temporalEnvSchema = z.object({
  TEMPORAL_ADDRESS: z.string().min(1).default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default('combat-creative-os'),
});

export const minioEnvSchema = z.object({
  MINIO_ENDPOINT: z.string().min(1).default('localhost'),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_USE_SSL: booleanFromString.default(false),
  MINIO_ACCESS_KEY: z.string().min(1).default('minioadmin'),
  MINIO_SECRET_KEY: z.string().min(1).default('minioadmin'),
  MINIO_BUCKET: z.string().min(1).default('combat-creative-assets'),
  // MinIO's own documented local-dev default region ("us-east-1" is accepted
  // by MinIO regardless of the real AWS region list — it's a required S3 API
  // parameter, not a real geography here).
  MINIO_REGION: z.string().min(1).default('us-east-1'),
  // MinIO (and most self-hosted S3-compatible stores) requires path-style
  // addressing; real AWS S3 defaults to virtual-hosted-style, so production
  // config against real S3 should set this to false.
  MINIO_FORCE_PATH_STYLE: booleanFromString.default(true),
});

/**
 * `ANTHROPIC_API_KEY` is optional at the schema level because the default
 * `REASONING_PROVIDER` is `mock` — local dev and CI never require a real key
 * (CLAUDE.md: "Local development must work with zero paid API keys").
 *
 * **M14 — fails closed.** Selecting `claude` without a key used to be only a
 * documented caller responsibility, which meant a production misconfiguration
 * could silently fall back to the deterministic mock and quietly produce
 * fabricated creative work. The refinement below turns that into a startup
 * error at the config boundary, so the process cannot come up half-configured.
 */
export const reasoningEnvSchema = z.object({
  REASONING_PROVIDER: z.enum(['mock', 'claude']).default('mock'),
  REASONING_MODEL: z.string().min(1).default('claude-opus-4-8'),
  ANTHROPIC_API_KEY: z.string().optional(),
});

/**
 * M14 — the fail-closed check, applied to every composed app schema that
 * includes reasoning config. Kept as a standalone refinement (rather than
 * folded into `reasoningEnvSchema`) so the base object stays `.merge`-able.
 */
export function refineReasoningConfig(
  env: { REASONING_PROVIDER: 'mock' | 'claude'; ANTHROPIC_API_KEY?: string },
  ctx: z.RefinementCtx,
): void {
  if (env.REASONING_PROVIDER === 'claude' && !env.ANTHROPIC_API_KEY?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ANTHROPIC_API_KEY'],
      message:
        'ANTHROPIC_API_KEY is required when REASONING_PROVIDER=claude — refusing to start rather than silently falling back to the mock provider',
    });
  }
}
export type ReasoningEnv = z.infer<typeof reasoningEnvSchema>;

/**
 * AAMP-1 step 2 — Clerk identity configuration.
 *
 * Both values are `optional()` at the object level only so that
 * `refineAuthConfig` can report a *useful* message instead of Zod's generic
 * "Required"; every composed schema that includes this applies that refinement,
 * so an `apps/api` process cannot start without a secret key. There is no
 * "auth disabled" mode and no environment in which one is tolerated: the
 * deterministic fake verifier is not reachable from configuration at all (see
 * `@combat/auth/testing`'s doc comment), so a missing key can only ever mean
 * misconfiguration, never a legitimate degraded mode.
 */
export const authEnvSchema = z.object({
  CLERK_SECRET_KEY: z.string().optional(),
  /**
   * Comma-separated origins whose session tokens this API accepts (`azp`).
   * Optional: unset means "do not check the authorized party", which is only
   * appropriate locally — `refineAuthConfig` requires it in production.
   */
  CLERK_AUTHORIZED_PARTIES: z.string().optional(),
});
export type AuthEnv = z.infer<typeof authEnvSchema>;

/** Splits `CLERK_AUTHORIZED_PARTIES` into the list the Clerk adapter takes. */
export function parseAuthorizedParties(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((party) => party.trim())
    .filter((party) => party.length > 0);
}

/**
 * Fails closed on missing or placeholder identity configuration — the same
 * discipline `refineReasoningConfig` applies to the reasoning provider, for the
 * same reason: a control that silently does nothing is worse than one that
 * refuses to start.
 *
 * A publishable key in the secret slot is rejected explicitly. It is the single
 * most likely paste error, it would fail only at the first real request, and
 * `pk_*` is a *public* value — treating it as a secret is exactly the mistake
 * worth catching at the config boundary.
 */
export function refineAuthConfig(
  env: { NODE_ENV: 'development' | 'test' | 'production' } & AuthEnv,
  ctx: z.RefinementCtx,
): void {
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CLERK_SECRET_KEY'],
      message:
        'CLERK_SECRET_KEY is required — refusing to start rather than serving requests with no caller authentication',
    });
    return;
  }
  if (secretKey.startsWith('pk_')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CLERK_SECRET_KEY'],
      message:
        'CLERK_SECRET_KEY looks like a publishable key (pk_*) — a publishable key is public and cannot verify session tokens',
    });
  }
  if (
    env.NODE_ENV === 'production' &&
    parseAuthorizedParties(env.CLERK_AUTHORIZED_PARTIES).length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CLERK_AUTHORIZED_PARTIES'],
      message:
        'CLERK_AUTHORIZED_PARTIES is required in production — without it a session token minted for another front-end can be replayed against this API',
    });
  }
}

/**
 * AAMP generation vertical slice 2 — video generation provider selection.
 *
 * The default stays `mock` so CI, local tests and a fresh clone need no GPU,
 * no endpoint and no credentials (CLAUDE.md: "Every real-media milestone must
 * preserve mock mode"). `refineVideoGenerationConfig` is what stops that
 * default from being a production foot-gun: a production process that selects
 * `mock`, or selects `comfyui` without an endpoint, refuses to start.
 *
 * `COMFYUI_API_KEY` is optional because a self-hosted ComfyUI has no
 * authentication at all; it exists for endpoints published behind an
 * authenticating proxy. Like every other secret here it is read only through
 * this schema, never `process.env` in adapter code, and it is redacted by
 * `createLogger`'s pino configuration.
 */
export const videoGenerationEnvSchema = z.object({
  VIDEO_GENERATION_PROVIDER: z.enum(['mock', 'comfyui']).default('mock'),
  COMFYUI_BASE_URL: z.string().optional(),
  /**
   * End-to-end deadline for one shot, not a per-HTTP-request timeout. Video
   * sampling is minutes of GPU work, so the default is generous; the request
   * timeout underneath it is a separate, much shorter budget.
   */
  COMFYUI_OUTPUT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60_000),
  /**
   * Kept a plain string rather than a `z.enum` of the profile keys because
   * `packages/config` must not depend on `packages/providers`. The value is
   * validated against the real registry when the provider is constructed, and
   * `apps/worker`'s test asserts the two lists agree.
   */
  COMFYUI_WORKFLOW_PROFILE: z.string().min(1).default('LTX_2_3_DRAFT'),
  COMFYUI_CLIENT_ID: z.string().min(1).default('combat-creative-os'),
  COMFYUI_API_KEY: z.string().optional(),
  /** Where retrieved generated clips land. Repository-relative unless absolute. */
  COMFYUI_OUTPUT_DIR: z.string().min(1).default('.aamp-output/generated'),
});
export type VideoGenerationEnv = z.infer<typeof videoGenerationEnvSchema>;

/**
 * Fails closed on both halves of the "no silent mock" rule.
 *
 * Selecting `comfyui` without an endpoint is an obvious misconfiguration.
 * Leaving `mock` selected in production is the *dangerous* one: the process
 * would come up healthy, run the whole workflow, charge budget, pass its gates
 * and deliver an advertisement built from placeholder metadata — the exact
 * failure the AAMP rules call out ("Never substitute a mock result"). It is
 * caught here, at startup, rather than discovered in a deliverable.
 */
export function refineVideoGenerationConfig(
  env: { NODE_ENV: 'development' | 'test' | 'production' } & VideoGenerationEnv,
  ctx: z.RefinementCtx,
): void {
  if (env.VIDEO_GENERATION_PROVIDER === 'mock') {
    if (env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['VIDEO_GENERATION_PROVIDER'],
        message:
          'VIDEO_GENERATION_PROVIDER=mock is refused in production — the mock produces no real media, so a production process running it would deliver fabricated output',
      });
    }
    return;
  }

  if (!env.COMFYUI_BASE_URL?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COMFYUI_BASE_URL'],
      message:
        'COMFYUI_BASE_URL is required when VIDEO_GENERATION_PROVIDER=comfyui — refusing to start rather than silently falling back to the mock provider',
    });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(env.COMFYUI_BASE_URL);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COMFYUI_BASE_URL'],
      message: `COMFYUI_BASE_URL is not a valid URL: ${env.COMFYUI_BASE_URL}`,
    });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COMFYUI_BASE_URL'],
      message: `COMFYUI_BASE_URL must be http: or https:, got ${parsed.protocol}`,
    });
  }
}

/**
 * Creative Memory retrieval configuration.
 *
 * `CREATIVE_MEMORY_MODEL_DOWNLOAD_POLICY` defaults to `deny` and is the only
 * switch that could ever permit a model download. No code path in this
 * repository fetches weights regardless — the setting exists so that a future
 * one cannot be added without an operator deliberately flipping it, and so the
 * refusal is visible in configuration rather than buried in a comment.
 *
 * Endpoint credentials are read only through this schema and are redacted from
 * every error, log line, generated artefact and Qdrant payload.
 */
export const creativeMemoryEnvSchema = z.object({
  CREATIVE_MEMORY_EMBEDDING_PROFILE: z
    .enum(['STRUCTURAL_BASELINE_V1', 'QWEN3_VL_2B_QUALITY_V1', 'QWEN3_VL_8B_REMOTE_QUALITY_V1'])
    .default('STRUCTURAL_BASELINE_V1'),
  CREATIVE_MEMORY_EMBEDDING_ENDPOINT: z.string().optional(),
  CREATIVE_MEMORY_RERANKER_ENDPOINT: z.string().optional(),
  CREATIVE_MEMORY_EMBEDDING_API_KEY: z.string().optional(),
  CREATIVE_MEMORY_MODEL_DOWNLOAD_POLICY: z.enum(['deny', 'allow']).default('deny'),
  CREATIVE_MEMORY_MODEL_CACHE_DIR: z.string().min(1).default('.aamp-model-cache'),
  CREATIVE_MEMORY_BATCH_SIZE: z.coerce.number().int().positive().max(256).default(16),
  CREATIVE_MEMORY_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  QDRANT_URL: z.string().min(1).default('http://127.0.0.1:6333'),
  QDRANT_API_KEY: z.string().optional(),
});
export type CreativeMemoryEnv = z.infer<typeof creativeMemoryEnvSchema>;

/**
 * A neural profile without an endpoint cannot work, and falling back to the
 * structural baseline silently would mean a collection labelled "Qwen"
 * holding non-neural vectors. Refused at the config boundary instead.
 */
export function refineCreativeMemoryConfig(env: CreativeMemoryEnv, ctx: z.RefinementCtx): void {
  if (
    env.CREATIVE_MEMORY_EMBEDDING_PROFILE !== 'STRUCTURAL_BASELINE_V1' &&
    !env.CREATIVE_MEMORY_EMBEDDING_ENDPOINT?.trim()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CREATIVE_MEMORY_EMBEDDING_ENDPOINT'],
      message: `CREATIVE_MEMORY_EMBEDDING_ENDPOINT is required for profile ${env.CREATIVE_MEMORY_EMBEDDING_PROFILE} — refusing to start rather than silently indexing with the non-neural baseline under a neural profile name`,
    });
  }
}

/**
 * M5: asset-ingestion limits. Deliberately not "configurable" per MIME type
 * — a single byte ceiling plus a code-level MIME allowlist (see
 * packages/workflows' ingest-asset-activity.ts) is enough for this
 * milestone's brand-asset/reference-upload scope, and keeps the env surface
 * small rather than trying to serialize a MIME-to-limit map through env vars.
 */
export const assetEnvSchema = z.object({
  ASSET_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(200 * 1024 * 1024),
  ASSET_UPLOAD_URL_EXPIRY_SECONDS: z.coerce.number().int().positive().default(900),
  ASSET_DOWNLOAD_URL_EXPIRY_SECONDS: z.coerce.number().int().positive().default(3600),
});

export const observabilityEnvSchema = z.object({
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});

// apps/api deliberately carries no reasoning config — agents run in
// apps/worker, so only the worker schema applies `refineReasoningConfig`.
export const apiEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(temporalEnvSchema)
  .merge(minioEnvSchema)
  .merge(assetEnvSchema)
  .merge(observabilityEnvSchema)
  .merge(authEnvSchema)
  .extend({
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(4000),
  })
  // AAMP-1 step 2: apps/api is the only process that verifies caller identity,
  // so it is the only one that refuses to start without identity config.
  .superRefine(refineAuthConfig);
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(temporalEnvSchema)
  .merge(minioEnvSchema)
  .merge(assetEnvSchema)
  .merge(observabilityEnvSchema)
  .merge(reasoningEnvSchema)
  .merge(videoGenerationEnvSchema)
  .extend({
    WORKER_HEALTH_HOST: z.string().min(1).default('0.0.0.0'),
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4100),
  })
  // M14: fails closed rather than silently falling back to the mock provider.
  .superRefine(refineReasoningConfig)
  // AAMP slice 2: the same discipline for the video-generation provider.
  .superRefine(refineVideoGenerationConfig);
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * `apps/aamp-cli` — the prompt-to-MP4 composition root. It runs the same
 * agents and the same ComfyUI adapter the Worker does, but reaches neither
 * Temporal nor the API, so it carries reasoning + generation config and
 * nothing else. No `DATABASE_URL`: the CLI writes its artefacts to disk and
 * leaves repository registration to the Activity path.
 */
export const aampCliEnvSchema = baseEnvSchema
  .merge(reasoningEnvSchema)
  .merge(videoGenerationEnvSchema)
  .merge(creativeMemoryEnvSchema)
  .superRefine(refineReasoningConfig)
  .superRefine(refineVideoGenerationConfig)
  .superRefine(refineCreativeMemoryConfig);
export type AampCliEnv = z.infer<typeof aampCliEnvSchema>;

/**
 * The dashboard holds no secret. It needs only the **publishable** key — a
 * value Clerk designs to ship in the client bundle — plus the sign-in/sign-up
 * route names. `CLERK_SECRET_KEY` is deliberately absent from this schema:
 * apps/dashboard has no code path that could read it, which is the structural
 * half of "the secret key cannot enter a client bundle".
 */
export const dashboardEnvSchema = baseEnvSchema.extend({
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  PORT: z.coerce.number().int().positive().default(3000),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_CLERK_SIGN_IN_URL: z.string().min(1).default('/sign-in'),
  NEXT_PUBLIC_CLERK_SIGN_UP_URL: z.string().min(1).default('/sign-up'),
});
export type DashboardEnv = z.infer<typeof dashboardEnvSchema>;

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
  .extend({
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(4000),
  });
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(temporalEnvSchema)
  .merge(minioEnvSchema)
  .merge(assetEnvSchema)
  .merge(observabilityEnvSchema)
  .merge(reasoningEnvSchema)
  .extend({
    WORKER_HEALTH_HOST: z.string().min(1).default('0.0.0.0'),
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4100),
  })
  // M14: fails closed rather than silently falling back to the mock provider.
  .superRefine(refineReasoningConfig);
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const dashboardEnvSchema = baseEnvSchema.extend({
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  PORT: z.coerce.number().int().positive().default(3000),
});
export type DashboardEnv = z.infer<typeof dashboardEnvSchema>;

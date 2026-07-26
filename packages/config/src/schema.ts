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
  .extend({
    WORKER_HEALTH_HOST: z.string().min(1).default('0.0.0.0'),
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4100),
  })
  // M14: fails closed rather than silently falling back to the mock provider.
  .superRefine(refineReasoningConfig);
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

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

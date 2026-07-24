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
});

/**
 * `ANTHROPIC_API_KEY` is optional at the schema level because the default
 * `REASONING_PROVIDER` is `mock` — local dev and CI never require a real
 * key (CLAUDE.md: "Local development must work with zero paid API keys").
 * Whichever app wires up `@combat/providers`'s `createClaudeReasoningProvider`
 * must check `REASONING_PROVIDER === 'claude'` and fail fast if the key is
 * missing, rather than silently falling back to the mock in production.
 */
export const reasoningEnvSchema = z.object({
  REASONING_PROVIDER: z.enum(['mock', 'claude']).default('mock'),
  REASONING_MODEL: z.string().min(1).default('claude-opus-4-8'),
  ANTHROPIC_API_KEY: z.string().optional(),
});
export type ReasoningEnv = z.infer<typeof reasoningEnvSchema>;

export const observabilityEnvSchema = z.object({
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});

export const apiEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(temporalEnvSchema)
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
  .merge(observabilityEnvSchema)
  .merge(reasoningEnvSchema)
  .extend({
    WORKER_HEALTH_HOST: z.string().min(1).default('0.0.0.0'),
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4100),
  });
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const dashboardEnvSchema = baseEnvSchema.extend({
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  PORT: z.coerce.number().int().positive().default(3000),
});
export type DashboardEnv = z.infer<typeof dashboardEnvSchema>;

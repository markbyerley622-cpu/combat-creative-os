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

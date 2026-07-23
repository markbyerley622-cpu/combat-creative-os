import type { z } from 'zod';
import {
  apiEnvSchema,
  dashboardEnvSchema,
  workerEnvSchema,
  type ApiEnv,
  type DashboardEnv,
  type WorkerEnv,
} from './schema';

export class EnvValidationError extends Error {
  constructor(
    public readonly service: string,
    public readonly issues: string[],
  ) {
    super(
      `Invalid environment configuration for "${service}":\n` +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

function parseEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  service: string,
  env: NodeJS.ProcessEnv,
): z.infer<TSchema> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new EnvValidationError(service, issues);
  }
  return result.data;
}

export function loadApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  return parseEnv(apiEnvSchema, 'apps/api', env);
}

export function loadWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return parseEnv(workerEnvSchema, 'apps/worker', env);
}

export function loadDashboardEnv(env: NodeJS.ProcessEnv = process.env): DashboardEnv {
  return parseEnv(dashboardEnvSchema, 'apps/dashboard', env);
}

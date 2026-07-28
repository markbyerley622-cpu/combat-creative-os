import pino, { type Logger } from 'pino';

// Re-exported so consumers (apps/api, apps/worker) don't need a direct
// dependency on pino just to type-annotate a logger they got from us.
export type { Logger };

/**
 * M14 — the value substituted for anything matching a redacted path.
 * Deliberately visible rather than dropped, so a reader can tell the field was
 * present and withheld, not absent.
 */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Field names that must never reach a log sink, in any position.
 *
 * Two families:
 *
 * - **Credentials** — provider API keys, storage secrets, database URLs (which
 *   embed a password), bearer tokens and auth headers. A single accidental
 *   `logger.info({ config })` would otherwise print the whole set.
 * - **Model payloads** — prompts, agent inputs and attachments. These are not
 *   credentials, but they carry brand-confidential creative material and, for
 *   an attachment, potentially a signed URL. `AgentInvocation` rows are the
 *   audit trail for that content (hashed, workspace-scoped); the log is not.
 *
 * Correlation identifiers (`workspaceId`, `campaignId`, `workflowRunId`,
 * `correlationId`, `idempotencyKey`, `invocationId`) are deliberately NOT
 * redacted — they are the whole point of structured logging here, and none of
 * them is a secret.
 */
export const REDACTED_FIELD_NAMES: readonly string[] = [
  // Credentials and connection strings
  'apiKey',
  'api_key',
  'anthropicApiKey',
  'ANTHROPIC_API_KEY',
  'secret',
  'secretKey',
  'secretAccessKey',
  'accessKeyId',
  'clientSecret',
  'password',
  'passphrase',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'credential',
  'credentials',
  'privateKey',
  'connectionString',
  'databaseUrl',
  'DATABASE_URL',
  'MINIO_SECRET_KEY',
  'MINIO_ACCESS_KEY',
  'POSTGRES_PASSWORD',
  'LTXV_API_KEY',
  'ltxvApiKey',
  // Signed transfer URLs. Short-lived, but a signature in a log is a
  // credential in a log for as long as it lives.
  'upload_url',
  'uploadUrl',
  'video_url',
  'videoUrl',
  'storage_uri',
  'required_headers',
  // Model payloads (confidential creative material, not credentials)
  'prompt',
  'promptText',
  'systemPrompt',
  'attachments',
];

/**
 * Builds the pino `redact` path list. Each field is censored at the root, one
 * level deep, and two levels deep — enough to cover the shapes this codebase
 * actually logs (`{ err }`, `{ config }`, `{ input: { ... } }`) without the
 * cost of pino's unbounded `**` wildcard on every record.
 */
export function buildRedactPaths(fields: readonly string[] = REDACTED_FIELD_NAMES): string[] {
  return fields.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]);
}

export interface CreateLoggerOptions {
  serviceName: string;
  level?: string;
  pretty?: boolean;
  /** Extra field names to censor on top of `REDACTED_FIELD_NAMES`. */
  additionalRedactedFields?: readonly string[];
}

export function createLogger({
  serviceName,
  level = 'info',
  pretty = process.env.NODE_ENV !== 'production',
  additionalRedactedFields = [],
}: CreateLoggerOptions): Logger {
  return pino({
    name: serviceName,
    level,
    base: { service: serviceName },
    // M14: redaction is configured on the logger itself rather than left to
    // call sites, so a future `logger.error({ err })` that happens to carry a
    // provider credential is censored without that call site knowing to.
    redact: {
      paths: buildRedactPaths([...REDACTED_FIELD_NAMES, ...additionalRedactedFields]),
      censor: REDACTION_PLACEHOLDER,
    },
    transport: pretty
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
  });
}

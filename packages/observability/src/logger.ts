import pino, { type Logger } from 'pino';

// Re-exported so consumers (apps/api, apps/worker) don't need a direct
// dependency on pino just to type-annotate a logger they got from us.
export type { Logger };

export interface CreateLoggerOptions {
  serviceName: string;
  level?: string;
  pretty?: boolean;
}

export function createLogger({
  serviceName,
  level = 'info',
  pretty = process.env.NODE_ENV !== 'production',
}: CreateLoggerOptions): Logger {
  return pino({
    name: serviceName,
    level,
    base: { service: serviceName },
    transport: pretty
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
  });
}

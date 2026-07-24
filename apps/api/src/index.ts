import { loadApiEnv } from '@combat/config';
import { createLogger, initObservability } from '@combat/observability';
import { buildServer } from './server';

async function main(): Promise<void> {
  const env = loadApiEnv();
  const logger = createLogger({ serviceName: 'api', level: env.LOG_LEVEL });
  const observability = initObservability({
    serviceName: 'api',
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  const app = buildServer({
    logger,
    temporalEnv: {
      TEMPORAL_ADDRESS: env.TEMPORAL_ADDRESS,
      TEMPORAL_NAMESPACE: env.TEMPORAL_NAMESPACE,
    },
  });

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down apps/api');
    await app.close();
    await observability.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  logger.info(`apps/api listening on http://${env.API_HOST}:${env.API_PORT}`);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('apps/api failed to start:', error);
  process.exitCode = 1;
});

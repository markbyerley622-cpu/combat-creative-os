import { loadApiEnv, parseAuthorizedParties } from '@combat/config';
import { createClerkProfileDirectory, createClerkTokenVerifier } from '@combat/auth';
import { createLogger, initObservability } from '@combat/observability';
import { buildServer } from './server';

async function main(): Promise<void> {
  // AAMP-1 step 2: `loadApiEnv` refuses to return without a Clerk secret key,
  // so this process cannot reach `buildServer` unauthenticated. The key is read
  // only here, only through the validated schema, and is handed straight to the
  // adapter — it is never logged, echoed in a response, or stored on the app.
  const env = loadApiEnv();
  const logger = createLogger({ serviceName: 'api', level: env.LOG_LEVEL });
  const observability = initObservability({
    serviceName: 'api',
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  // `refineAuthConfig` has already rejected a missing key, so this branch is
  // unreachable — it exists to narrow the optional type honestly rather than
  // asserting non-null over a security control.
  if (!env.CLERK_SECRET_KEY) {
    throw new Error('CLERK_SECRET_KEY missing after env validation');
  }
  const clerkConfig = {
    secretKey: env.CLERK_SECRET_KEY,
    authorizedParties: parseAuthorizedParties(env.CLERK_AUTHORIZED_PARTIES),
  };

  const app = buildServer({
    logger,
    tokenVerifier: createClerkTokenVerifier(clerkConfig),
    profileDirectory: createClerkProfileDirectory(clerkConfig),
    temporalEnv: {
      TEMPORAL_ADDRESS: env.TEMPORAL_ADDRESS,
      TEMPORAL_NAMESPACE: env.TEMPORAL_NAMESPACE,
    },
    minioConfig: {
      endpoint: env.MINIO_ENDPOINT,
      port: env.MINIO_PORT,
      useSSL: env.MINIO_USE_SSL,
      accessKeyId: env.MINIO_ACCESS_KEY,
      secretAccessKey: env.MINIO_SECRET_KEY,
      bucket: env.MINIO_BUCKET,
      region: env.MINIO_REGION,
      forcePathStyle: env.MINIO_FORCE_PATH_STYLE,
    },
    assetLimits: {
      maxUploadBytes: env.ASSET_MAX_UPLOAD_BYTES,
      uploadUrlExpirySeconds: env.ASSET_UPLOAD_URL_EXPIRY_SECONDS,
      downloadUrlExpirySeconds: env.ASSET_DOWNLOAD_URL_EXPIRY_SECONDS,
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

import { Context } from '@temporalio/activity';
import { NativeConnection, Worker } from '@temporalio/worker';
import { loadWorkerEnv } from '@combat/config';
import { createLogger, initObservability } from '@combat/observability';
import { createWorkerActivities, type WorkerActivities } from '@combat/workflows';
import { createActivityDependencies } from './activity-dependencies';
import { startReadinessServer, type WorkerReadinessState } from './readiness-server';

const RECONNECT_DELAY_MS = 5_000;

async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger({ serviceName: 'worker', level: env.LOG_LEVEL });
  const observability = initObservability({
    serviceName: 'worker',
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  const state: WorkerReadinessState = {
    status: 'starting',
    temporal: 'connecting',
    taskQueue: env.TEMPORAL_TASK_QUEUE,
    startedAt: new Date().toISOString(),
  };

  // The readiness server comes up immediately and independently of Temporal
  // connectivity — "the process started" must be answerable even when
  // Temporal is unreachable (see readiness-server.ts).
  const readinessServer = startReadinessServer(
    env.WORKER_HEALTH_HOST,
    env.WORKER_HEALTH_PORT,
    () => state,
    logger,
  );

  // Built once, before Temporal is reachable, so a misconfigured dependency
  // fails startup loudly instead of surfacing as an unregistered-Activity
  // error on the first workflow task (post-M14 audit finding C-1).
  // `Context.current()` is only valid inside an executing Activity, which is
  // the only place these functions run — hence the lazy accessor.
  const { deps, prisma } = await createActivityDependencies({
    env,
    logger,
    getAttempt: () => Context.current().info.attempt,
  });
  const activities = createWorkerActivities(deps);
  logger.info(
    `Registered ${Object.keys(activities).length} activities: ${Object.keys(activities).sort().join(', ')}`,
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down apps/worker');
    readinessServer.close();
    await prisma.$disconnect();
    await observability.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await connectAndRunWithRetry(env, logger, state, activities, () => shuttingDown);
}

async function connectAndRunWithRetry(
  env: ReturnType<typeof loadWorkerEnv>,
  logger: ReturnType<typeof createLogger>,
  state: WorkerReadinessState,
  activities: WorkerActivities,
  isShuttingDown: () => boolean,
): Promise<void> {
  while (!isShuttingDown()) {
    state.temporal = 'connecting';
    try {
      const connection = await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS });
      state.temporal = 'connected';
      state.status = 'ready';
      logger.info(`Connected to Temporal at ${env.TEMPORAL_ADDRESS}`);

      const worker = await Worker.create({
        connection,
        namespace: env.TEMPORAL_NAMESPACE,
        taskQueue: env.TEMPORAL_TASK_QUEUE,
        workflowsPath: require.resolve('@combat/workflows/dist/workflows'),
        activities,
      });

      logger.info(`apps/worker polling task queue "${env.TEMPORAL_TASK_QUEUE}"`);
      await worker.run();
      state.temporal = 'disconnected';
      state.status = 'degraded';
    } catch (error) {
      state.temporal = 'disconnected';
      state.status = 'degraded';
      logger.warn(
        { err: error },
        `Temporal unreachable at ${env.TEMPORAL_ADDRESS} — retrying in ${RECONNECT_DELAY_MS}ms. ` +
          'This is expected if the local Docker infra (infrastructure/docker-compose.yml) is not running.',
      );
    }

    if (!isShuttingDown()) {
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('apps/worker failed to start:', error);
  process.exitCode = 1;
});

import { createServer, type Server } from 'node:http';
import type { Logger } from '@combat/observability';

export type TemporalConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface WorkerReadinessState {
  status: 'starting' | 'ready' | 'degraded';
  temporal: TemporalConnectionState;
  taskQueue: string;
  startedAt: string;
}

/**
 * Separate from Temporal connectivity on purpose: "the worker process is up
 * and can report its own state" must be true even when Temporal itself is
 * unreachable (e.g. this local sandbox, which has no Docker/Temporal server
 * running). Production liveness/readiness probes should point here.
 */
export function startReadinessServer(
  host: string,
  port: number,
  getState: () => WorkerReadinessState,
  logger: Logger,
): Server {
  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const state = getState();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, host, () => {
    logger.info(`apps/worker readiness endpoint listening on http://${host}:${port}/health`);
  });

  return server;
}

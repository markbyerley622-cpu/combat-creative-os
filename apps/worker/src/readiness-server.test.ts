import { describe, expect, it, afterEach } from 'vitest';
import { createLogger } from '@combat/observability';
import type { Server } from 'node:http';
import { startReadinessServer, type WorkerReadinessState } from './readiness-server';

const silentLogger = createLogger({ serviceName: 'worker-test', level: 'silent', pretty: false });
let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('startReadinessServer', () => {
  it('reports the current worker state as JSON', async () => {
    const state: WorkerReadinessState = {
      status: 'degraded',
      temporal: 'disconnected',
      taskQueue: 'combat-creative-os',
      startedAt: new Date().toISOString(),
    };
    server = startReadinessServer('127.0.0.1', 0, () => state, silentLogger);

    await new Promise((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('expected server to bind to a port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'degraded', temporal: 'disconnected' });
  });
});

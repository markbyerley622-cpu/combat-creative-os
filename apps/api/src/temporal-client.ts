import { Connection, WorkflowClient } from '@temporalio/client';

export interface TemporalEnv {
  TEMPORAL_ADDRESS: string;
  TEMPORAL_NAMESPACE: string;
}

/**
 * `Connection.lazy` (unlike `Connection.connect`) does not dial out — it
 * defers the actual gRPC connection to the first real call, mirroring
 * `createPrismaClient()`'s laziness (server.ts). That keeps `buildServer`
 * synchronous and means constructing this in a test or in a local dev
 * environment without Temporal running has no effect until a route actually
 * tries to signal a workflow.
 */
export function createWorkflowClient(env: TemporalEnv): WorkflowClient {
  const connection = Connection.lazy({ address: env.TEMPORAL_ADDRESS });
  return new WorkflowClient({ connection, namespace: env.TEMPORAL_NAMESPACE });
}

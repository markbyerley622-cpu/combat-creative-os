import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

export interface InitObservabilityOptions {
  serviceName: string;
  serviceVersion?: string;
  otlpEndpoint?: string;
}

export interface ObservabilityHandle {
  shutdown: () => Promise<void>;
}

/**
 * Starts the OTel SDK only when an OTLP endpoint is configured. Local
 * development runs with tracing disabled by default (no collector container
 * is part of the local infra) — set OTEL_EXPORTER_OTLP_ENDPOINT to enable it
 * against any OTLP-compatible backend.
 */
export function initObservability({
  serviceName,
  serviceVersion = '0.1.0',
  otlpEndpoint,
}: InitObservabilityOptions): ObservabilityHandle {
  if (!otlpEndpoint) {
    return { shutdown: async () => {} };
  }

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
    }),
    traceExporter: new OTLPTraceExporter({ url: otlpEndpoint }),
  });

  sdk.start();

  return {
    shutdown: () => sdk.shutdown(),
  };
}

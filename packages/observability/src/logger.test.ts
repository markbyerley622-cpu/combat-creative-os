import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

describe('createLogger', () => {
  it('creates a pino logger tagged with the service name', () => {
    const logger = createLogger({ serviceName: 'test-service', pretty: false });
    expect(logger.level).toBe('info');
    expect(logger.bindings().service).toBe('test-service');
  });

  it('respects an explicit log level', () => {
    const logger = createLogger({ serviceName: 'test-service', level: 'debug', pretty: false });
    expect(logger.level).toBe('debug');
  });
});

import { describe, expect, it } from 'vitest';

import {
  monitorComfyUIProgress,
  type ComfyUIProgressEvent,
  type ComfyUIWebSocketLike,
} from './progress-monitor';
import { toWebSocketUrl } from './http-client';

const PROMPT_ID = 'prompt-1';

/** A scripted socket: emits the given frames, then closes. */
class FakeSocket implements ComfyUIWebSocketLike {
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  closed = false;

  constructor(private readonly script: readonly (string | { close: true })[]) {
    // Deliver on the next tick so listeners are registered first.
    queueMicrotask(() => this.play());
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  private play(): void {
    for (const frame of this.script) {
      if (this.closed) return;
      if (typeof frame === 'string') this.emit('message', { data: frame });
      else this.emit('close', {});
    }
  }
}

const executing = (node: string | null): string =>
  JSON.stringify({ type: 'executing', data: { node, prompt_id: PROMPT_ID } });
const progress = (value: number, max: number): string =>
  JSON.stringify({ type: 'progress', data: { value, max, prompt_id: PROMPT_ID } });

async function run(
  scripts: readonly (readonly (string | { close: true })[])[],
  maxReconnects = 3,
): Promise<{ completed: boolean; events: ComfyUIProgressEvent[] }> {
  const events: ComfyUIProgressEvent[] = [];
  let attempt = 0;
  const completed = await monitorComfyUIProgress({
    baseUrl: 'http://127.0.0.1:8188',
    clientId: 'test-client',
    promptId: PROMPT_ID,
    webSocketFactory: () => new FakeSocket(scripts[attempt++] ?? [{ close: true }]),
    onEvent: (event) => events.push(event),
    maxReconnects,
    delay: async () => undefined,
  });
  return { completed, events };
}

describe('websocket progress monitoring', () => {
  it('reports sampling progress and completes on executing:null', async () => {
    const { completed, events } = await run([
      [executing('7'), progress(4, 8), progress(8, 8), executing(null)],
    ]);

    expect(completed).toBe(true);
    expect(events).toContainEqual({ kind: 'PROGRESS', value: 4, max: 8 });
    expect(events.at(-1)).toEqual({ kind: 'COMPLETED' });
  });

  it('ignores frames belonging to another prompt', async () => {
    const otherPrompt = JSON.stringify({
      type: 'executing',
      data: { node: null, prompt_id: 'someone-else' },
    });
    const { completed, events } = await run([[otherPrompt, { close: true }]], 0);

    expect(completed).toBe(false);
    expect(events.some((event) => event.kind === 'COMPLETED')).toBe(false);
  });

  it('ignores malformed frames instead of treating them as completion', async () => {
    const { completed } = await run([['not json at all', '{"no":"type"}', { close: true }]], 0);
    expect(completed).toBe(false);
  });

  it('reconnects after a dropped socket and completes on the retry', async () => {
    const { completed, events } = await run([[executing('7'), { close: true }], [executing(null)]]);

    expect(completed).toBe(true);
    expect(events).toContainEqual({ kind: 'RECONNECTING', attempt: 1 });
  });

  it('gives up after the reconnect budget without claiming failure of the job', async () => {
    const { completed, events } = await run([[{ close: true }], [{ close: true }]], 1);

    expect(completed).toBe(false);
    expect(events.filter((event) => event.kind === 'RECONNECTING')).toHaveLength(1);
  });

  it('stops on an execution error frame', async () => {
    const errorFrame = JSON.stringify({
      type: 'execution_error',
      data: { prompt_id: PROMPT_ID, exception_message: 'CUDA out of memory' },
    });
    const { completed, events } = await run([[errorFrame]], 0);

    expect(completed).toBe(false);
    expect(events).toContainEqual({ kind: 'ERROR', message: 'CUDA out of memory' });
  });

  it('does not fail when the socket factory itself throws', async () => {
    const completed = await monitorComfyUIProgress({
      baseUrl: 'http://127.0.0.1:8188',
      clientId: 'test-client',
      promptId: PROMPT_ID,
      webSocketFactory: () => {
        throw new Error('no websocket implementation');
      },
      onEvent: () => undefined,
      maxReconnects: 1,
      delay: async () => undefined,
    });
    expect(completed).toBe(false);
  });
});

describe('websocket url derivation', () => {
  it('maps http to ws and carries the client id', () => {
    expect(toWebSocketUrl('http://127.0.0.1:8188', 'abc')).toBe(
      'ws://127.0.0.1:8188/ws?clientId=abc',
    );
  });

  it('maps https to wss', () => {
    expect(toWebSocketUrl('https://comfy.example.com', 'abc')).toBe(
      'wss://comfy.example.com/ws?clientId=abc',
    );
  });
});

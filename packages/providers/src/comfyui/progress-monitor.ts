import {
  ComfyUIExecutingDataSchema,
  ComfyUIExecutionErrorDataSchema,
  ComfyUIProgressDataSchema,
  ComfyUIWebSocketMessageSchema,
} from './protocol';
import { toWebSocketUrl } from './http-client';

/**
 * Optional live progress over ComfyUI's websocket.
 *
 * Deliberately *optional*. The provider's own status machine polls `/history`
 * and `/queue`, because that is the only mechanism that survives a worker
 * restart — a socket cannot tell you about a job that was queued by a process
 * which no longer exists. This monitor exists for the operator-facing surface
 * (`pnpm aamp:generate` printing "sampling 14/30") where a 30-second poll
 * interval reads as a hang.
 *
 * It therefore never decides an outcome on its own. A dropped socket
 * reconnects; if reconnection is exhausted, the caller falls back to polling
 * rather than treating silence as failure.
 */

export interface ComfyUIWebSocketLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  close(): void;
}

export type ComfyUIWebSocketFactory = (url: string) => ComfyUIWebSocketLike;

export type ComfyUIProgressEvent =
  | { readonly kind: 'EXECUTING'; readonly nodeId: string | null }
  | { readonly kind: 'PROGRESS'; readonly value: number; readonly max: number }
  | { readonly kind: 'COMPLETED' }
  | { readonly kind: 'ERROR'; readonly message: string }
  | { readonly kind: 'RECONNECTING'; readonly attempt: number };

export interface ComfyUIProgressMonitorOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly promptId: string;
  readonly webSocketFactory: ComfyUIWebSocketFactory;
  readonly onEvent: (event: ComfyUIProgressEvent) => void;
  /** How many times a dropped socket is re-established before giving up. */
  readonly maxReconnects?: number;
  /** Injected so tests do not sleep for real. */
  readonly delay?: (ms: number) => Promise<void>;
  readonly reconnectDelayMs?: number;
}

function readMessageText(event: unknown): string | null {
  if (typeof event === 'string') return event;
  if (typeof event === 'object' && event !== null && 'data' in event) {
    const { data } = event as { data: unknown };
    if (typeof data === 'string') return data;
  }
  return null;
}

/**
 * Watches one prompt until it completes, errors, or reconnection is exhausted.
 *
 * Resolves `true` when ComfyUI signalled end-of-execution for this prompt
 * (`executing` with `node: null`, the condition ComfyUI's own reference client
 * breaks its loop on), and `false` when the socket gave up. It never rejects:
 * a monitoring failure is not a generation failure.
 */
export async function monitorComfyUIProgress(
  options: ComfyUIProgressMonitorOptions,
): Promise<boolean> {
  const maxReconnects = options.maxReconnects ?? 3;
  const delay = options.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  const url = toWebSocketUrl(options.baseUrl, options.clientId);

  for (let attempt = 0; attempt <= maxReconnects; attempt += 1) {
    if (attempt > 0) {
      options.onEvent({ kind: 'RECONNECTING', attempt });
      // eslint-disable-next-line no-await-in-loop -- backoff between reconnect attempts is inherently sequential
      await delay(reconnectDelayMs);
    }

    // eslint-disable-next-line no-await-in-loop -- each socket is watched to completion before the next attempt
    const outcome = await watchOnce(url, options);
    if (outcome !== 'DISCONNECTED') return outcome === 'COMPLETED';
  }
  return false;
}

type WatchOutcome = 'COMPLETED' | 'FAILED' | 'DISCONNECTED';

function watchOnce(url: string, options: ComfyUIProgressMonitorOptions): Promise<WatchOutcome> {
  return new Promise<WatchOutcome>((resolvePromise) => {
    let socket: ComfyUIWebSocketLike;
    try {
      socket = options.webSocketFactory(url);
    } catch {
      resolvePromise('DISCONNECTED');
      return;
    }

    let settled = false;
    const settle = (outcome: WatchOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // Closing an already-closed socket is not an error worth surfacing.
      }
      resolvePromise(outcome);
    };

    socket.addEventListener('message', (event: unknown) => {
      const text = readMessageText(event);
      // ComfyUI also sends binary preview frames; those are not JSON and are
      // simply not interesting here.
      if (text === null) return;

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        return;
      }
      const message = ComfyUIWebSocketMessageSchema.safeParse(parsedJson);
      if (!message.success) return;

      switch (message.data.type) {
        case 'executing': {
          const data = ComfyUIExecutingDataSchema.safeParse(message.data.data);
          if (!data.success) return;
          if (data.data.prompt_id !== undefined && data.data.prompt_id !== options.promptId) return;
          options.onEvent({ kind: 'EXECUTING', nodeId: data.data.node });
          if (data.data.node === null) {
            options.onEvent({ kind: 'COMPLETED' });
            settle('COMPLETED');
          }
          return;
        }
        case 'progress': {
          const data = ComfyUIProgressDataSchema.safeParse(message.data.data);
          if (!data.success) return;
          if (data.data.prompt_id !== undefined && data.data.prompt_id !== options.promptId) return;
          options.onEvent({ kind: 'PROGRESS', value: data.data.value, max: data.data.max });
          return;
        }
        case 'execution_error': {
          const data = ComfyUIExecutionErrorDataSchema.safeParse(message.data.data);
          if (!data.success) return;
          if (data.data.prompt_id !== undefined && data.data.prompt_id !== options.promptId) return;
          options.onEvent({
            kind: 'ERROR',
            message: data.data.exception_message ?? 'ComfyUI reported an execution error',
          });
          settle('FAILED');
          return;
        }
        default:
          return;
      }
    });

    socket.addEventListener('close', () => settle('DISCONNECTED'));
    socket.addEventListener('error', () => settle('DISCONNECTED'));
  });
}

import {
  ComfyUIErrorResponseSchema,
  ComfyUIHistoryResponseSchema,
  ComfyUIObjectInfoSchema,
  ComfyUIQueueResponseSchema,
  ComfyUIQueueStateSchema,
  ComfyUISystemStatsSchema,
  ComfyUIUploadResponseSchema,
  type ComfyUIHistoryEntry,
  type ComfyUIObjectInfo,
  type ComfyUIQueueResponse,
  type ComfyUIQueueState,
  type ComfyUISavedResult,
  type ComfyUISystemStats,
  type ComfyUIUploadResponse,
} from './protocol';

/**
 * The transport half of the ComfyUI adapter: one method per server route, each
 * one parsing its response through `protocol.ts` before returning.
 *
 * `fetch` is injected rather than reached for globally so the protocol tests
 * can drive the real client against a fake server (and so this file has no
 * hidden dependency on a Node version's global). Nothing here knows what a
 * shot or a campaign is — that lives in the provider above it.
 */

export const COMFYUI_FAILURE_KINDS = [
  /** The endpoint could not be reached at all — DNS, refused connection, TLS. */
  'UNREACHABLE',
  /** A request exceeded its deadline. */
  'TIMEOUT',
  /** ComfyUI answered, but rejected the request (400/422 — bad graph, missing model). */
  'REJECTED',
  /** ComfyUI answered with a server error (5xx). */
  'SERVER_ERROR',
  /** Authentication was refused (401/403). */
  'UNAUTHORIZED',
  /** ComfyUI answered with a body this client could not parse. */
  'MALFORMED_RESPONSE',
] as const;
export type ComfyUIFailureKind = (typeof COMFYUI_FAILURE_KINDS)[number];

export class ComfyUIRequestError extends Error {
  constructor(
    public readonly kind: ComfyUIFailureKind,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ComfyUIRequestError';
  }
}

export interface ComfyUIHttpClientOptions {
  /** Base URL of the ComfyUI server, e.g. `http://127.0.0.1:8188`. */
  readonly baseUrl: string;
  /** Per-request deadline. The end-to-end generation deadline is enforced above this. */
  readonly requestTimeoutMs: number;
  /** Sent as `Authorization: Bearer …` when the endpoint is behind a proxy that requires one. */
  readonly apiKey?: string;
  /** Injected so tests drive a fake server; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Rejects anything that is not a plain http(s) origin before it can become a
 * request. A `file:` or `data:` "base URL" would turn every route below into a
 * local-filesystem read, which is precisely the arbitrary-filesystem-access
 * the milestone forbids.
 */
export function normalizeComfyUIBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ComfyUIRequestError('REJECTED', `COMFYUI_BASE_URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ComfyUIRequestError(
      'REJECTED',
      `COMFYUI_BASE_URL must be http: or https:, got ${parsed.protocol}`,
    );
  }
  // Strip a trailing slash so route concatenation below stays unambiguous.
  return parsed.toString().replace(/\/$/, '');
}

/** The websocket origin for a given base URL — `http` becomes `ws`, `https` becomes `wss`. */
export function toWebSocketUrl(baseUrl: string, clientId: string): string {
  const url = new URL(`${normalizeComfyUIBaseUrl(baseUrl)}/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('clientId', clientId);
  return url.toString();
}

export class ComfyUIHttpClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ComfyUIHttpClientOptions) {
    this.baseUrl = normalizeComfyUIBaseUrl(options.baseUrl);
    this.requestTimeoutMs = options.requestTimeoutMs;
    if (options.apiKey) this.apiKey = options.apiKey;
    const injected = options.fetchImpl ?? globalThis.fetch;
    if (typeof injected !== 'function') {
      throw new ComfyUIRequestError(
        'UNREACHABLE',
        'No fetch implementation is available — pass fetchImpl explicitly on Node versions without a global fetch',
      );
    }
    this.fetchImpl = injected;
  }

  /** Queues one workflow graph. Returns ComfyUI's `prompt_id`. */
  async queuePrompt(
    graph: Record<string, unknown>,
    clientId: string,
    promptId?: string,
  ): Promise<ComfyUIQueueResponse> {
    const body: Record<string, unknown> = { prompt: graph, client_id: clientId };
    // Supplying our own prompt_id is what makes a retried submission land on
    // the same ComfyUI job instead of queueing a second identical render.
    if (promptId) body.prompt_id = promptId;

    const response = await this.request('POST', '/prompt', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
    const json = await this.readJson(response, '/prompt');

    if (!response.ok) {
      const parsedError = ComfyUIErrorResponseSchema.safeParse(json);
      const detail = parsedError.success
        ? typeof parsedError.data.error === 'string'
          ? parsedError.data.error
          : (parsedError.data.error.message ?? parsedError.data.error.type ?? 'unknown')
        : `HTTP ${response.status}`;
      throw new ComfyUIRequestError(
        this.classifyStatus(response.status),
        `ComfyUI rejected the workflow: ${detail}`,
        parsedError.success ? parsedError.data.node_errors : undefined,
      );
    }

    return this.parse(ComfyUIQueueResponseSchema, json, '/prompt');
  }

  /** Returns the history entry for one prompt id, or null while it is still queued/running. */
  async getHistoryEntry(promptId: string): Promise<ComfyUIHistoryEntry | null> {
    const response = await this.request('GET', `/history/${encodeURIComponent(promptId)}`);
    if (response.status === 404) return null;
    this.assertOk(response, '/history');
    const parsed = this.parse(
      ComfyUIHistoryResponseSchema,
      await this.readJson(response, '/history'),
      '/history',
    );
    return parsed[promptId] ?? null;
  }

  async getQueue(): Promise<ComfyUIQueueState> {
    const response = await this.request('GET', '/queue');
    this.assertOk(response, '/queue');
    return this.parse(ComfyUIQueueStateSchema, await this.readJson(response, '/queue'), '/queue');
  }

  /**
   * Downloads one saved artefact.
   *
   * The filename comes from ComfyUI and is treated strictly as an opaque query
   * parameter — it is URL-encoded into `/view` and never joined onto a local
   * path. Callers that persist these bytes choose their own destination
   * filename (see `ComfyUIVideoGenerationProvider`), so a server that returns
   * `../../etc/passwd` gets a harmless 404 rather than a path traversal.
   */
  async viewFile(saved: ComfyUISavedResult): Promise<Uint8Array> {
    const params = new URLSearchParams({
      filename: saved.filename,
      subfolder: saved.subfolder,
      type: saved.type,
    });
    const response = await this.request('GET', `/view?${params.toString()}`);
    this.assertOk(response, '/view');
    const buffer = await response.arrayBuffer().catch((error: unknown) => {
      throw new ComfyUIRequestError(
        'MALFORMED_RESPONSE',
        '/view returned an unreadable body',
        error,
      );
    });
    return new Uint8Array(buffer);
  }

  /** Asks ComfyUI to abort whatever it is currently executing. */
  async interrupt(): Promise<void> {
    const response = await this.request('POST', '/interrupt');
    this.assertOk(response, '/interrupt');
  }

  /** Removes a not-yet-started prompt from the pending queue. */
  async deleteQueued(promptId: string): Promise<void> {
    const response = await this.request('POST', '/queue', {
      body: JSON.stringify({ delete: [promptId] }),
      headers: { 'content-type': 'application/json' },
    });
    this.assertOk(response, '/queue');
  }

  /** The installed node catalogue — the basis for "is this profile actually runnable here?". */
  async getObjectInfo(): Promise<ComfyUIObjectInfo> {
    const response = await this.request('GET', '/object_info');
    this.assertOk(response, '/object_info');
    return this.parse(
      ComfyUIObjectInfoSchema,
      await this.readJson(response, '/object_info'),
      '/object_info',
    );
  }

  async getSystemStats(): Promise<ComfyUISystemStats> {
    const response = await this.request('GET', '/system_stats');
    this.assertOk(response, '/system_stats');
    return this.parse(
      ComfyUISystemStatsSchema,
      await this.readJson(response, '/system_stats'),
      '/system_stats',
    );
  }

  /**
   * Uploads a reference image into ComfyUI's `input` folder so a `LoadImage`
   * node can address it by name. `filename` is generated by the caller from a
   * checksum — never taken from user-supplied text — so nothing an agent or an
   * API client authored reaches the server's filesystem naming.
   */
  async uploadImage(
    bytes: Uint8Array,
    filename: string,
    contentType: string,
  ): Promise<ComfyUIUploadResponse> {
    const form = new FormData();
    // `Blob`/`FormData` are standard on Node 18+; using them keeps the
    // multipart encoding out of this file entirely.
    form.append('image', new Blob([bytes], { type: contentType }), filename);
    form.append('overwrite', 'true');

    const response = await this.request('POST', '/upload/image', { body: form });
    this.assertOk(response, '/upload/image');
    return this.parse(
      ComfyUIUploadResponseSchema,
      await this.readJson(response, '/upload/image'),
      '/upload/image',
    );
  }

  private async request(
    method: 'GET' | 'POST',
    route: string,
    // Narrower than the DOM's `BodyInit` on purpose — these are the only two
    // body shapes this client sends, and `BodyInit` is not in scope under a
    // Node-only lib configuration.
    init: { body?: string | FormData; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const headers: Record<string, string> = { ...init.headers };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    try {
      return await this.fetchImpl(`${this.baseUrl}${route}`, {
        method,
        ...(init.body === undefined ? {} : { body: init.body }),
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ComfyUIRequestError(
          'TIMEOUT',
          `ComfyUI ${method} ${route} exceeded ${this.requestTimeoutMs}ms`,
          error,
        );
      }
      throw new ComfyUIRequestError(
        'UNREACHABLE',
        `ComfyUI ${method} ${route} failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private classifyStatus(status: number): ComfyUIFailureKind {
    if (status === 401 || status === 403) return 'UNAUTHORIZED';
    if (status >= 500) return 'SERVER_ERROR';
    return 'REJECTED';
  }

  private assertOk(response: Response, route: string): void {
    if (response.ok) return;
    throw new ComfyUIRequestError(
      this.classifyStatus(response.status),
      `ComfyUI ${route} returned HTTP ${response.status}`,
    );
  }

  private async readJson(response: Response, route: string): Promise<unknown> {
    const text = await response.text().catch((error: unknown) => {
      throw new ComfyUIRequestError(
        'MALFORMED_RESPONSE',
        `ComfyUI ${route} returned an unreadable body`,
        error,
      );
    });
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ComfyUIRequestError(
        'MALFORMED_RESPONSE',
        `ComfyUI ${route} returned a non-JSON body`,
        error,
      );
    }
  }

  private parse<T>(
    schema: { safeParse: (v: unknown) => SafeParseResult<T> },
    value: unknown,
    route: string,
  ): T {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw new ComfyUIRequestError(
      'MALFORMED_RESPONSE',
      `ComfyUI ${route} returned an unexpected shape`,
      result.error,
    );
  }
}

type SafeParseResult<T> = { success: true; data: T } | { success: false; error: unknown };

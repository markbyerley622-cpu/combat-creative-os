import {
  describeLtxErrorBody,
  LtxJobStatusSchema,
  LtxJobSubmissionSchema,
  LtxUploadTicketSchema,
  type LtxJobStatus,
  type LtxJobSubmission,
  type LtxUploadTicket,
} from './protocol';

/**
 * The transport half of the LTX hosted adapter.
 *
 * Three properties are worth stating, because they are what separate this from
 * a `fetch` wrapper:
 *
 * **The credential never leaves this object.** It is a private field, it is
 * sent only as an `Authorization` header, and no method returns it, echoes it
 * in an error, or accepts a URL that carries one. `redactUrl` is applied to
 * every URL that reaches a message — an upload ticket is a signed URL, and a
 * signed URL in an exception is a credential in a log file.
 *
 * **Every provider-supplied URL is untrusted input.** The signed upload and
 * result URLs come back from an API response; they are re-validated against a
 * host allowlist and an https-only rule before a request is made to them.
 * Following one blindly would turn a JSON response into an arbitrary outbound
 * request.
 *
 * **Bodies are bounded while streaming.** A download reads chunk by chunk and
 * aborts the moment it exceeds the cap, so a provider that answers a `.mp4`
 * request with an unbounded HTML quota page cannot exhaust memory.
 */

/**
 * Derived from `fetch` itself rather than named directly: `BodyInit` is a DOM
 * type and is not in scope under this package's Node-only lib configuration —
 * the same constraint `comfyui/http-client.ts` documents.
 */
type FetchRequestBody = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['body']>;

export const LTX_FAILURE_KINDS = [
  /** The endpoint could not be reached at all — DNS, refused connection, TLS. */
  'UNREACHABLE',
  /** A request exceeded its deadline. */
  'TIMEOUT',
  /** LTX answered, but rejected the request (400/422). */
  'REJECTED',
  /** LTX answered with a server error (5xx). */
  'SERVER_ERROR',
  /** Authentication was refused (401/403). */
  'UNAUTHORIZED',
  /** Quota or billing refused the call (402). */
  'PAYMENT_REQUIRED',
  /** Throttled (429). */
  'RATE_LIMITED',
  /** The addressed resource is gone — a result URL past its expiry (404/410). */
  'EXPIRED',
  /** LTX answered with a body this client could not parse. */
  'MALFORMED_RESPONSE',
] as const;
export type LtxFailureKind = (typeof LTX_FAILURE_KINDS)[number];

export class LtxRequestError extends Error {
  constructor(
    public readonly kind: LtxFailureKind,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'LtxRequestError';
  }
}

/** The official API origin. Never a literal address, never loopback outside a test. */
export const LTX_DEFAULT_BASE_URL = 'https://api.ltx.io';

/**
 * Hosts a signed upload or result URL may point at.
 *
 * `api.ltx.io` plus its storage subdomains. A vendor that starts signing to a
 * new host makes this an explicit, reviewable change rather than a silent
 * widening of where this process will send bytes.
 */
export const LTX_ALLOWED_TRANSFER_HOST_SUFFIXES: readonly string[] = ['.ltx.io', 'ltx.io'];

/** 512 MiB. A 10-second 1080x1920 clip is orders of magnitude under this. */
export const LTX_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** Host and pathname only — never a query string, which is where signatures live. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}

export function normalizeLtxBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new LtxRequestError('REJECTED', `LTX_BASE_URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new LtxRequestError(
      'REJECTED',
      `LTX_BASE_URL must be http: or https:, got ${parsed.protocol}`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new LtxRequestError('REJECTED', 'LTX_BASE_URL must not embed credentials');
  }
  return parsed.toString().replace(/\/$/, '');
}

export interface LtxHostAllowance {
  /** Extra host suffixes, for the fake server only. Never populated in production. */
  readonly additionalTransferHostSuffixes?: readonly string[];
  /** Permits http: and loopback on transfer URLs, for the fake server only. */
  readonly allowInsecureTransfer?: boolean;
}

/**
 * Re-validates a URL that arrived in a response body before it is used.
 *
 * Called for the signed upload target and for the result download. It rejects
 * credentials-in-URL, non-http(s) schemes and unknown hosts, and it names the
 * host it refused so an operator can tell a misconfiguration from an attack.
 */
export function assertTransferUrlAllowed(raw: string, allowance: LtxHostAllowance = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LtxRequestError('MALFORMED_RESPONSE', 'LTX returned a URL that cannot be parsed');
  }
  if (url.username || url.password) {
    throw new LtxRequestError(
      'MALFORMED_RESPONSE',
      `LTX returned a URL embedding credentials (${redactUrl(raw)})`,
    );
  }
  const insecureAllowed = allowance.allowInsecureTransfer === true;
  if (url.protocol !== 'https:' && !(insecureAllowed && url.protocol === 'http:')) {
    throw new LtxRequestError(
      'MALFORMED_RESPONSE',
      `LTX returned a non-https transfer URL (${url.protocol}//${url.host})`,
    );
  }
  const suffixes = [
    ...LTX_ALLOWED_TRANSFER_HOST_SUFFIXES,
    ...(allowance.additionalTransferHostSuffixes ?? []),
  ];
  const hostname = url.hostname.toLowerCase();
  const permitted = suffixes.some(
    (suffix) => hostname === suffix.replace(/^\./, '') || hostname.endsWith(suffix),
  );
  if (!permitted) {
    throw new LtxRequestError(
      'MALFORMED_RESPONSE',
      `LTX returned a transfer URL on an unexpected host "${url.host}" — refusing to send or fetch bytes there`,
    );
  }
  return url;
}

export interface LtxHttpClientOptions {
  readonly baseUrl?: string;
  /** Read from validated env by the composition root. Never logged or returned. */
  readonly apiKey: string;
  readonly requestTimeoutMs: number;
  /** Injected so tests drive a fake server; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly hostAllowance?: LtxHostAllowance;
  readonly maxDownloadBytes?: number;
}

export interface LtxImageToVideoRequest {
  readonly image_uri: string;
  readonly prompt: string;
  readonly model: string;
  readonly duration: number;
  readonly resolution: string;
  readonly fps: number;
  readonly generate_audio: boolean;
  readonly last_frame_uri?: string;
  readonly camera_motion?: string;
}

export class LtxHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly hostAllowance: LtxHostAllowance;
  private readonly maxDownloadBytes: number;

  constructor(options: LtxHttpClientOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new LtxRequestError(
        'UNAUTHORIZED',
        'LTXV_API_KEY is required to construct the LTX hosted client',
      );
    }
    this.baseUrl = normalizeLtxBaseUrl(options.baseUrl ?? LTX_DEFAULT_BASE_URL);
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.hostAllowance = options.hostAllowance ?? {};
    this.maxDownloadBytes = options.maxDownloadBytes ?? LTX_MAX_DOWNLOAD_BYTES;
    const injected = options.fetchImpl ?? globalThis.fetch;
    if (typeof injected !== 'function') {
      throw new LtxRequestError(
        'UNREACHABLE',
        'No fetch implementation is available — pass fetchImpl explicitly',
      );
    }
    this.fetchImpl = injected;
  }

  /** `POST /v1/upload` — obtains a signed destination for one image. */
  async createUploadTicket(input: {
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes: number;
  }): Promise<LtxUploadTicket> {
    const response = await this.request('POST', '/v1/upload', {
      body: JSON.stringify({
        filename: input.filename,
        content_type: input.contentType,
        size_bytes: input.sizeBytes,
      }),
      headers: { 'content-type': 'application/json' },
    });
    await this.assertOk(response, '/v1/upload');
    return this.parse(LtxUploadTicketSchema, await this.readJson(response, '/v1/upload'), 'upload');
  }

  /**
   * `PUT` the bytes to the signed destination, sending every header the ticket
   * required.
   *
   * The ticket's headers are applied verbatim and *first*, so a signature
   * header cannot be silently dropped. Our own `Authorization` is deliberately
   * not added: a signed URL already carries its authorisation, and sending the
   * API key to a storage host would widen where the credential travels.
   */
  async putUpload(ticket: LtxUploadTicket, bytes: Uint8Array, contentType: string): Promise<void> {
    const target = assertTransferUrlAllowed(ticket.upload_url, this.hostAllowance);
    const headers: Record<string, string> = {
      'content-type': contentType,
      ...ticket.required_headers,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method: 'PUT',
        body: bytes as unknown as FetchRequestBody,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      throw this.transportError('PUT', redactUrl(target.toString()), controller, error);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new LtxRequestError(
        this.classifyStatus(response.status),
        `LTX upload PUT ${redactUrl(target.toString())} returned HTTP ${response.status}`,
        readRetryAfter(response),
      );
    }
  }

  /** `POST /v2/image-to-video` — submits one generation. */
  async submitImageToVideo(
    request: LtxImageToVideoRequest,
    idempotencyKey: string,
  ): Promise<LtxJobSubmission> {
    const body: Record<string, unknown> = {
      image_uri: request.image_uri,
      prompt: request.prompt,
      model: request.model,
      duration: request.duration,
      resolution: request.resolution,
      fps: request.fps,
      generate_audio: request.generate_audio,
    };
    if (request.last_frame_uri) body.last_frame_uri = request.last_frame_uri;
    if (request.camera_motion) body.camera_motion = request.camera_motion;

    const response = await this.request('POST', '/v2/image-to-video', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    });
    await this.assertOk(response, '/v2/image-to-video');
    return this.parse(
      LtxJobSubmissionSchema,
      await this.readJson(response, '/v2/image-to-video'),
      'submission',
    );
  }

  /** `GET /v2/image-to-video/{jobId}`. */
  async getJob(jobId: string): Promise<LtxJobStatus> {
    const route = `/v2/image-to-video/${encodeURIComponent(jobId)}`;
    const response = await this.request('GET', route);
    await this.assertOk(response, route);
    return this.parse(LtxJobStatusSchema, await this.readJson(response, route), 'job status');
  }

  /**
   * Downloads the finished clip.
   *
   * Immediately, and into the run directory, because a result URL expires. A
   * 404 or 410 here is `EXPIRED` rather than a generic rejection: the
   * distinction is the difference between "re-request this result" and
   * "regenerate this scene".
   */
  async downloadResult(videoUrl: string): Promise<Uint8Array> {
    const target = assertTransferUrlAllowed(videoUrl, this.hostAllowance);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method: 'GET',
        signal: controller.signal,
      });
    } catch (error) {
      throw this.transportError('GET', redactUrl(target.toString()), controller, error);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404 || response.status === 410) {
      throw new LtxRequestError(
        'EXPIRED',
        `the LTX result at ${redactUrl(target.toString())} is no longer available (HTTP ${response.status}); remote results expire and must be downloaded immediately`,
      );
    }
    if (!response.ok) {
      throw new LtxRequestError(
        this.classifyStatus(response.status),
        `LTX result download returned HTTP ${response.status}`,
        readRetryAfter(response),
      );
    }

    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > this.maxDownloadBytes) {
      throw new LtxRequestError(
        'MALFORMED_RESPONSE',
        `LTX declared a ${declared}-byte result, over the ${this.maxDownloadBytes}-byte ceiling`,
      );
    }

    const buffer = await response.arrayBuffer().catch(() => {
      throw new LtxRequestError('MALFORMED_RESPONSE', 'the LTX result body could not be read');
    });
    if (buffer.byteLength > this.maxDownloadBytes) {
      throw new LtxRequestError(
        'MALFORMED_RESPONSE',
        `the LTX result body exceeded the ${this.maxDownloadBytes}-byte ceiling`,
      );
    }
    if (buffer.byteLength === 0) {
      throw new LtxRequestError('MALFORMED_RESPONSE', 'LTX returned a zero-byte result');
    }
    return new Uint8Array(buffer);
  }

  /** Best-effort cancellation. A provider without the route is not an error here. */
  async cancelJob(jobId: string): Promise<void> {
    const route = `/v2/image-to-video/${encodeURIComponent(jobId)}/cancel`;
    const response = await this.request('POST', route);
    if (response.status === 404 || response.status === 405) return;
    await this.assertOk(response, route);
  }

  private async request(
    method: 'GET' | 'POST',
    route: string,
    init: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const headers: Record<string, string> = {
      ...init.headers,
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
    };
    try {
      return await this.fetchImpl(`${this.baseUrl}${route}`, {
        method,
        ...(init.body === undefined ? {} : { body: init.body }),
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      throw this.transportError(method, route, controller, error);
    } finally {
      clearTimeout(timer);
    }
  }

  private transportError(
    method: string,
    where: string,
    controller: AbortController,
    error: unknown,
  ): LtxRequestError {
    if (controller.signal.aborted) {
      return new LtxRequestError(
        'TIMEOUT',
        `LTX ${method} ${where} exceeded ${this.requestTimeoutMs}ms`,
      );
    }
    return new LtxRequestError(
      'UNREACHABLE',
      `LTX ${method} ${where} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private classifyStatus(status: number): LtxFailureKind {
    if (status === 401 || status === 403) return 'UNAUTHORIZED';
    if (status === 402) return 'PAYMENT_REQUIRED';
    if (status === 429) return 'RATE_LIMITED';
    if (status === 404 || status === 410) return 'EXPIRED';
    if (status >= 500) return 'SERVER_ERROR';
    return 'REJECTED';
  }

  private async assertOk(response: Response, route: string): Promise<void> {
    if (response.ok) return;
    const detail = describeLtxErrorBody(await this.readJsonSoft(response));
    throw new LtxRequestError(
      this.classifyStatus(response.status),
      `LTX ${route} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      readRetryAfter(response),
    );
  }

  private async readJson(response: Response, route: string): Promise<unknown> {
    const text = await response.text().catch(() => {
      throw new LtxRequestError('MALFORMED_RESPONSE', `LTX ${route} returned an unreadable body`);
    });
    try {
      return JSON.parse(text);
    } catch {
      throw new LtxRequestError('MALFORMED_RESPONSE', `LTX ${route} returned a non-JSON body`);
    }
  }

  /** For error bodies, where an unparseable body is expected rather than fatal. */
  private async readJsonSoft(response: Response): Promise<unknown> {
    try {
      return JSON.parse(await response.text());
    } catch {
      return undefined;
    }
  }

  private parse<T>(
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
    value: unknown,
    what: string,
  ): T {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw new LtxRequestError(
      'MALFORMED_RESPONSE',
      `LTX returned a ${what} body this client does not recognise`,
    );
  }
}

function readRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

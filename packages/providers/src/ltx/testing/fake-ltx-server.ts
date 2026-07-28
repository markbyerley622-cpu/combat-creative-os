/**
 * A deterministic in-process stand-in for api.ltx.io.
 *
 * It exists so every normal test can exercise the real client — the real
 * upload contract, the real poll loop, the real download and the real failure
 * mapping — while spending nothing and contacting no third party. It is **not**
 * evidence about the live API: `LTX_RESPONSE_CONTRACT_STATUS` stays
 * `DOCUMENTED_NOT_EXECUTED` until an opt-in live test says otherwise.
 *
 * Everything is driven by a script the test writes: how many polls a job spends
 * pending and processing, whether it fails, what HTTP status a given route
 * answers with. There is no timer and no randomness, so a test asserting "two
 * polls, then completed" asserts exactly that.
 */

export interface FakeLtxJobScript {
  /** Polls answered `pending` before the job starts processing. */
  readonly pendingPolls?: number;
  /** Polls answered `processing` before it reaches a terminal state. */
  readonly processingPolls?: number;
  /** The terminal state. Defaults to `completed`. */
  readonly terminal?: 'completed' | 'failed' | 'cancelled' | 'expired';
  readonly failureMessage?: string;
  /** Bytes the result URL serves. Defaults to a small deterministic payload. */
  readonly videoBytes?: Uint8Array;
  /** Answer the result download with this status instead of serving bytes. */
  readonly downloadStatus?: number;
  /** Never advance past processing, so the caller's deadline is what ends it. */
  readonly neverCompletes?: boolean;
}

export interface FakeLtxServerOptions {
  /** Status to answer `POST /v1/upload` with. Defaults to 200. */
  readonly uploadTicketStatus?: number;
  /** Status the signed PUT answers with. Defaults to 200. */
  readonly uploadPutStatus?: number;
  /** Status to answer `POST /v2/image-to-video` with. Defaults to 200. */
  readonly submitStatus?: number;
  /** Status to answer `GET /v2/image-to-video/{id}` with. Defaults to 200. */
  readonly statusStatus?: number;
  /** Return a body the client cannot parse, per route. */
  readonly malformed?: {
    readonly upload?: boolean;
    readonly submit?: boolean;
    readonly status?: boolean;
  };
  /** Per-job scripts, keyed by submission order (`job-1`, `job-2`, …). */
  readonly jobs?: Readonly<Record<string, FakeLtxJobScript>>;
  /** Applied to every job that has no explicit script. */
  readonly defaultJob?: FakeLtxJobScript;
  /** `Retry-After` seconds on a 429. */
  readonly retryAfterSeconds?: number;
  /** Host the signed upload and result URLs are issued on. */
  readonly transferHost?: string;
}

export interface FakeLtxRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly hasAuthorization: boolean;
  readonly headerNames: readonly string[];
  readonly body?: unknown;
}

const DEFAULT_TRANSFER_HOST = 'uploads.ltx.io';

/** Derived from the platform types — the DOM's `BodyInit`/`HeadersInit` are not in scope here. */
type ResponseBody = ConstructorParameters<typeof Response>[0];
type FetchHeaders = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['headers']>;

export class FakeLtxServer {
  readonly requests: FakeLtxRequestRecord[] = [];
  readonly uploadedBytes = new Map<string, Uint8Array>();
  /** Every `Authorization` value the server ever saw. Tests assert on presence, never content. */
  readonly authorizationSeenOn: string[] = [];

  private readonly options: FakeLtxServerOptions;
  private readonly pollCounts = new Map<string, number>();
  private submissionCount = 0;
  private cancelled = new Set<string>();

  constructor(options: FakeLtxServerOptions = {}) {
    this.options = options;
  }

  get submissions(): number {
    return this.submissionCount;
  }

  pollsFor(jobId: string): number {
    return this.pollCounts.get(jobId) ?? 0;
  }

  get transferHost(): string {
    return this.options.transferHost ?? DEFAULT_TRANSFER_HOST;
  }

  /** The `fetchImpl` to hand the client. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = normaliseHeaders(init?.headers);
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;

    this.requests.push({
      method,
      path: url.pathname,
      host: url.host,
      hasAuthorization: headers.authorization !== undefined,
      headerNames: Object.keys(headers).sort(),
      ...(bodyText ? { body: safeJson(bodyText) } : {}),
    });
    if (headers.authorization)
      this.authorizationSeenOn.push(`${method} ${url.host}${url.pathname}`);

    if (method === 'POST' && url.pathname === '/v1/upload') return this.handleUploadTicket();
    if (method === 'PUT' && url.pathname.startsWith('/signed-upload/')) {
      return this.handleUploadPut(url, init?.body, headers);
    }
    if (method === 'POST' && url.pathname === '/v2/image-to-video') return this.handleSubmit();
    if (method === 'POST' && /^\/v2\/image-to-video\/[^/]+\/cancel$/.test(url.pathname)) {
      this.cancelled.add(decodeURIComponent(url.pathname.split('/')[3] as string));
      return json({ ok: true }, 200);
    }
    if (method === 'GET' && /^\/v2\/image-to-video\/[^/]+$/.test(url.pathname)) {
      return this.handleStatus(decodeURIComponent(url.pathname.split('/').pop() as string));
    }
    if (method === 'GET' && url.pathname.startsWith('/signed-result/')) {
      return this.handleDownload(url);
    }
    return json({ error: 'not found' }, 404);
  };

  private handleUploadTicket(): Response {
    const status = this.options.uploadTicketStatus ?? 200;
    if (status !== 200) return this.errorFor(status);
    if (this.options.malformed?.upload) return json({ unexpected: true }, 200);
    const id = `upload-${this.requests.length}`;
    return json(
      {
        upload_url: `https://${this.transferHost}/signed-upload/${id}?signature=REDACTED-TEST-SIGNATURE`,
        storage_uri: `ltx://uploads/${id}`,
        expires_at: '2026-07-29T00:00:00.000Z',
        required_headers: { 'x-ltx-content-sha256': 'test-signature-header' },
      },
      200,
    );
  }

  private handleUploadPut(url: URL, body: unknown, headers: Record<string, string>): Response {
    const status = this.options.uploadPutStatus ?? 200;
    if (status !== 200) return this.errorFor(status);
    // The ticket's required header must have travelled with the bytes.
    if (headers['x-ltx-content-sha256'] === undefined) {
      return json({ error: 'required header missing' }, 400);
    }
    if (body instanceof Uint8Array) this.uploadedBytes.set(url.pathname, body);
    return new Response(null, { status: 200 });
  }

  private handleSubmit(): Response {
    const status = this.options.submitStatus ?? 200;
    if (status !== 200) return this.errorFor(status);
    if (this.options.malformed?.submit) return json({ nope: 1 }, 200);
    this.submissionCount += 1;
    return json({ id: `job-${this.submissionCount}`, status: 'pending' }, 200);
  }

  private handleStatus(jobId: string): Response {
    const status = this.options.statusStatus ?? 200;
    if (status !== 200) return this.errorFor(status);
    if (this.options.malformed?.status) return json({ id: jobId, status: 'wat' }, 200);

    if (this.cancelled.has(jobId)) return json({ id: jobId, status: 'cancelled' }, 200);

    const script = this.options.jobs?.[jobId] ?? this.options.defaultJob ?? {};
    const seen = (this.pollCounts.get(jobId) ?? 0) + 1;
    this.pollCounts.set(jobId, seen);

    const pending = script.pendingPolls ?? 0;
    const processing = script.processingPolls ?? 0;
    if (seen <= pending) return json({ id: jobId, status: 'pending' }, 200);
    if (script.neverCompletes || seen <= pending + processing) {
      return json({ id: jobId, status: 'processing', progress: 0.5 }, 200);
    }

    const terminal = script.terminal ?? 'completed';
    if (terminal === 'failed') {
      return json(
        { id: jobId, status: 'failed', error: script.failureMessage ?? 'the model refused' },
        200,
      );
    }
    if (terminal === 'cancelled') return json({ id: jobId, status: 'cancelled' }, 200);
    if (terminal === 'expired') return json({ id: jobId, status: 'expired' }, 200);

    return json(
      {
        id: jobId,
        status: 'completed',
        result: {
          video_url: `https://${this.transferHost}/signed-result/${jobId}?signature=REDACTED-TEST-SIGNATURE`,
          duration: 6,
          fps: 24,
          width: 1080,
          height: 1920,
        },
      },
      200,
    );
  }

  private handleDownload(url: URL): Response {
    const jobId = url.pathname.split('/').pop() as string;
    const script = this.options.jobs?.[jobId] ?? this.options.defaultJob ?? {};
    if (script.downloadStatus && script.downloadStatus !== 200) {
      return this.errorFor(script.downloadStatus);
    }
    const bytes = script.videoBytes ?? new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    return new Response(bytes as unknown as ResponseBody, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.byteLength) },
    });
  }

  private errorFor(status: number): Response {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (status === 429 && this.options.retryAfterSeconds !== undefined) {
      headers['retry-after'] = String(this.options.retryAfterSeconds);
    }
    return new Response(JSON.stringify({ error: { message: `fake LTX status ${status}` } }), {
      status,
      headers,
    });
  }
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function normaliseHeaders(raw: FetchHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(raw)) {
    for (const [key, value] of raw) out[String(key).toLowerCase()] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(raw)) out[key.toLowerCase()] = String(value);
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The host allowance a test hands the client so the fake's signed URLs resolve. */
export function fakeLtxHostAllowance(server: FakeLtxServer): {
  additionalTransferHostSuffixes: readonly string[];
  allowInsecureTransfer: boolean;
} {
  return { additionalTransferHostSuffixes: [server.transferHost], allowInsecureTransfer: false };
}

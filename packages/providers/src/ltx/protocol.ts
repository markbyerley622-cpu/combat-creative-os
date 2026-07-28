import { z } from 'zod';

/**
 * Every shape the LTX hosted API is allowed to answer with.
 *
 * Same discipline as `comfyui/protocol.ts`: a body this client does not expect
 * is a typed failure at the boundary, never an `undefined` read three call
 * frames later. The schemas are permissive about *extra* fields (a vendor may
 * add one at any time) and strict about the fields we act on.
 *
 * **These contracts are documented, not executed.** No live LTX endpoint has
 * been contacted from this repository, so `LTX_RESPONSE_CONTRACT_STATUS` says
 * `DOCUMENTED_NOT_EXECUTED` and stays that way until the opt-in live test
 * passes against the real API. The fake server in `testing/` exercises this
 * client; it is not evidence about api.ltx.io.
 */

export const LTX_RESPONSE_CONTRACT_STATUS = 'DOCUMENTED_NOT_EXECUTED' as const;

/**
 * The terminal and non-terminal states this client understands.
 *
 * Vendors spell the same state several ways over a product's life, so the
 * aliases are enumerated rather than pattern-matched — an unrecognised status
 * is a malformed response, which is the honest reading: we do not know whether
 * the job is still running or has already failed.
 */
export const LTX_JOB_STATES = [
  'pending',
  'queued',
  'processing',
  'running',
  'completed',
  'succeeded',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'expired',
] as const;
export type LtxJobState = (typeof LTX_JOB_STATES)[number];

export type LtxTerminalKind =
  'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

export function classifyLtxJobState(state: LtxJobState): LtxTerminalKind {
  switch (state) {
    case 'pending':
    case 'queued':
      return 'PENDING';
    case 'processing':
    case 'running':
      return 'PROCESSING';
    case 'completed':
    case 'succeeded':
      return 'COMPLETED';
    case 'failed':
    case 'error':
      return 'FAILED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    case 'expired':
      return 'EXPIRED';
  }
}

const NonEmpty = z.string().min(1);

/**
 * `POST /v1/upload`.
 *
 * `upload_url` is a signed, short-lived URL and `required_headers` may carry a
 * signature of its own. Neither is ever written to an artefact — see
 * `assertLtxArtefactSafe` above this layer.
 */
export const LtxUploadTicketSchema = z
  .object({
    upload_url: NonEmpty,
    storage_uri: NonEmpty,
    expires_at: NonEmpty,
    required_headers: z.record(z.string()).default({}),
  })
  .passthrough();
export type LtxUploadTicket = z.infer<typeof LtxUploadTicketSchema>;

/** The job identity `POST /v2/image-to-video` returns. */
export const LtxJobSubmissionSchema = z
  .object({
    id: NonEmpty,
    status: z.enum(LTX_JOB_STATES).optional(),
  })
  .passthrough();
export type LtxJobSubmission = z.infer<typeof LtxJobSubmissionSchema>;

export const LtxJobResultSchema = z
  .object({
    video_url: NonEmpty.optional(),
    duration: z.number().positive().optional(),
    fps: z.number().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    expires_at: z.string().optional(),
  })
  .passthrough();
export type LtxJobResult = z.infer<typeof LtxJobResultSchema>;

/** `GET /v2/image-to-video/{jobId}`. */
export const LtxJobStatusSchema = z
  .object({
    id: NonEmpty,
    status: z.enum(LTX_JOB_STATES),
    result: LtxJobResultSchema.nullish(),
    error: z
      .union([
        z.string(),
        z
          .object({ message: z.string().optional(), code: z.string().optional() })
          .passthrough()
          .transform((value) => value.message ?? value.code ?? 'the provider reported an error'),
      ])
      .nullish(),
    progress: z.number().min(0).max(1).nullish(),
  })
  .passthrough();
export type LtxJobStatus = z.infer<typeof LtxJobStatusSchema>;

/** Whatever an error body turns out to be, reduced to one sentence. */
export const LtxErrorBodySchema = z
  .object({
    error: z
      .union([z.string(), z.object({ message: z.string().optional() }).passthrough()])
      .optional(),
    message: z.string().optional(),
    detail: z.string().optional(),
  })
  .passthrough();

export function describeLtxErrorBody(value: unknown): string | undefined {
  const parsed = LtxErrorBodySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { error, message, detail } = parsed.data;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  if (message && message.trim().length > 0) return message;
  if (detail && detail.trim().length > 0) return detail;
  return undefined;
}
